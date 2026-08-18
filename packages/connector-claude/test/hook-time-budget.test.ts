/**
 * Hook time budgets, measured the way the incident was measured: through the
 * real `crosscheck hook <name>` process, exactly as Claude Code invokes it.
 *
 * THE INCIDENT, HISTORICAL. Maintenance was handed the hook's raw remaining time
 * instead of the reserve-protected spare. Against a 350 ms hub with a 600-record
 * backlog, driven through this binary: SessionStart went from 640 ms with the
 * briefing to 1035 ms with NO briefing, and SessionEnd from 435 ms with the
 * `end` sent to 831 ms with no `end`, no `.pending-end` marker and its session
 * state file still on disk — which also leaves that spool permanently
 * unreapable. A human found that by measuring on a hunch.
 *
 * Those four figures are from the defective tree and are NOT re-derivable from
 * this one; no command here prints them and none is offered. What is re-runnable
 * is the defect itself, re-introduced on demand by
 * scripts/measure-ceiling-detection.ts, whose `reserve removed` row prints the
 * milliseconds THIS tree produces. This file is the machine that re-measures.
 *
 * WHAT IS LOAD-BEARING. The behavioural assertions, not the clock. Each one is
 * a flag that flips outright under the defect: briefing SHOWN → MISSING,
 * `end` 1 → 0, marker true → false, state file gone → present, heartbeat 1 → 0.
 * They are what catches the regression HERE.
 *
 * "HERE" IS THE WHOLE QUALIFICATION, and an earlier version of this sentence —
 * "they are what would catch the regression again" — did not carry it. Every
 * flag above flips through a wall-clock side effect: the reserve is gone, so
 * maintenance eats the budget, so the briefing does not fit. Whether it does
 * depends on how long maintenance takes on the machine running the check, which
 * makes this file a bet on machine speed. The bet was lost where it mattered:
 * HISTORICAL, observed once on 2026-07-29 and NOT re-derivable from this tree —
 * the `Mutation proof` job reported HOOK_RESERVE_RATIO = 0 NOT CAUGHT by this
 * file on GitHub's hosted runner, in a run that caught every other mutation,
 * while the same mutation was caught in every configuration reachable from this
 * desk. That observation is a one-off log line from a CI run; what IS re-runnable
 * is the weakness behind it, and it is worse than one unlucky machine: this file
 * stays GREEN under HOOK_RESERVE_RATIO set to 0.999, 0.5 and 1.0000001, and under
 * removal of the Math.max floor. Reproduce by applying any of those to
 * src/constants.ts and running this file. So the DETECTOR for that constant is
 * now test/hook-reserve.test.ts,
 * which asserts the subtraction itself against a frozen clock and is what
 * scripts/mutation-check.ts runs.
 *
 * Nothing here was weakened to make room for it. This file remains the only
 * thing that measures the CONSEQUENCE — that a hook with its reserve intact
 * actually returns the briefing, actually sends the `end`, actually writes the
 * marker — through the real process, which no unit test can claim.
 *
 * HOW FAR THEY HOLD ON A BUSY RUNNER, MEASURED. An earlier version of this
 * comment claimed they "cannot flake on a busy runner". They can. Swept in
 * oven/bun:1 under `--cpus=2`, with N busy-spin processes competing for that
 * quota, 8 rounds per level. Reproduce one level with:
 *
 *   docker run --rm -v "$PWD":/w -w /w --cpus=2 oven/bun:1 sh -c '
 *     apt-get update -qq >/dev/null 2>&1
 *     apt-get install -y -qq git >/dev/null 2>&1
 *     bun install --frozen-lockfile >/dev/null 2>&1
 *     for i in $(seq 1 12); do (while :; do :; done) & done
 *     bun test packages/connector-claude/test/hook-time-budget.test.ts'
 *
 * THE TWO apt-get LINES ARE LOAD-BEARING and were missing from this recipe until
 * now. test/helpers.ts `makeRepo` shells out to git, and oven/bun:1 ships
 * without it, so the recipe as previously written printed 0 pass / 5 fail with
 * `Executable not found in $PATH: "git"` at EVERY spinner level — it could not
 * produce a single row of the table below. Worse, the signature it did produce,
 * five behavioural failures and no timeout line, is precisely what the triage
 * rule further down classifies as a REAL FINDING rather than a starved runner.
 * scripts/mutation-check.ts documents the same trap for its own recipe.
 *
 *     spinners  factor   SIGNATURE — which assertions go red
 *     8         4x       none; every round green
 *     12        6x       WALL-CLOCK CEILINGS ONLY. No behavioural assertion red,
 *                        and NO bun timeout line. One to three ceilings per
 *                        failing round
 *     16        8x       bun's own 5000 ms per-test timeout fires, and every
 *                        test in the file then reports as collateral
 *     24        12x      same signature as 8x
 *
 * THE 6x ROW, RE-MEASURED THIS ROUND with the fixed recipe above, on linux/arm64
 * in oven/bun:1: 8 rounds, none of them green, failing 1, 2, 1, 3, 2, 1, 1 and 2
 * assertions. All 13 failures across those rounds were `elapsedMs` ceilings —
 * zero behavioural assertions, zero bun timeout lines. That is the SIGNATURE
 * column holding exactly, and it is why the "one or two ceilings" the previous
 * version of this paragraph settled on now reads "one to three": a round with
 * three was observed here.
 *
 * The PASS RATE at a given factor is a property of the host, not of this file —
 * earlier sweeps saw 1 of 8 and then 2 of 5 green at 6x, where this round saw
 * 0 of 8. Do not read the rate as a fact about the code. What is stable, and
 * what the triage rule below rests on, is the SIGNATURE column: which kind of
 * assertion goes red at each level. Only the 6x row was re-measured this round;
 * the 4x, 8x and 12x rows are carried over from earlier sweeps and were not
 * re-run, so they are HISTORICAL — their SIGNATURE entries have held in every
 * observation, but the recipe above is the only one of the four re-derived here.
 *
 * So: stable through ~4x oversubscription. Between 4x and 8x it is the ceilings
 * that go, not the behaviour. Only past ~8x does a behavioural assertion report
 * red, and there the log carries "this test timed out after 5000ms" above the
 * failure. A genuine budget regression does not produce that line: the shipped
 * defect (HOOK_RESERVE_RATIO = 0) on an idle machine fails 4 of the 5 tests, all
 * on BEHAVIOURAL assertions, with no timeout — the `reserve removed` row of
 * scripts/measure-ceiling-detection.ts, which prints each failure's wall time
 * beside it. HISTORICAL readings, each true when taken and none re-derivable:
 * 1117/909/916/1715 ms, then 1126/920/923/1725, then 1143/934/925/1730 — three
 * runs of the same command on the same machine, drifting every time. Do not
 * expect any of them back; the command reports whatever the machine is doing
 * that minute. Two rounds already wrote one of these sets down as though it
 * were a result, and the second round had to correct the first.
 * What holds across both is the KIND: four failures, all behavioural, no
 * timeout line. The script had to be taught to emit any milliseconds at all; it
 * previously printed none, so the range this sentence used to quote named a
 * source that could not establish it.
 *
 * WHEN THIS JOB GOES RED. The rule that used to be here was "look for bun's
 * timeout line; with it the runner was starved, without it it is a finding".
 * That is wrong in the band where flake actually begins: at 6x there is no
 * timeout line, and the rule would call a starved runner a regression. The
 * discriminator is not the timeout line, it is WHICH KIND of assertion failed,
 * with the timeout line as a second test for the top of the band:
 *
 *   1. "timed out after" anywhere in the log     → starved runner, re-run
 *   2. else, every failure is an `elapsedMs`
 *      ceiling and no behavioural assertion
 *      failed                                    → starved runner, re-run
 *   3. else — any of briefing / `end` count /
 *      marker / state file / heartbeat red,
 *      with no timeout line                      → FINDING
 *
 * That gives the right answer at every level in the table above and for the real
 * defect. Its weak point is rule 2, which assumes a genuine regression always
 * trips a behavioural assertion as well as a ceiling. Every variant in
 * scripts/measure-ceiling-detection.ts does exactly that, including the
 * both-bounds-gone one, so no counter-example is known — but a future defect
 * that moved only the clock would be misread as starvation, and that is the
 * failure mode to watch for. In case 2 or 3,
 * `bun run packages/connector-claude/scripts/measure-process-floor.ts` on the
 * same machine says whether the box or the code got slower.
 *
 * WHAT THE CEILINGS ACTUALLY CATCH: NOTHING ON THEIR OWN. Two previous versions
 * of this paragraph claimed otherwise and neither survived being run, so the
 * measurement is now a script rather than a sentence:
 *
 *   bun run packages/connector-claude/scripts/measure-ceiling-detection.ts
 *
 * It removes each bound in turn and reports what the suite does. The KIND column
 * below is the script's own output, not an interpretation of it: for every
 * failure it prints the assertion bun's caret marked and classifies it CEILING
 * (the assertion is against `elapsedMs`) or BEHAVIOURAL, then summarises each
 * variant as e.g. `1 pass / 4 fail  [3 ceiling, 1 behavioural]`. It did NOT do
 * that when this table was first written — it printed test names and pass/fail
 * counts only, so the KIND column named a source that could not establish it.
 * Identical rows on macOS 26 arm64 and in oven/bun:1 under --cpus=2:
 *
 *     variant                                    result
 *     baseline                                   5 pass / 0 fail
 *     race removed                               5 pass / 0 fail
 *     spare bound removed                        1 pass / 4 fail, all BEHAVIOURAL
 *     reserve removed (the shipped defect)       1 pass / 4 fail, all BEHAVIOURAL
 *     both bounds removed                        1 pass / 4 fail: 3 ceilings and
 *                                                1 behavioural
 *     both bounds removed, ceilings neutralised  4 pass / 1 fail, BEHAVIOURAL
 *
 * Read the last row first. It is the previous claim's own scenario with the
 * ceilings raised out of reach, and the suite still goes red — so "the ceilings
 * catch the case where BOTH bounds are gone, and only that case" is false in
 * both halves. The behavioural assertion that catches it is the own-records
 * SessionEnd: with both bounds gone the hook SENDS `end` (1) where it must defer
 * (0). The previous sentence "the hook still does everything right — briefing
 * returned, `end` sent — just far too late" had that exactly backwards; sending
 * that `end` publishes a finished session whose records are still on this disk,
 * which is the defect, not the correct behaviour arriving late.
 *
 * So no defect measured here is caught by the ceilings alone. What they add in
 * the both-bounds-gone row is volume — 4 red tests instead of 1 — and a bound on
 * latency regressions that keep every behaviour correct. That second one is a
 * hypothesis: no variant above exhibits it, so nothing here claims it as proven.
 * The ceilings are kept as a coarse guard on that basis and on no stronger one.
 *
 * The three ceilings that row beats print from the same script, as its `ceilings
 * beaten:` line in `elapsed/bound` form. Measured this round: 2577/1600,
 * 2223/1400 and 2577/2200 on macOS 26 arm64, and 2605/1600, 2214/1400 and
 * 2599/2200 in oven/bun:1 under --cpus=2. The two platforms agree on the KIND
 * and count of every failure, which is what the table above claims; they do not
 * agree on the digits, and nothing here says they should. Wall-clock figures on
 * a shared machine will differ on yours — the durable claim is that all three
 * exceed their ceilings, not by how much.
 *
 * Sibling file: hook-budget.test.ts drives `runHook` IN-PROCESS and owns the
 * deferred-end / marker-recovery semantics. This one is the process-level pass:
 * it also covers bin/crosscheck.ts's stdin read and its exit-0 contract.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  HTTP_TIMEOUT_MS,
  POST_TOOL_USE_BUDGET_RATIO,
  SESSION_END_BUDGET_RATIO,
  SESSION_START_BUDGET_RATIO,
  appendRecords,
  readSessionState,
  repoKey,
} from "../src/index.ts";
import {
  sessionSlug,
  sessionStatePath,
  spoolPendingEndPath,
} from "@crosscheck/connector-core/config/paths.ts";
import { writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";
import {
  SELF_DEVELOPER_ID,
  TEAMMATE_NAME,
  startSlowHub,
} from "./fixtures/slow-hub.ts";
import type { MockHub } from "./fixtures/slow-hub.ts";

const BIN_PATH = resolve(import.meta.dir, "..", "src", "bin", "crosscheck.ts");

const REPO_ID = "github.com/acme/api";
const REPO_REMOTE = "git@github.com:acme/api.git";

/** More batches than any hook budget can pay for at this latency. */
const BACKLOG = 600;
/** Just under the 400 ms default request timeout, as the verifier measured it. */
const INGEST_LATENCY_MS = 350;

/**
 * What the PROCESS costs on top of the budget the hook enforces internally:
 * interpreter start-up, module transpile, and the several git processes repo
 * identity spawns.
 *
 * MEASURED, by `bun run packages/connector-claude/scripts/measure-process-floor.ts`
 * — the cheapest hook there is, against a zero-latency hub with an empty spool,
 * 10 runs each. THE FLOOR IS A PROPERTY OF THE HOST, not of this code, so the
 * load each row was taken under is part of the measurement. Every row below was
 * re-measured this round, on this machine and in this container:
 *
 *     macOS 26 arm64, 16 cores, load 4.35    min   71  p50   72  max   77 ms
 *     macOS 26 arm64, 32 spinners, load 7.18 min  149  p50  192  max  240 ms
 *     oven/bun:1 --cpus=2, idle              min   48  p50   49  max   53 ms
 *     oven/bun:1 --cpus=2, 16 spinners (8x)  min 3302 p50 7205 max 8788 ms
 *
 * THE PREVIOUS macOS ROWS DID NOT REPRODUCE, and the way they failed is worth
 * recording. An earlier comment cited "417-447 ms across 10 runs" — an order of
 * magnitude out. The version after it cited min 84 / p50 85 / max 96 at "load
 * ~4.7" and dismissed a min 71 / p50 73 / max 79 reading as belonging to "a
 * quieter box". Re-run here at load 4.35 on the same 16 cores, the floor is
 * 71 / 72 / 77 — the figures that were dismissed, not the ones that did the
 * dismissing. Treat every row as a reading from one host on one day and
 * re-measure rather than trusting it; that is the only claim this table can
 * honestly make.
 *
 * 600 ms is NOT "the floor plus headroom", and it is NOT an absolute bound.
 * Against the rows above it is ~7.8x the worst idle-ish macOS floor and ~11x
 * the idle container one. It is not a bound because contention does not merely
 * add a constant: at 8x oversubscription the process floor ALONE reached
 * 8788 ms, about fifteen times PROCESS_ALLOWANCE_MS, which is the same fact the
 * oversubscription table in the header states from the other side — the ceilings
 * are the first thing to go on a starved runner, and that is expected rather
 * than a defect.
 *
 * An earlier version of this paragraph justified the slack by "the one defect
 * the ceilings are proven to catch", which the header now records as measured
 * and false: no defect is caught by the ceilings alone. So the honest account of
 * this number is narrower. 600 ms puts the ceilings at 1600 / 1400 / 2200 /
 * 1000 ms. That sits above the bounded case with room to spare and below the
 * both-bounds-gone case, whose figures the header quotes from the `ceilings
 * beaten:` line of scripts/measure-ceiling-detection.ts, so the ceilings still
 * separate those two states. Tightening the constant towards the measured floor would not add
 * detection — the behavioural assertions already catch every variant measured —
 * and would spend the flake headroom that the oversubscription sweep above shows
 * is the first thing to go.
 */
const PROCESS_ALLOWANCE_MS = 600;

const ceilingFor = (budgetRatio: number): number =>
  HTTP_TIMEOUT_MS * budgetRatio + PROCESS_ALLOWANCE_MS;

const SESSION_START_CEILING_MS = ceilingFor(SESSION_START_BUDGET_RATIO);
const SESSION_END_CEILING_MS = ceilingFor(SESSION_END_BUDGET_RATIO);
const POST_TOOL_USE_CEILING_MS = ceilingFor(POST_TOOL_USE_BUDGET_RATIO);
/** Nothing to send means no round trip beyond one heartbeat. */
const IDLE_CEILING_MS = HTTP_TIMEOUT_MS + PROCESS_ALLOWANCE_MS;

const paths: string[] = [];
const hubs: MockHub[] = [];

afterEach(async () => {
  for (const hub of hubs) {
    hub.stop();
  }
  hubs.length = 0;
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly hub: MockHub;
  readonly key: string;
  readonly env: Record<string, string>;
}

const fixture = async (label: string): Promise<Fixture> => {
  const repo = await makeRepo(label, { remote: REPO_REMOTE });
  const home = await makeHome(label);
  paths.push(repo, home);
  const hub = startSlowHub({ ingest: INGEST_LATENCY_MS, end: 0, other: 0 });
  hubs.push(hub);
  return {
    repo,
    home,
    hub,
    key: repoKey(hub.url, REPO_ID),
    // No CROSSCHECK_TIMEOUT_MS: the documented 400 ms default, and with it the
    // documented 1000 / 800 / 1600 ms hook budgets. CROSSCHECK_DISABLED is
    // pinned so a developer's own shell cannot make these pass vacuously.
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.url,
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_DISABLED: "0",
    },
  };
};

const envelope = (index: number, sessionId: string): Record<string, unknown> => ({
  cx: "0.1",
  id: `env_backlog_${index}`,
  ts: new Date().toISOString(),
  producer: {
    developerId: SELF_DEVELOPER_ID,
    agentKind: "claude-code",
    sessionId: `cc_${sessionId}`,
  },
  kind: "target",
  body: { workContextId: "wc_1", kind: "file", value: `src/f${index}.ts` },
});

const seedBacklog = async (
  fixed: Fixture,
  ownerSessionId: string,
): Promise<void> => {
  await appendRecords(
    fixed.home,
    fixed.key,
    ownerSessionId,
    Array.from({ length: BACKLOG }, (_unused, index) =>
      envelope(index, ownerSessionId),
    ),
    new Date(),
  );
};

const liveSession = async (fixed: Fixture, sessionId: string): Promise<void> => {
  await writeSessionState(fixed.home, {
    hostSessionKey: sessionId,
    crosscheckSessionId: `cc_${sessionId}`,
    workContextId: `wc_cc_${sessionId}`,
    repoId: REPO_ID,
    repoRoot: fixed.repo,
    hubUrl: fixed.hub.url,
    developerId: SELF_DEVELOPER_ID,
    startedAt: new Date().toISOString(),
    lastHeartbeatAt: null,
    seenTargets: [],
  });
};

interface HookRun {
  readonly elapsedMs: number;
  readonly stdout: string;
  readonly exitCode: number;
}

/** The real entry point, spawned the way Claude Code spawns it. */
const runHookBinary = async (
  fixed: Fixture,
  hookName: string,
  payload: Record<string, unknown>,
): Promise<HookRun> => {
  const startedAt = Bun.nanoseconds();
  const proc = Bun.spawn({
    cmd: [process.execPath, BIN_PATH, "hook", hookName],
    env: { ...process.env, ...fixed.env },
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "ignore",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return {
    elapsedMs: Math.round((Bun.nanoseconds() - startedAt) / 1e6),
    stdout,
    exitCode,
  };
};

const briefingOf = (stdout: string): string => {
  try {
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    return parsed.hookSpecificOutput?.additionalContext ?? "";
  } catch {
    return "";
  }
};

const markerExists = (fixed: Fixture, sessionId: string): Promise<boolean> =>
  Bun.file(
    spoolPendingEndPath(fixed.home, fixed.key, sessionSlug(sessionId)),
  ).exists();

const stateExists = (fixed: Fixture, sessionId: string): Promise<boolean> =>
  Bun.file(sessionStatePath(fixed.home, sessionId)).exists();

describe("SessionStart against a slow hub with a backlog", () => {
  test("returns the briefing rather than spending the hook on the drain", async () => {
    // Arrange: 600 records left by an older session, ingest at 350 ms a batch
    const fixed = await fixture("timebudget-start");
    await seedBacklog(fixed, "old-session");

    // Act
    const run = await runHookBinary(fixed, "session-start", {
      session_id: "start-uuid",
      cwd: fixed.repo,
      hook_event_name: "SessionStart",
      source: "startup",
    });

    // Assert: the briefing is the whole point of the hook — it went MISSING
    // when the drain was allowed to spend the reserve.
    expect(briefingOf(run.stdout)).toContain(TEAMMATE_NAME);
    expect(run.exitCode).toBe(0);
    expect(run.elapsedMs).toBeLessThan(SESSION_START_CEILING_MS);
  });
});

describe("SessionEnd against a slow hub with a backlog", () => {
  test("terminates the session when the undelivered records are somebody else's", async () => {
    // Arrange: a big backlog, none of it produced by the session that is ending
    const fixed = await fixture("timebudget-end-foreign");
    const sessionId = "end-clean-uuid";
    await seedBacklog(fixed, "old-session");
    await liveSession(fixed, sessionId);

    // Act
    const run = await runHookBinary(fixed, "session-end", {
      session_id: sessionId,
      cwd: fixed.repo,
      hook_event_name: "SessionEnd",
      reason: "clear",
    });

    // Assert: ended, with nothing deferred and no state file left behind — the
    // defect reached none of these three, it ran out of budget first.
    expect(fixed.hub.calls.end).toBe(1);
    expect(await markerExists(fixed, sessionId)).toBe(false);
    expect(await stateExists(fixed, sessionId)).toBe(false);
    expect(run.exitCode).toBe(0);
    expect(run.elapsedMs).toBeLessThan(SESSION_END_CEILING_MS);
  });

  test("defers the end deliberately while its OWN records are still on disk", async () => {
    // Arrange: the backlog belongs to the session that is ending
    const fixed = await fixture("timebudget-end-own");
    const sessionId = "end-uuid";
    await seedBacklog(fixed, sessionId);
    await liveSession(fixed, sessionId);

    // Act
    const run = await runHookBinary(fixed, "session-end", {
      session_id: sessionId,
      cwd: fixed.repo,
      hook_event_name: "SessionEnd",
      reason: "clear",
    });

    // Assert: NOT ended, and that is the design — telling the hub "done" would
    // publish a finished session whose records are still on this disk. What
    // must survive is the intent: a marker for reap, and no state file to make
    // the spool unreapable. The defect wrote neither.
    expect(fixed.hub.calls.end).toBe(0);
    expect(await markerExists(fixed, sessionId)).toBe(true);
    expect(await stateExists(fixed, sessionId)).toBe(false);
    expect(run.stdout).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.elapsedMs).toBeLessThan(SESSION_END_CEILING_MS);
  });
});

describe("PostToolUse against a slow hub with a backlog", () => {
  test("still heartbeats and still records what it saw", async () => {
    // Arrange: the same conditions that took SessionStart's briefing
    const fixed = await fixture("timebudget-post");
    const sessionId = "post-uuid";
    await seedBacklog(fixed, "old-session");
    await liveSession(fixed, sessionId);

    // Act
    const run = await runHookBinary(fixed, "post-tool-use", {
      session_id: sessionId,
      cwd: fixed.repo,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(fixed.repo, "src/a.ts") },
      tool_response: { success: true },
    });

    // Assert: the two things the reserve exists to protect here both happened —
    // the heartbeat that keeps this developer visible in teammates' presence,
    // and the state write that remembers the target so it is not re-sent.
    expect(fixed.hub.calls.heartbeat).toBe(1);
    const state = await readSessionState(fixed.home, sessionId);
    expect(state?.seenTargets).toContain("src/a.ts");
    // Never stdout: PostToolUse is not a context-injecting hook, and anything
    // printed here would land in the reader's context unasked.
    expect(run.stdout).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.elapsedMs).toBeLessThan(POST_TOOL_USE_CEILING_MS);
  });

  test("costs nothing but its own start-up when there is nothing to send", async () => {
    // Arrange: an empty spool and a Bash call that produces no target and no
    // failure fingerprint — the common case, thousands of times a day
    const fixed = await fixture("timebudget-post-idle");
    const sessionId = "post-idle-uuid";
    await liveSession(fixed, sessionId);

    // Act
    const run = await runHookBinary(fixed, "post-tool-use", {
      session_id: sessionId,
      cwd: fixed.repo,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "bun test" },
      tool_response: { exit_code: 0, stdout: "ok" },
    });

    // Assert: one heartbeat, no ingest round trip at all, nothing printed
    expect(fixed.hub.calls.records).toBe(0);
    expect(fixed.hub.calls.heartbeat).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.elapsedMs).toBeLessThan(IDLE_CEILING_MS);
  });
});