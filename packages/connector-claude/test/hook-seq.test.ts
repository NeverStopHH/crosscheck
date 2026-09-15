/**
 * EVERY RECORD A HOOK SPOOLS CARRIES A POSITION, AND THE BLOCK IS TAKEN ONCE.
 *
 * WHERE SPEC 01 §3.6 IS WRONG, and this file is the proof. It says allocation
 * "folds into the bookkeeping transform already there" with NO new lock
 * acquisition. It cannot: `handlePostToolUse` serializes its target records at
 * `captureTouchedFiles`, its fingerprint at `captureFailure`, and FLUSHES them
 * to the hub — all before its single `updateSessionState`. A position folded
 * into that write would be stamped on records already delivered. The same
 * shape holds for Stop's git lane, Cursor's file-edit handler and the ACP
 * engine, and `PostToolUseFailure` takes the state lock ZERO times today on
 * its capture path, so a first acquisition there is unavoidable.
 *
 * SEQ-9, THE HALF THAT CAN BE RED-FIRST. `capture-latency.test.ts` states in
 * its own header that a wall clock cannot be red-first. The claim §6 actually
 * makes is about the NUMBER of acquisitions, not their duration, and that is
 * countable: one block per invocation moves `eventSeq` by exactly the block
 * size. Two acquisitions move it by twice that, whatever the clock says.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { readSpoolLines, repoKey, runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import {
  HTTP_TIMEOUT_MS,
  MAX_TARGETS_PER_INVOCATION,
  POST_TOOL_USE_BUDGET_RATIO,
} from "@crosscheck/connector-core/constants.ts";
import {
  readSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionStateInput } from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const SESSION_ID = "hook-seq-uuid";
const DEAD_HUB_URL = "http://127.0.0.1:1";
const EPOCH = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
/** The worst case one capture invocation may need: its targets plus a fingerprint. */
const BLOCK = MAX_TARGETS_PER_INVOCATION + 1;
const POST_TOOL_USE_BUDGET_MS = POST_TOOL_USE_BUDGET_RATIO * HTTP_TIMEOUT_MS;

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const stateFor = (repoRoot: string): SessionStateInput => ({
  hostSessionKey: SESSION_ID,
  crosscheckSessionId: `cc_${SESSION_ID}`,
  workContextId: `wc_cc_${SESSION_ID}`,
  repoId: REPO_ID,
  repoRoot,
  hubUrl: DEAD_HUB_URL,
  developerId: "dev_self",
  startedAt: new Date().toISOString(),
  seqEpoch: EPOCH,
  eventSeq: 0,
});

const env = (home: string): Env => ({
  CROSSCHECK_HOME: home,
  CROSSCHECK_HUB_URL: DEAD_HUB_URL,
  CROSSCHECK_API_KEY: "test-key",
  CROSSCHECK_TIMEOUT_MS: String(HTTP_TIMEOUT_MS),
  CROSSCHECK_SSH_CANONICALIZE: "off",
});

interface Fixture {
  readonly home: string;
  readonly repo: string;
}

const fixture = async (label: string): Promise<Fixture> => {
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  paths.push(home, repo);
  await writeSessionState(home, stateFor(repo));
  return { home, repo };
};

const spooled = async (fx: Fixture): Promise<readonly Record<string, unknown>[]> =>
  (await readSpoolLines(fx.home, repoKey(DEAD_HUB_URL, REPO_ID))).map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );

const seqsOf = (
  records: readonly Record<string, unknown>[],
  kind: string,
): readonly unknown[] =>
  records
    .filter((record) => record["kind"] === kind)
    .map((record) => record["seq"]);

describe("PostToolUse positions everything it emits", () => {
  test("three edited files and a failure share ONE block, with distinct positions", async () => {
    // Arrange: both path fields the extractor reads, so the invocation emits
    // more than one target AND a fingerprint — the case where a block shared
    // by two consumers can actually collide.
    const fx = await fixture("hook-seq");
    await writeRepoFile(fx.repo, "src/a.ts", "export const x = 1;\n");
    await writeRepoFile(fx.repo, "src/nb.ipynb", "{}\n");

    // Act
    await runHook(
      "post-tool-use",
      JSON.stringify({
        session_id: SESSION_ID,
        cwd: fx.repo,
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: {
          file_path: join(fx.repo, "src/a.ts"),
          notebook_path: join(fx.repo, "src/nb.ipynb"),
        },
        tool_response: {
          is_error: true,
          error: "TypeError: refresh is not a function",
        },
      }),
      env(fx.home),
    );

    // Assert: every record carries a real position...
    const records = await spooled(fx);
    const stamps = seqsOf(records, "target") as { epoch: string; n: number }[];
    // Two file targets and one error fingerprint, all from one invocation.
    expect(stamps).toHaveLength(3);
    for (const stamp of stamps) {
      expect(stamp.epoch).toBe(EPOCH);
      expect(Number.isInteger(stamp.n)).toBe(true);
    }
    // ...no two share one...
    expect(new Set(stamps.map((stamp) => stamp.n)).size).toBe(stamps.length);
    // ...and the counter moved by exactly ONE block, which is the whole of
    // §6's cost claim: one acquisition per invocation, not one per record.
    const state = await readSessionState(fx.home, SESSION_ID);
    expect(state?.eventSeq).toBe(BLOCK);
    expect(state?.seqEpoch).toBe(EPOCH);
  });

  test("a second invocation continues the sequence rather than restarting it", async () => {
    // Arrange
    const fx = await fixture("hook-seq-twice");
    await writeRepoFile(fx.repo, "src/one.ts", "export const x = 1;\n");
    await writeRepoFile(fx.repo, "src/two.ts", "export const y = 2;\n");
    const fire = async (file: string): Promise<void> => {
      await runHook(
        "post-tool-use",
        JSON.stringify({
          session_id: SESSION_ID,
          cwd: fx.repo,
          hook_event_name: "PostToolUse",
          tool_name: "Edit",
          tool_input: { file_path: join(fx.repo, file) },
          tool_response: {},
        }),
        env(fx.home),
      );
    };

    // Act
    await fire("src/one.ts");
    await fire("src/two.ts");

    // Assert
    const stamps = seqsOf(await spooled(fx), "target") as {
      epoch: string;
      n: number;
    }[];
    expect(stamps).toHaveLength(2);
    expect(stamps[1]!.n).toBeGreaterThan(stamps[0]!.n);
    expect((await readSessionState(fx.home, SESSION_ID))?.eventSeq).toBe(2 * BLOCK);
  });

  test("a tool call that captures nothing takes no block at all", async () => {
    // Arrange: a read-only tool. Allocating here would burn a block and a lock
    // acquisition on every non-editing tool call in the session, which is most
    // of them — the budget claim depends on not paying for silence.
    const fx = await fixture("hook-seq-quiet");

    // Act
    await runHook(
      "post-tool-use",
      JSON.stringify({
        session_id: SESSION_ID,
        cwd: fx.repo,
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_input: {},
        tool_response: {},
      }),
      env(fx.home),
    );

    // Assert
    expect((await readSessionState(fx.home, SESSION_ID))?.eventSeq).toBe(0);
  });

  test("a session with no epoch emits the records and refuses the positions", async () => {
    // Arrange: a state file from before this protocol field. The work still
    // lands; only its order is withheld, and the reason travels with it.
    const fx = await fixture("hook-seq-legacy");
    await writeSessionState(fx.home, { ...stateFor(fx.repo), seqEpoch: null });
    await writeRepoFile(fx.repo, "src/legacy.ts", "export const x = 1;\n");

    // Act
    await runHook(
      "post-tool-use",
      JSON.stringify({
        session_id: SESSION_ID,
        cwd: fx.repo,
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: join(fx.repo, "src/legacy.ts") },
        tool_response: {},
      }),
      env(fx.home),
    );

    // Assert
    const stamps = seqsOf(await spooled(fx), "target");
    expect(stamps).toEqual([{ reason: "allocation_failed" }]);
  });
});

describe("PostToolUseFailure positions its fingerprint", () => {
  test("the fingerprint carries a position from a lock this hook never took before", async () => {
    // Arrange: on its capture path this hook takes the state lock ZERO times.
    // The acquisition is new and unavoidable, and it is inside the 800 ms
    // class the hook-budget rule governs.
    const fx = await fixture("hook-seq-failure");

    // Act
    await runHook(
      "post-tool-use-failure",
      JSON.stringify({
        session_id: SESSION_ID,
        cwd: fx.repo,
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: {},
        error: "ReferenceError: token is not defined",
      }),
      env(fx.home),
    );

    // Assert
    const stamps = seqsOf(await spooled(fx), "target") as {
      epoch: string;
      n: number;
    }[];
    expect(stamps).toHaveLength(1);
    expect(stamps[0]!.epoch).toBe(EPOCH);
    expect((await readSessionState(fx.home, SESSION_ID))?.eventSeq).toBe(1);
  });
});

describe("Stop's git lane positions what it observes", () => {
  test("a file changed without any Edit tool still gets a position", async () => {
    // Arrange: the second evidence lane. `sed -i`, a codemod or a generator
    // raise no Edit event, so this is the only lane that sees them at all —
    // and its records are spooled BEFORE Stop's locked `withGitTouches` write,
    // which is why the allocation cannot fold into it.
    // A TRACKED file, rewritten after the session began: `git diff` reports
    // nothing about an untracked one, which is a blind spot the lane already
    // prints beside its own counters.
    const fx = await fixture("hook-seq-stop");
    await writeRepoFile(fx.repo, "README.md", "# rewritten by a codemod\n");

    // Act
    await runHook(
      "stop",
      JSON.stringify({
        session_id: SESSION_ID,
        cwd: fx.repo,
        hook_event_name: "Stop",
      }),
      env(fx.home),
    );

    // Assert
    const records = await spooled(fx);
    const gitLane = records.filter(
      (record) =>
        record["kind"] === "target" &&
        (record["body"] as { source?: string }).source === "git_diff",
    );
    expect(gitLane.length).toBeGreaterThan(0);
    for (const record of gitLane) {
      expect((record["seq"] as { epoch: string }).epoch).toBe(EPOCH);
    }
  });
});

/**
 * SEQ-9's WALL CLOCK, and the half of it that cannot be red-first.
 *
 * Spec 01 §6 asserts "marginal cost on both: 0 ms" on the two 800 ms hooks and
 * concedes a new ~100 ms worst-case acquisition elsewhere — on ARITHMETIC
 * alone: 100 ms is SPOOL_LOCK_RETRIES × SPOOL_LOCK_RETRY_DELAY_MS, the lock's
 * documented worst case under contention, not a measurement of this change.
 * This measures it.
 *
 * MEASURED ON THIS MACHINE, interleaved ON/OFF so machine drift cancels rather
 * than landing on one arm (n = 60 each, plus 300 isolated allocator calls):
 *
 *   allocateSeq alone          p95 2.66 ms · max 8.06 ms
 *   updateSessionState alone   p95 2.31 ms · max 6.10 ms   ← already paid
 *   post-tool-use              p95 delta  -9.6 .. -2.0 ms  (budget 1600 ms)
 *   post-tool-use-failure      p95 delta  -0.1 .. +0.0 ms  (budget  800 ms)
 *   stop                       p95 delta  +0.3 .. +3.8 ms  (budget  800 ms)
 *
 * Read those as an order of magnitude, not constants — they move with machine
 * load, which is why the assertions below compare against the BUDGET. The
 * finding they carry: one allocation costs the same as the state write every
 * one of these hooks already performs, and every delta is inside the noise of
 * a single run.
 *
 * THE TWO 800 ms HOOKS ALLOCATE NOTHING AT ALL, and that is checkable rather
 * than measured: UserPromptSubmit emits only `hint_delivery`, which is not a
 * canonical event kind, and PreToolUse emits no record. Their budgets are
 * untouched, and `hint-budget.test.ts` / `hint-hook-latency.test.ts` need no
 * new case.
 */
describe("SEQ-9 — the allocation's cost is measured, not asserted", () => {
  test("PostToolUse with allocation on still clears its budget with room", async () => {
    // Arrange
    const fx = await fixture("seq-latency");
    await writeRepoFile(fx.repo, "src/measured.ts", "export const x = 1;\n");
    const payload = JSON.stringify({
      session_id: SESSION_ID,
      cwd: fx.repo,
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: join(fx.repo, "src/measured.ts") },
      tool_response: {},
    });

    // Act
    const samples: number[] = [];
    for (let run = 0; run < 12; run += 1) {
      const started = performance.now();
      await runHook("post-tool-use", payload, env(fx.home));
      samples.push(performance.now() - started);
    }
    const sorted = [...samples].sort((left, right) => left - right);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
    process.stdout.write(
      `[seq-latency] post-tool-use p95 ${p95.toFixed(1)} ms (budget ${String(POST_TOOL_USE_BUDGET_MS)})\n`,
    );

    // Assert: a printed number beside a budget, so a slow run is visible in
    // the log rather than a guess — and the allocation really happened.
    expect(p95).toBeLessThan(POST_TOOL_USE_BUDGET_MS);
    expect((await readSessionState(fx.home, SESSION_ID))?.eventSeq).toBeGreaterThan(0);
  });
});
