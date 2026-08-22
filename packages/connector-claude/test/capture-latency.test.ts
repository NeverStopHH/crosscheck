/**
 * The #17 worktree resolution measured through the real `runHook`, the other
 * half of the split test/hook-time-budget.test.ts uses: the per-tool capture
 * cost must fit the PostToolUse budget WITH ROOM even on the first touch of a
 * new worktree root (the one git-bearing case), and a warm cache must add
 * nothing measurable — that is what the per-session root cache buys, and the
 * reason the identity resolution is not paid per tool call.
 *
 * Elapsed times are printed so a slow run is a number in the log, not a guess.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSpoolLines, repoKey, runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import {
  HTTP_TIMEOUT_MS,
  POST_TOOL_USE_BUDGET_RATIO,
  PRE_TOOL_USE_BUDGET_RATIO,
} from "@crosscheck/connector-core/constants.ts";
import { writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { git, makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const SESSION_ID = "capture-latency-uuid";
const DEAD_HUB_URL = "http://127.0.0.1:1";
const BUDGET_MS = POST_TOOL_USE_BUDGET_RATIO * HTTP_TIMEOUT_MS;
const PRE_BUDGET_MS = PRE_TOOL_USE_BUDGET_RATIO * HTTP_TIMEOUT_MS;
/** Headroom the warm path must clear the budget by: capture is fs + spool. */
const WARM_HEADROOM_MS = 400;

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const sessionState = (repoRoot: string): SessionState => ({
  hostSessionKey: SESSION_ID,
  crosscheckSessionId: `cc_${SESSION_ID}`,
  workContextId: `wc_cc_${SESSION_ID}`,
  repoId: REPO_ID,
  repoRoot,
  hubUrl: DEAD_HUB_URL,
  developerId: "dev_self",
  startedAt: new Date().toISOString(),
  lastHeartbeatAt: null,
  seenTargets: [],
  deliveredHintRefs: [],
  deliveredHintHashes: [],
  tripwireAskedFiles: [],
  briefingSolvedRefs: [],
  foreignRepoDrops: 0,
  outsideRootDrops: 0,
  knownWorktreeRoots: [],
  editToolFires: 0,
  targetsCapturedCount: 0,
  lastTargetAt: null,
  lastPostToolUseTool: null,
  lastEditedPath: null,
  lastEditedPathResolvedAgainst: null,
  hintCandidatesSeen: 0,
  briefingPending: false,
  stopTurnCount: 0,
  summarizerFireCount: 0,
  summarizerLastFireTurn: null,
  summarizerEstimatedTokens: 0,
  summarizerNoneCount: 0,
  summarizerDraftCount: 0,
  summarizerFailCount: 0,
  summarizerLastFailure: null,
});

const env = (home: string): Env => ({
  CROSSCHECK_HOME: home,
  CROSSCHECK_HUB_URL: DEAD_HUB_URL,
  CROSSCHECK_API_KEY: "test-key",
  CROSSCHECK_TIMEOUT_MS: String(HTTP_TIMEOUT_MS),
  CROSSCHECK_SSH_CANONICALIZE: "off",
});

const editPayload = (cwd: string, worktree: string, file: string): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd,
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: join(worktree, file) },
    tool_response: {},
  });

describe("the per-tool worktree resolution fits the PostToolUse budget", () => {
  test("cold first-touch and warm cache both clear the budget with room", async () => {
    // Arrange: repo A with a committed config, one linked worktree B
    const main = await makeRepo("caplat", { remote: "git@github.com:acme/api.git" });
    await writeFile(
      join(main, ".crosscheck.json"),
      `${JSON.stringify({ hubUrl: DEAD_HUB_URL }, null, 2)}\n`,
      "utf8",
    );
    await git(main, ["add", "."]);
    await git(main, ["commit", "-m", "config"]);
    const worktree = join(await mkdtemp(join(tmpdir(), "cx-caplat-wt-")), "feature");
    await git(main, ["worktree", "add", worktree, "HEAD"]);
    const home = await makeHome("caplat");
    paths.push(main, join(worktree, ".."), home);
    await writeRepoFile(worktree, "src/one.ts", "export const a = 1;\n");
    await writeRepoFile(worktree, "src/two.ts", "export const b = 2;\n");
    await writeSessionState(home, sessionState(main));

    // Act: first touch of the worktree root resolves identity (cold); the
    // second touch of the SAME root reads the cache (warm).
    const coldStart = performance.now();
    await runHook("post-tool-use", editPayload(main, worktree, "src/one.ts"), env(home));
    const coldMs = Math.round(performance.now() - coldStart);

    const warmStart = performance.now();
    await runHook("post-tool-use", editPayload(main, worktree, "src/two.ts"), env(home));
    const warmMs = Math.round(performance.now() - warmStart);

    // Assert: both under budget; the warm path far under it (no git)
    console.log(
      `[capture-latency] cold ${String(coldMs)} ms, warm ${String(warmMs)} ms (budget ${String(BUDGET_MS)})`,
    );
    const targets = (await readSpoolLines(home, repoKey(DEAD_HUB_URL, REPO_ID)))
      .map((line) => JSON.parse(line) as { kind: string; body?: { value?: string } })
      .filter((record) => record.kind === "target")
      .map((record) => record.body?.value ?? "");
    expect(targets).toEqual(["src/one.ts", "src/two.ts"]);
    expect(coldMs).toBeLessThan(BUDGET_MS);
    expect(warmMs).toBeLessThan(BUDGET_MS - WARM_HEADROOM_MS);
  });

  test("the PreToolUse tripwire path clears its tighter budget cold and warm", async () => {
    // Arrange: same shape — the tripwire resolves the edited file's root the
    // same way (and persists the cache), under the 800 ms PreToolUse budget
    // that already contains the runner's own identity resolution.
    const main = await makeRepo("prelat", { remote: "git@github.com:acme/api.git" });
    await writeFile(
      join(main, ".crosscheck.json"),
      `${JSON.stringify({ hubUrl: DEAD_HUB_URL }, null, 2)}\n`,
      "utf8",
    );
    await git(main, ["add", "."]);
    await git(main, ["commit", "-m", "config"]);
    const worktree = join(await mkdtemp(join(tmpdir(), "cx-prelat-wt-")), "feature");
    await git(main, ["worktree", "add", worktree, "HEAD"]);
    const home = await makeHome("prelat");
    paths.push(main, join(worktree, ".."), home);
    await writeRepoFile(worktree, "src/one.ts", "export const a = 1;\n");
    await writeRepoFile(worktree, "src/two.ts", "export const b = 2;\n");
    await writeSessionState(home, sessionState(main));
    const prePayload = (file: string): string =>
      JSON.stringify({
        session_id: SESSION_ID,
        cwd: main,
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: join(worktree, file) },
      });

    // Act
    const coldStart = performance.now();
    await runHook("pre-tool-use", prePayload("src/one.ts"), env(home));
    const coldMs = Math.round(performance.now() - coldStart);
    const warmStart = performance.now();
    await runHook("pre-tool-use", prePayload("src/two.ts"), env(home));
    const warmMs = Math.round(performance.now() - warmStart);

    // Assert
    console.log(
      `[capture-latency] pre-tool-use cold ${String(coldMs)} ms, warm ${String(warmMs)} ms (budget ${String(PRE_BUDGET_MS)})`,
    );
    expect(coldMs).toBeLessThan(PRE_BUDGET_MS);
    expect(warmMs).toBeLessThan(PRE_BUDGET_MS - WARM_HEADROOM_MS);
  });
});
