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
import { rm, stat } from "node:fs/promises";
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

/**
 * How long ago every fixture session began. NOT zero, and the reason is a
 * kernel's, not this file's.
 *
 * The git lane keeps a changed file only when its mtime is at or after the
 * session's start (capture-git-touches.ts `changedSince`). Linux stamps a
 * write from the COARSE real-time clock, which trails `Date.now()` by up to a
 * scheduler tick; a session "started" at `Date.now()` and a file rewritten a
 * millisecond later can therefore carry an mtime from BEFORE the session. The
 * lane then correctly calls it somebody else's work and records nothing —
 * which is how ubuntu-latest recorded zero git-lane records while macOS, whose
 * APFS stamps finely, recorded one. stop-git-touches.test.ts starts its
 * sessions a minute back for the same reason.
 */
const SESSION_STARTED_AGO_MS = 60_000;

const stateFor = (repoRoot: string): SessionStateInput => ({
  hostSessionKey: SESSION_ID,
  crosscheckSessionId: `cc_${SESSION_ID}`,
  workContextId: `wc_cc_${SESSION_ID}`,
  repoId: REPO_ID,
  repoRoot,
  hubUrl: DEAD_HUB_URL,
  developerId: "dev_self",
  startedAt: new Date(Date.now() - SESSION_STARTED_AGO_MS).toISOString(),
  seqEpoch: EPOCH,
  eventSeq: 0,
  toolWindows: [],
  toolWindowEvictions: 0,
});

/**
 * A Stop envelope wide enough that a loaded machine cannot turn a BEHAVIOUR
 * assertion into a budget measurement — the idiom stop-git-touches.test.ts
 * documents. At the default 400 ms the Stop envelope is 800 ms and the git
 * lane needs GIT_TOUCHES_TIMEOUT_MS of it unspent; a starved turn skips the
 * lane, correctly and counted, and that is the budget test's question, not
 * this file's. (Not the cause of the ubuntu failure here — 64 spinning
 * processes on a 16-core Mac never starved it. SESSION_STARTED_AGO_MS is.)
 */
const WIDE_TIMEOUT_MS = 8000;

const env = (home: string, timeoutMs: number = HTTP_TIMEOUT_MS): Env => ({
  CROSSCHECK_HOME: home,
  CROSSCHECK_HUB_URL: DEAD_HUB_URL,
  CROSSCHECK_API_KEY: "test-key",
  CROSSCHECK_TIMEOUT_MS: String(timeoutMs),
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
    // The precondition, asserted rather than inherited from the kernel's
    // clock: the rewrite must read as AFTER the session began, or the lane is
    // right to ignore it and every assertion below measures nothing.
    const session = await readSessionState(fx.home, SESSION_ID);
    const rewritten = await stat(join(fx.repo, "README.md"));
    expect(rewritten.mtimeMs).toBeGreaterThanOrEqual(
      Date.parse(session?.startedAt ?? ""),
    );

    // Act: on the WIDE envelope, because this asserts what the lane records,
    // not whether a starved hook could afford it — skipping is correct and
    // counted, and the budget question belongs to stop-git-touches.test.ts.
    await runHook(
      "stop",
      JSON.stringify({
        session_id: SESSION_ID,
        cwd: fx.repo,
        hook_event_name: "Stop",
      }),
      env(fx.home, WIDE_TIMEOUT_MS),
    );

    // Assert: the lane RAN, first. Without this a skipped lane reports itself
    // as `Expected: > 0, Received: 0`, which names neither the lane nor why —
    // and it is the one precondition every assertion below depends on.
    expect((await readSessionState(fx.home, SESSION_ID))?.gitLaneSkipped).toBe(0);
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
 * MEASURED ON THIS MACHINE. The reliable number is the ISOLATED one, because
 * a hook's own wall clock is dominated by work that has nothing to do with
 * this change (300 allocator calls, interleaved against the write every hook
 * already performs):
 *
 *   allocateSeq alone          p95 2.66 ms · max 8.06 ms
 *   updateSessionState alone   p95 2.31 ms · max 6.10 ms   ← already paid
 *
 * THE FINDING: one allocation costs the same as the locked state write each of
 * these hooks already makes. The documented ~100 ms worst case is
 * SPOOL_LOCK_RETRIES × SPOOL_LOCK_RETRY_DELAY_MS — the price of CONTENTION,
 * not of an uncontended acquisition.
 *
 * Whole-hook p95 deltas, interleaved ON/OFF so drift cancels rather than
 * landing on one arm (n = 60 each, two runs):
 *
 *   post-tool-use          -2.0 and -9.6 ms          (budget 1600 ms)
 *   post-tool-use-failure  +46.9 and -0.1 ms         (budget  800 ms)
 *   stop                   +3.8 and +0.3 ms          (budget  800 ms)
 *
 * THE +46.9 ms IS REPORTED RATHER THAN DROPPED, and it is measurement noise: a
 * second interleaved run of the identical harness gave -0.1 ms for the same
 * hook, the isolated allocator above never exceeded 8.06 ms, and a competing
 * test suite was running during the first. A negative delta is the same noise
 * with the opposite sign. Read all six as an order of magnitude, which is why
 * the assertion below compares against the BUDGET and not against a constant.
 *
 * ONE OF THE TWO 800 ms HOOKS DOES ALLOCATE, and spec 01 §6's "marginal cost
 * on both: 0 ms" is wrong about it. UserPromptSubmit really does allocate
 * nothing — it emits only `hint_delivery`, which is not a canonical event kind
 * — but PreToolUse takes a NEW acquisition and emits no record for it:
 * `openToolWindow`, the window floor that is what lets an edit be ordered
 * against an explanation at all. A hook that emits nothing can still pay for a
 * lock, and the note that said otherwise reasoned from the records.
 *
 * MEASURED RATHER THAN ASSERTED — three runs of `capture-latency.test.ts` each
 * way, against the 800 ms budget, on this machine:
 *
 *   with openToolWindow     cold 95, 89, 99 ms · warm 43, 41, 40 ms
 *   without openToolWindow  cold 104, 90, 88 ms · warm 45, 40, 41 ms
 *
 * THE TWO RANGES OVERLAP, so the added acquisition is not resolvable above
 * this harness's own noise — consistent with the isolated allocator above,
 * p95 2.66 ms against a budget of 800. The honest claim is "below the noise
 * floor at n = 3", never "0 ms": nobody measured zero, and the difference
 * between those two sentences is the whole discipline of this block.
 *
 * `capture-latency.test.ts` runs that path cold and warm against the budget on
 * every CI run, so the number has a gate. `hint-budget.test.ts` /
 * `hint-hook-latency.test.ts` cover UserPromptSubmit and need no new case.
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

/**
 * COMMIT.OBSERVED IS CLAUDE-ONLY, AND SPEC 01 §3.6 NAMES NO EMITTER FOR IT.
 *
 * `collectCommitEvidence` is imported by exactly one module in the whole tree —
 * this connector's SessionStart — so this is the only host that produces the
 * event at all. Its record is spooled OUTSIDE every lock the hook takes, after
 * `registerSessionFlow` has already published the state file, so the
 * allocation is a genuinely new acquisition on a path the spec's table does
 * not mention. Without it the one host that can emit `commit.observed` emits
 * it unpositioned, and the reason it carries would say "a connector from
 * before this protocol field" about a connector that has the field.
 */
describe("SessionStart positions its commit collection", () => {
  test("the commit-evidence record carries a position from this session", async () => {
    // Arrange: a repo with a commit, and a home with no state yet — the hook
    // registers, publishes state (minting the epoch), then collects.
    const home = await makeHome("seq-commit");
    const repo = await makeRepo("seq-commit", {
      remote: "git@github.com:acme/api.git",
    });
    paths.push(home, repo);

    // Act
    await runHook(
      "session-start",
      JSON.stringify({
        session_id: SESSION_ID,
        cwd: repo,
        hook_event_name: "SessionStart",
        source: "startup",
      }),
      env(home),
    );

    // Assert
    const records = (
      await readSpoolLines(home, repoKey(DEAD_HUB_URL, REPO_ID))
    ).map((line) => JSON.parse(line) as Record<string, unknown>);
    const evidence = records.filter(
      (record) => record["kind"] === "commit_evidence",
    );
    expect(evidence).toHaveLength(1);
    const stamp = evidence[0]?.["seq"] as { epoch: string; n: number };
    // A real position from this session's own epoch — not the "no connector
    // sent one" silence an omitted field would mean.
    expect(stamp.epoch).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(stamp.n).toBeGreaterThan(0);
    const state = await readSessionState(home, SESSION_ID);
    expect(state?.seqEpoch).toBe(stamp.epoch);
  });
});
