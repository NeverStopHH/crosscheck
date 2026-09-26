/**
 * THE BACKGROUND FETCH, STARTED BY THE HOOKS, end to end through `runHook`
 * (docs/1.0/landed-changes.md, step 2).
 *
 * The failure it closes: Mike merged into staging an hour ago, Nick has not
 * run `git fetch` since, and the pre-edit stop — which asks Nick's own
 * clone — cannot see the change. Now session start, every prompt and every
 * edit may start a detached fetch of the landing branches, so the NEXT edit
 * sees what landed. An edit is a trigger too because an agent can work for an
 * hour on one prompt.
 *
 * Pinned here: each of the three hooks starts it; the hook books the attempt
 * before it returns and never waits for the network; the off switch leaves
 * no trace; and the whole point — after the fetch, the edit is stopped for
 * the change it brought.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import {
  SessionStateSchema,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import { landingFetchRecordPath } from "@crosscheck/connector-core/config/paths.ts";
import {
  cloneKeyOf,
  readLandingFetchRecord,
} from "@crosscheck/connector-core/landed-changes/fetch-state.ts";
import { makeHome } from "../../connector-core/test/helpers.ts";
import {
  gitIn,
  landWithMergeCommit,
  makeLandingRepos,
} from "../../connector-core/test/fixtures/landing-repos.ts";
import type { LandingRepos } from "../../connector-core/test/fixtures/landing-repos.ts";
import { startHintHub } from "../../connector-core/test/fixtures/hint-hub.ts";
import type { HintHub } from "../../connector-core/test/fixtures/hint-hub.ts";

const SESSION_ID = "landing-fetch-uuid";
const FILE = "src/lines.ts";
const DEAD_HUB_URL = "http://127.0.0.1:1";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const HEAVY_SETUP_MS = 60_000;
/** Long enough for a detached bun + a local fetch on a loaded CI runner. */
const POLL_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 50;

const paths: string[] = [];
const hubs: HintHub[] = [];

afterEach(async () => {
  for (const hub of hubs) {
    hub.stop();
  }
  hubs.length = 0;
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

interface Fixture {
  readonly repos: LandingRepos;
  readonly home: string;
  readonly env: Env;
}

const fixture = async (label: string, hubUrl?: string): Promise<Fixture> => {
  const repos = await makeLandingRepos(label);
  const home = await makeHome(label);
  paths.push(repos.base, home);
  const hub = startHintHub();
  hubs.push(hub);
  const identity = await resolveRepoIdentity(repos.reader);
  if (identity === null) {
    throw new Error("the reader clone has no repo identity");
  }
  const url = hubUrl ?? hub.url;
  await writeSessionState(
    home,
    SessionStateSchema.parse({
      hostSessionKey: SESSION_ID,
      crosscheckSessionId: `cc_${SESSION_ID}`,
      workContextId: `wc_cc_${SESSION_ID}`,
      repoId: identity.repoId,
      repoRoot: repos.reader,
      hubUrl: url,
      developerId: "dev_nick",
      startedAt: new Date().toISOString(),
    }),
  );
  return {
    repos,
    home,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: url,
      CROSSCHECK_API_KEY: "test-key",
      TZ: "Europe/Berlin",
      // The detached worker runs git with THIS environment, as it would
      // with the developer's.
      PATH: process.env["PATH"],
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  };
};

const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

/** Mike's change to FILE, merged into staging an hour ago — NOT fetched by Nick. */
const mikeLandsUnfetched = (repos: LandingRepos) =>
  landWithMergeCommit(repos, {
    file: FILE,
    content: "export const offset = 2;\n",
    subject: "Fix line offset",
    landing: "staging",
    writtenAt: iso(-HOUR_MS - DAY_MS),
    landedAt: iso(-HOUR_MS),
  });

const tipOf = (clone: string, ref: string): Promise<string> => gitIn(clone, ["rev-parse", ref]);

const originTip = (repos: LandingRepos, branch: string): Promise<string> =>
  gitIn(repos.origin, ["rev-parse", `refs/heads/${branch}`]);

/** Until the reader's remote-tracking ref shows origin's tip, or the deadline. */
const waitForFetched = async (repos: LandingRepos, branch: string): Promise<boolean> => {
  const target = await originTip(repos, branch);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await tipOf(repos.reader, `refs/remotes/origin/${branch}`)) === target) {
      return true;
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  return false;
};

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const recordPath = async (fix: Fixture): Promise<string> =>
  landingFetchRecordPath(fix.home, (await cloneKeyOf(fix.repos.reader)) ?? "");

let toolUse = 0;

const editPayload = (repo: string): string => {
  toolUse += 1;
  return JSON.stringify({
    session_id: SESSION_ID,
    cwd: repo,
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_use_id: `toolu_landing_fetch_${String(toolUse)}`,
    tool_input: { file_path: `${repo}/${FILE}` },
  });
};

const promptPayload = (repo: string): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd: repo,
    hook_event_name: "UserPromptSubmit",
    prompt: "tighten the line offset handling in src/lines.ts",
  });

const sessionStartPayload = (repo: string): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd: repo,
    hook_event_name: "SessionStart",
    source: "startup",
  });

interface HookOutput {
  readonly hookSpecificOutput?: {
    readonly permissionDecision?: string;
    readonly permissionDecisionReason?: string;
  };
}

const outputOf = (stdout: string): HookOutput["hookSpecificOutput"] =>
  stdout.length === 0 ? undefined : (JSON.parse(stdout) as HookOutput).hookSpecificOutput;

describe("the hooks start the background fetch", () => {
  test(
    "a prompt starts it, and the next edit is stopped for the change it brought",
    async () => {
      const fix = await fixture("lfh-prompt");
      await mikeLandsUnfetched(fix.repos);

      await runHook("user-prompt-submit", promptPayload(fix.repos.reader), fix.env);

      expect(await waitForFetched(fix.repos, "staging")).toBe(true);
      const stdout = await runHook("pre-tool-use", editPayload(fix.repos.reader), fix.env);
      const output = outputOf(stdout);
      expect(output?.permissionDecision).toBe("ask");
      expect(output?.permissionDecisionReason).toContain("«Fix line offset» by Mike, on staging");
    },
    HEAVY_SETUP_MS,
  );

  test(
    "an edit starts it too, for an agent that works for an hour on one prompt",
    async () => {
      const fix = await fixture("lfh-edit");
      await mikeLandsUnfetched(fix.repos);

      // The clone cannot know yet — and this edit is what sends for it.
      const first = await runHook("pre-tool-use", editPayload(fix.repos.reader), fix.env);
      expect(outputOf(first)?.permissionDecision).toBeUndefined();

      expect(await waitForFetched(fix.repos, "staging")).toBe(true);
      const second = await runHook("pre-tool-use", editPayload(fix.repos.reader), fix.env);
      expect(outputOf(second)?.permissionDecision).toBe("ask");
    },
    HEAVY_SETUP_MS,
  );

  test(
    "session start starts it, even when the hub does not answer",
    async () => {
      const fix = await fixture("lfh-session-start", DEAD_HUB_URL);
      await mikeLandsUnfetched(fix.repos);

      await runHook("session-start", sessionStartPayload(fix.repos.reader), fix.env);

      expect(await waitForFetched(fix.repos, "staging")).toBe(true);
    },
    HEAVY_SETUP_MS,
  );
});

describe("the hook stays out of the way", () => {
  test(
    "books the attempt before it returns, and never waits for the network",
    async () => {
      const fix = await fixture("lfh-no-wait");
      await gitIn(fix.repos.reader, ["remote", "set-url", "origin", "ssh://git@example.invalid/acme/api.git"]);
      const done = join(fix.repos.base, "slow-ssh.done");
      const slowSsh = join(fix.repos.base, "slow-ssh");
      await writeFile(slowSsh, `#!/bin/sh\nsleep 3\ntouch '${done}'\nexit 255\n`, "utf8");
      await chmod(slowSsh, 0o755);

      await runHook("user-prompt-submit", promptPayload(fix.repos.reader), {
        ...fix.env,
        GIT_SSH_COMMAND: slowSsh,
      });

      // Returned while ssh was still "connecting" — and already booked.
      expect(await exists(done)).toBe(false);
      expect((await readLandingFetchRecord(fix.home, (await cloneKeyOf(fix.repos.reader)) ?? "")).lastAttemptAt).not.toBeNull();
      // The worker carried on without it and recorded the failure.
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let failures = 0;
      while (failures === 0 && Date.now() < deadline) {
        await Bun.sleep(POLL_INTERVAL_MS);
        failures = (await readLandingFetchRecord(fix.home, (await cloneKeyOf(fix.repos.reader)) ?? "")).failuresInARow;
      }
      expect(failures).toBe(1);
      expect(await exists(done)).toBe(true);
    },
    HEAVY_SETUP_MS,
  );

  test(
    "switched off for one person: nothing is booked and nothing moves",
    async () => {
      const fix = await fixture("lfh-off");
      await mikeLandsUnfetched(fix.repos);
      const before = await tipOf(fix.repos.reader, "refs/remotes/origin/staging");

      await runHook("user-prompt-submit", promptPayload(fix.repos.reader), {
        ...fix.env,
        CROSSCHECK_LANDING_FETCH: "off",
      });
      await runHook("pre-tool-use", editPayload(fix.repos.reader), {
        ...fix.env,
        CROSSCHECK_LANDING_FETCH: "off",
      });

      // Booking happens BEFORE a hook returns, so its absence is final.
      expect(await exists(await recordPath(fix))).toBe(false);
      expect(await tipOf(fix.repos.reader, "refs/remotes/origin/staging")).toBe(before);
    },
    HEAVY_SETUP_MS,
  );

  test(
    "a clone that never fetched from origin is not fetched",
    async () => {
      const fix = await fixture("lfh-never-tracked");
      // origin names a remote this clone has never fetched from: nothing
      // under refs/remotes/origin. Fetching it would be the first contact —
      // with a URL that may be wrong, or not the team's at all.
      await gitIn(fix.repos.reader, ["remote", "remove", "origin"]);
      await gitIn(fix.repos.reader, ["remote", "add", "origin", fix.repos.origin]);

      await runHook("user-prompt-submit", promptPayload(fix.repos.reader), fix.env);

      expect(await exists(await recordPath(fix))).toBe(false);
      expect(
        await gitIn(fix.repos.reader, ["for-each-ref", "refs/remotes/origin"]),
      ).toBe("");
    },
    HEAVY_SETUP_MS,
  );
});
