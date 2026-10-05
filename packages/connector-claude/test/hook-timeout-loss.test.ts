/**
 * LOSS-12, first half (docs/1.0/loss-accounting.md §3 row 14, §4.3): a hook
 * that runs out of budget is a COUNTED loss, keyed when it can be.
 *
 * The race used to resolve to "" and the binary exited on that string
 * (cli/src/bin/crosscheck.ts emitAndExit), abandoning whatever the handler had
 * not yet written — PostToolUse's targets, Stop's git lane — with nothing
 * counted anywhere. Driven through the REAL runner (`runHookWith`), with a
 * handler that never settles, so the only thing that can end the hook is the
 * budget itself.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repoKey } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { runHookWith } from "../src/hooks/runner.ts";
import {
  lossLedgerPath,
  readCaptureLosses,
} from "@crosscheck/connector-core/state/loss-ledger.ts";
import {
  deriveSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const HUB_URL = "http://127.0.0.1:1";
/**
 * PostToolUse's budget is POST_TOOL_USE_BUDGET_RATIO (4) × this: one second,
 * room enough for repo identity to resolve under a loaded machine, so the
 * handler — not the git spawns before it — is what the budget cuts.
 */
const RESOLVING_TIMEOUT_MS = "250";
/**
 * 4 ms of budget: less than one git spawn, and repo identity spawns several
 * (hooks/runner.ts prepareHook), so the race resolves BEFORE the hook knows
 * its repo — the unkeyed shape of the same loss.
 */
const UNRESOLVED_TIMEOUT_MS = "1";

const paths: string[] = [];

/** Long enough that no budget in this file can wait out a single git spawn. */
const SLOW_GIT_SECONDS = 1;

/**
 * Runs `run` with a `git` first on PATH that answers only after
 * SLOW_GIT_SECONDS. The unkeyed shape needs the budget to win the race
 * against repo identity on ANY machine: a 4 ms budget alone lost that race on
 * a fast CI runner, where repo identity resolved in time and the line came
 * back keyed. Spawns inherit process.env (git/git.ts), so PATH is swapped for
 * this one call and restored whatever happens.
 */
const withSlowGit = async <T>(run: () => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-slow-git-"));
  paths.push(dir);
  const realGit = Bun.which("git");
  if (realGit === null) {
    throw new Error("git is not on PATH");
  }
  await writeFile(
    join(dir, "git"),
    `#!/bin/sh\nsleep ${String(SLOW_GIT_SECONDS)}\nexec "${realGit}" "$@"\n`,
    { mode: 0o755 },
  );
  const saved = process.env["PATH"];
  process.env["PATH"] = `${dir}:${saved ?? ""}`;
  try {
    return await run();
  } finally {
    process.env["PATH"] = saved;
  }
};

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const fixture = async (
  label: string,
  timeoutMs: string,
): Promise<{ readonly repo: string; readonly home: string; readonly env: Env }> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  return {
    repo,
    home,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: HUB_URL,
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_TIMEOUT_MS: timeoutMs,
      CROSSCHECK_SSH_CANONICALIZE: "off",
    },
  };
};

const editPayload = (repo: string): string =>
  JSON.stringify({
    session_id: "timeout-loss-uuid",
    cwd: repo,
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: join(repo, "src/limiter.ts") },
    tool_response: {},
  });

const neverSettles = (): Promise<string> => new Promise<string>(() => {});

const ledgerLines = async (home: string): Promise<readonly Record<string, unknown>[]> => {
  const raw = await Bun.file(lossLedgerPath(home)).text();
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

describe("LOSS-12: a hook that runs out of budget is a counted loss, keyed when it can be", () => {
  test("a PostToolUse whose handler outlives its budget appends hook_timed_out under its repo", async () => {
    // Arrange
    const { repo, home, env } = await fixture("timeout-keyed", RESOLVING_TIMEOUT_MS);
    const key = repoKey(HUB_URL, REPO_ID);

    // Act
    const output = await runHookWith("post-tool-use", neverSettles, editPayload(repo), env);

    // Assert: still the silent no-op on the wire, and now a ledger line
    expect(output).toBe("");
    const losses = await readCaptureLosses(home, key);
    expect(losses.byKind["hook_timed_out"]).toBe(1);
    expect(losses.byDetail["hook_timed_out:post-tool-use"]).toBe(1);
    const [line] = await ledgerLines(home);
    expect(line?.["key"]).toBe(key);
  });

  test("a hook the budget cut before its repo resolved is booked with no key, charged to every repo", async () => {
    // Arrange
    const { repo, home, env } = await fixture("timeout-unkeyed", UNRESOLVED_TIMEOUT_MS);

    // Act: git cannot answer inside the budget, so repo identity never lands
    await withSlowGit(() => runHookWith("post-tool-use", neverSettles, editPayload(repo), env));

    // Assert
    const [line] = await ledgerLines(home);
    expect(line?.["kind"]).toBe("hook_timed_out");
    expect(line?.["key"]).toBeNull();
    expect((await readCaptureLosses(home, "any-other-repo-key")).total).toBe(1);
  });

  test.each(["pre-tool-use", "user-prompt-submit", "session-end"] as const)(
    "review M4: %s timing out books nothing — it captures nothing a coverage question rests on",
    async (hook) => {
      // Arrange
      const { repo, home, env } = await fixture(`timeout-${hook}`, RESOLVING_TIMEOUT_MS);

      // Act
      await runHookWith(hook, neverSettles, editPayload(repo), env);

      // Assert
      expect(await Bun.file(lossLedgerPath(home)).exists()).toBe(false);
    },
  );

  test("review M4: a capture hook cut in a directory no connected repo owns books nothing", async () => {
    // Arrange: a plain directory, no .git anywhere above it
    const { home, env } = await fixture("timeout-unconnected", UNRESOLVED_TIMEOUT_MS);
    const outside = await makeHome("timeout-outside");
    paths.push(outside);

    // Act: git cannot answer inside the budget, so the hook is really CUT —
    // on a fast machine a plain directory resolved in time and nothing was cut
    await withSlowGit(() => runHookWith("post-tool-use", neverSettles, editPayload(outside), env));

    // Assert: no connected repo could have lost this hook's capture
    expect(await Bun.file(lossLedgerPath(home)).exists()).toBe(false);
  });

  test("review M4: a hook cut before identity, in a session already registered, is booked to that session's repo", async () => {
    // Arrange: the state file an earlier hook of this session wrote
    const { repo, home, env } = await fixture("timeout-state-keyed", UNRESOLVED_TIMEOUT_MS);
    await writeSessionState(
      home,
      deriveSessionState({
        hostSessionKey: "timeout-loss-uuid",
        repoId: REPO_ID,
        repoRoot: repo,
        hubUrl: HUB_URL,
        developerId: null,
        startedAt: new Date().toISOString(),
      }),
    );

    // Act: cut before identity on any machine, so the state file is what keys it
    await withSlowGit(() => runHookWith("post-tool-use", neverSettles, editPayload(repo), env));

    // Assert: keyed — no other repo on the machine is charged
    const [line] = await ledgerLines(home);
    expect(line?.["key"]).toBe(repoKey(HUB_URL, REPO_ID));
  });

  test("a hook that finishes inside its budget books nothing", async () => {
    // Arrange
    const { repo, home, env } = await fixture("timeout-none", RESOLVING_TIMEOUT_MS);

    // Act
    const output = await runHookWith(
      "post-tool-use",
      () => Promise.resolve("done"),
      editPayload(repo),
      env,
    );

    // Assert
    expect(output).toBe("done");
    expect((await readCaptureLosses(home, repoKey(HUB_URL, REPO_ID))).total).toBe(0);
  });
});
