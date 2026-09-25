/**
 * THE PRE-EDIT STOP FOR A TEAMMATE'S LANDED CHANGE, end to end through `runHook`.
 *
 * The failure it exists for (docs/1.0/landed-changes.md): Mike finished,
 * merged into staging and left. Nick, on a branch cut from main before that
 * merge, asks his agent to edit the same file. The live tripwire is silent —
 * nobody is active — and the two changes meet in review, or in production.
 *
 * Now the edit stops once, with the reason: which commits landed where, by
 * whom, and how to see them. The same single "ask" as the live tripwire and
 * the same `notice` knob for headless sessions; a once-per-file marker of its
 * own (one stop per file per reason, so it never uses up the live one); and
 * it does not depend on the hub answering, because the reader's own clone is
 * the authority on what it contains.
 *
 * Real clones throughout (connector-core fixtures/landing-repos.ts). The
 * hook reads the real clock, so dates here are relative to now.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import {
  SessionStateSchema,
  readSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import { makeHome } from "../../connector-core/test/helpers.ts";
import {
  NICK,
  gitIn,
  landWithMergeCommit,
  makeLandingRepos,
  readerFetches,
} from "../../connector-core/test/fixtures/landing-repos.ts";
import type { LandingRepos } from "../../connector-core/test/fixtures/landing-repos.ts";
import {
  activeTeammateSession,
  startHintHub,
} from "../../connector-core/test/fixtures/hint-hub.ts";
import type { HintHub } from "../../connector-core/test/fixtures/hint-hub.ts";

const SESSION_ID = "landed-change-uuid";
const FILE = "src/lines.ts";
const DEAD_HUB_URL = "http://127.0.0.1:1";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const paths: string[] = [];
const hubs: HintHub[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
  for (const hub of hubs) {
    hub.stop();
  }
  hubs.length = 0;
});

interface Fixture {
  readonly repos: LandingRepos;
  readonly home: string;
  readonly hub: HintHub;
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
    hub,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: url,
      CROSSCHECK_API_KEY: "test-key",
      TZ: "Europe/Berlin",
      // These tests pin the STOP against a clone the test fetches itself;
      // the background fetch moving refs mid-test would make them race it.
      // It is pinned in landing-fetch-hook.test.ts.
      CROSSCHECK_LANDING_FETCH: "off",
    },
  };
};

const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

/** Mike's change to FILE, merged into staging `landedAgoMs` ago. */
const mikeLands = (repos: LandingRepos, landedAgoMs: number) =>
  landWithMergeCommit(repos, {
    file: FILE,
    content: "export const offset = 2;\n",
    subject: "Fix line offset",
    landing: "staging",
    writtenAt: iso(-landedAgoMs - DAY_MS),
    landedAt: iso(-landedAgoMs),
  });

const editPayload = (repo: string, filePath: string): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd: repo,
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_use_id: "toolu_landed",
    tool_input: { file_path: `${repo}/${filePath}` },
  });

interface HookOutput {
  readonly hookSpecificOutput?: {
    readonly permissionDecision?: string;
    readonly permissionDecisionReason?: string;
    readonly additionalContext?: string;
  };
}

const outputOf = (stdout: string): HookOutput["hookSpecificOutput"] =>
  stdout.length === 0 ? undefined : (JSON.parse(stdout) as HookOutput).hookSpecificOutput;

describe("a teammate's landed change the checkout does not contain", () => {
  test("stops the edit once, naming the commit, its author and where it landed", async () => {
    // Arrange — merged into staging months ago; Nick's branch never got it
    const { repos, home, env } = await fixture("missing");
    await mikeLands(repos, 90 * DAY_MS);
    await readerFetches(repos);

    // Act
    const stdout = await runHook("pre-tool-use", editPayload(repos.reader, FILE), env);

    // Assert
    const output = outputOf(stdout);
    expect(output?.permissionDecision).toBe("ask");
    expect(output?.permissionDecisionReason).toContain("has landed changes your checkout does not contain");
    expect(output?.permissionDecisionReason).toContain("«Fix line offset» by Mike, on staging");
    expect(output?.additionalContext).toBe(output?.permissionDecisionReason);
    // Its own marker: the live one stays free for a teammate who starts later
    const state = await readSessionState(home, SESSION_ID);
    expect(state?.landedAskedFiles).toContain(FILE);
    expect(state?.tripwireAskedFiles).not.toContain(FILE);
  });

  test("never stops the same file twice in one session", async () => {
    // Arrange — and the first edit DID stop, or the second's silence proves nothing
    const { repos, env } = await fixture("once");
    await mikeLands(repos, 90 * DAY_MS);
    await readerFetches(repos);
    const first = await runHook("pre-tool-use", editPayload(repos.reader, FILE), env);
    expect(outputOf(first)?.permissionDecision).toBe("ask");

    // Act
    const second = await runHook("pre-tool-use", editPayload(repos.reader, FILE), env);

    // Assert
    expect(second).toBe("");
  });

  test("is not held hostage by the hub: a dead hub still gets the stop", async () => {
    // Arrange — the reader's clone is the authority on what it contains
    const { repos, env } = await fixture("dead-hub", DEAD_HUB_URL);
    await mikeLands(repos, 90 * DAY_MS);
    await readerFetches(repos);

    // Act
    const stdout = await runHook("pre-tool-use", editPayload(repos.reader, FILE), env);

    // Assert
    expect(outputOf(stdout)?.permissionDecision).toBe("ask");
  });

  test("in notice mode it briefs the model and blocks nothing", async () => {
    // Arrange
    const { repos, env } = await fixture("notice");
    await mikeLands(repos, 90 * DAY_MS);
    await readerFetches(repos);

    // Act
    const stdout = await runHook("pre-tool-use", editPayload(repos.reader, FILE), {
      ...env,
      CROSSCHECK_TRIPWIRE: "notice",
    });

    // Assert
    const output = outputOf(stdout);
    expect(output?.additionalContext).toContain("Fix line offset");
    expect(output?.permissionDecision).toBeUndefined();
  });

  test("a teammate who starts on the file later still gets their one stop", async () => {
    // Arrange — stopped once for the landed change, before anyone was active
    const { repos, hub, env } = await fixture("live-later");
    await mikeLands(repos, 90 * DAY_MS);
    await readerFetches(repos);
    await runHook("pre-tool-use", editPayload(repos.reader, FILE), env);
    hub.setTripwireSessions([activeTeammateSession()]);

    // Act
    const second = await runHook("pre-tool-use", editPayload(repos.reader, FILE), env);
    const third = await runHook("pre-tool-use", editPayload(repos.reader, FILE), env);

    // Assert — the live reason is new, so it is said once; the landed one is not repeated
    const reason = outputOf(second)?.permissionDecisionReason ?? "";
    expect(reason).toContain("has an active session");
    expect(reason).not.toContain("has landed changes");
    expect(third).toBe("");
  });

  test("with a live teammate session on the same file, it is ONE stop that says both", async () => {
    // Arrange
    const { repos, hub, env } = await fixture("both");
    hub.setTripwireSessions([activeTeammateSession()]);
    await mikeLands(repos, 90 * DAY_MS);
    await readerFetches(repos);

    // Act
    const stdout = await runHook("pre-tool-use", editPayload(repos.reader, FILE), env);

    // Assert
    const reason = outputOf(stdout)?.permissionDecisionReason ?? "";
    expect(reason).toContain("has an active session");
    expect(reason).toContain("has landed changes your checkout does not contain");
  });
});

describe("a teammate's landed change the checkout already has", () => {
  test("stops the edit when it landed in the last two working days", async () => {
    // Arrange — landed two hours ago, and Nick has merged staging since
    const { repos, env } = await fixture("recent");
    await mikeLands(repos, 2 * HOUR_MS);
    await readerFetches(repos);
    await gitIn(repos.reader, ["merge", "-q", "--no-edit", "origin/staging"], { as: NICK });

    // Act
    const stdout = await runHook("pre-tool-use", editPayload(repos.reader, FILE), env);

    // Assert
    expect(outputOf(stdout)?.permissionDecisionReason).toContain("your checkout has it");
  });

  test("stays silent once it is older than that", async () => {
    // Arrange — landed five calendar days ago, which always spans at least
    // three working days
    const { repos, home, env } = await fixture("stale");
    await mikeLands(repos, 5 * DAY_MS);
    await readerFetches(repos);
    await gitIn(repos.reader, ["merge", "-q", "--no-edit", "origin/staging"], { as: NICK });

    // Act
    const stdout = await runHook("pre-tool-use", editPayload(repos.reader, FILE), env);

    // Assert — silent, AND the probe really answered "nothing": its key is
    // remembered, which a timeout or a git error would not leave behind
    expect(stdout).toBe("");
    expect((await readSessionState(home, SESSION_ID))?.landedCleanKeys).toHaveLength(1);
  });

  test("remembers a clean answer once, so the next edit does not walk again", async () => {
    // Arrange — nothing landed on the file at all
    const { repos, home, env } = await fixture("clean-cache");

    // Act
    await runHook("pre-tool-use", editPayload(repos.reader, FILE), env);
    await runHook("pre-tool-use", editPayload(repos.reader, FILE), env);

    // Assert — one key for one state of the repo, not one per edit
    expect((await readSessionState(home, SESSION_ID))?.landedCleanKeys).toHaveLength(1);
  });
});
