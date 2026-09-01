/**
 * The #17 worktree resolution MEASURED through the real `runCursorHook`, the
 * Cursor twin of connector-claude/test/capture-latency.test.ts: the per-edit
 * capture cost must fit the afterFileEdit budget with room even on the FIRST
 * touch of a new worktree root (the one git-bearing case), and a warm cache
 * must add nothing measurable.
 *
 * Cursor pays this more often than Claude does. `resolveCursorRepo` resolves
 * identity from the WORKSPACE root first, so in the ordinary shape
 * `ctx.identity.root` equals the session's checkout, the free D2 candidate is
 * skipped, and every out-of-checkout path takes the bounded fs walk plus one
 * `resolveRepoIdentity` per NEW root. The per-session cache is the whole
 * reason that is once-per-root and not once-per-edit; a cold resolution may
 * cost up to GIT_TIMEOUT_MS (1500 ms) inside a 1600 ms budget, and
 * `runCursorHookWith`'s withBudget race is the fail-open backstop.
 *
 * Elapsed times are PRINTED so a slow run is a number in the log, not a guess.
 * A wall clock cannot be red-first — main does no resolution at all and
 * measures the same order of magnitude — so read these as measurements of the
 * new cost, not as proofs of the new behaviour: the behaviour is pinned by
 * test/worktree-capture.test.ts, and the cache HIT path by the recorded
 * attempt COUNT in the same file, which a clock cannot see.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HTTP_TIMEOUT_MS,
  POST_TOOL_USE_BUDGET_RATIO,
} from "@crosscheck/connector-core/constants.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { readSpoolLines } from "@crosscheck/connector-core/spool/files.ts";
import { cursorHostSessionKey } from "@crosscheck/connector-core/state/host-session-key.ts";
import {
  deriveSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";

import { runCursorHook } from "../src/index.ts";
import { git, makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const CONVERSATION_ID = "conv-caplat";
const HOST_KEY = cursorHostSessionKey(CONVERSATION_ID);
const DEAD_HUB_URL = "http://127.0.0.1:1";
const BUDGET_MS = POST_TOOL_USE_BUDGET_RATIO * HTTP_TIMEOUT_MS;
/** Headroom the warm path must clear the budget by: capture is fs + spool. */
const WARM_HEADROOM_MS = 400;

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const env = (home: string): Env => ({
  CROSSCHECK_HOME: home,
  CROSSCHECK_HUB_URL: DEAD_HUB_URL,
  CROSSCHECK_API_KEY: "test-key",
  CROSSCHECK_TIMEOUT_MS: String(HTTP_TIMEOUT_MS),
  CROSSCHECK_SSH_CANONICALIZE: "off",
});

const editPayload = (workspaceRoot: string, absoluteFile: string): string =>
  JSON.stringify({
    conversation_id: CONVERSATION_ID,
    hook_event_name: "afterFileEdit",
    cursor_version: "3.13.25",
    workspace_roots: [workspaceRoot],
    file_path: absoluteFile,
    edits: [{ old_string: "a", new_string: "b" }],
  });

describe("the per-edit worktree resolution fits the afterFileEdit budget", () => {
  test("cold first-touch and warm cache both clear the budget with room", async () => {
    // Arrange: repo A with a committed config, one linked worktree B
    const main = await makeRepo("cur-caplat", { remote: "git@github.com:acme/api.git" });
    await writeFile(
      join(main, ".crosscheck.json"),
      `${JSON.stringify({ hubUrl: DEAD_HUB_URL }, null, 2)}\n`,
      "utf8",
    );
    await git(main, ["add", "."]);
    await git(main, ["commit", "-m", "config"]);
    const worktree = join(await mkdtemp(join(tmpdir(), "cx-cur-caplat-wt-")), "feature");
    await git(main, ["worktree", "add", worktree, "HEAD"]);
    const home = await makeHome("cur-caplat");
    paths.push(main, join(worktree, ".."), home);
    await writeRepoFile(worktree, "src/one.ts", "export const a = 1;\n");
    await writeRepoFile(worktree, "src/two.ts", "export const b = 2;\n");
    await writeSessionState(
      home,
      deriveSessionState({
        hostSessionKey: HOST_KEY,
        repoId: REPO_ID,
        repoRoot: main,
        hubUrl: DEAD_HUB_URL,
        developerId: "dev_self",
        startedAt: new Date().toISOString(),
      }),
    );

    // Act: the first touch of the worktree root resolves identity (cold); the
    // second touch of the SAME root reads the cache (warm).
    const coldStart = performance.now();
    await runCursorHook(
      "afterFileEdit",
      editPayload(main, join(worktree, "src/one.ts")),
      env(home),
    );
    const coldMs = Math.round(performance.now() - coldStart);

    const warmStart = performance.now();
    await runCursorHook(
      "afterFileEdit",
      editPayload(main, join(worktree, "src/two.ts")),
      env(home),
    );
    const warmMs = Math.round(performance.now() - warmStart);

    // Assert: both landed, both under budget, the warm path far under it
    console.log(
      `[cursor-capture-latency] cold ${String(coldMs)} ms, warm ${String(warmMs)} ms (budget ${String(BUDGET_MS)})`,
    );
    const targets = (await readSpoolLines(home, repoKey(DEAD_HUB_URL, REPO_ID)))
      .map((line) => JSON.parse(line) as { kind: string; body?: { value?: string } })
      .filter((record) => record.kind === "target")
      .map((record) => record.body?.value ?? "");
    expect(targets).toEqual(["src/one.ts", "src/two.ts"]);
    expect(coldMs).toBeLessThan(BUDGET_MS);
    expect(warmMs).toBeLessThan(BUDGET_MS - WARM_HEADROOM_MS);
  });
});
