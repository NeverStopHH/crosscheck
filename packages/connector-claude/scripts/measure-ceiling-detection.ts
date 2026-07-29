/**
 * Measures what the WALL-CLOCK CEILINGS in test/hook-time-budget.test.ts detect
 * that the behavioural assertions beside them do not.
 *
 * It exists because the answer written in that file's header was wrong twice.
 * The first version claimed the ceilings backstop `withBudget` disappearing; the
 * second claimed they are the only thing that catches both bounds being removed
 * at once. Neither survived being run. A justification for keeping a check has
 * to be re-runnable, so it lives here rather than in a paragraph.
 *
 *   bun run packages/connector-claude/scripts/measure-ceiling-detection.ts
 *
 * Each variant is a single textual edit to the real source, the budget suite is
 * run against it, and the file is restored in a `finally` — the same shape as
 * scripts/mutation-check.ts, and the same recovery if a run ever dies half-way:
 * `git checkout -- packages`. Nothing here writes anywhere else.
 *
 * The variant that answers the question is the last one: both bounds removed AND
 * the ceilings raised out of reach, so only behaviour can speak. If the suite
 * still goes red there, the ceilings caught nothing the behavioural assertions
 * had not already caught.
 */
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const CONNECTOR = "packages/connector-claude";
const BUDGET_TEST = `${CONNECTOR}/test/hook-time-budget.test.ts`;

const RUNNER = `${CONNECTOR}/src/hooks/runner.ts`;
const CONSTANTS = `${CONNECTOR}/src/constants.ts`;

interface Edit {
  readonly file: string;
  readonly from: string;
  readonly to: string;
}

/** The total-hook budget race in runner.ts, removed. */
const NO_RACE: Edit = {
  file: RUNNER,
  from: `    return await withBudget(
      prepareAndRun(handler, stdin, env, hookBudget(deadlineMs, timeoutMs)),
      budgetMs,
    );`,
  to: `    return await prepareAndRun(
      handler,
      stdin,
      env,
      hookBudget(deadlineMs, timeoutMs),
    );`,
};

/**
 * The spare-time bound maintenance reads, made unbounded.
 *
 * `now()` rather than `Date.now()`: hookBudget takes its clock as a parameter so
 * the reserve can be asserted without one (test/hook-reserve.test.ts), and this
 * quote has to match the source character for character or the script refuses to
 * run at all.
 */
const NO_SPARE: Edit = {
  file: RUNNER,
  from: `  spareMs: () =>
    Math.max(0, deadlineMs - now() - timeoutMs * HOOK_RESERVE_RATIO),`,
  to: `  spareMs: () => Number.MAX_SAFE_INTEGER,`,
};

/** The reserve defect that actually shipped. */
const NO_RESERVE: Edit = {
  file: CONSTANTS,
  from: "export const HOOK_RESERVE_RATIO = 1;",
  to: "export const HOOK_RESERVE_RATIO = 0;",
};

/** Ceilings pushed far out of reach, so only behaviour can fail a test. */
const NO_CEILINGS: Edit = {
  file: BUDGET_TEST,
  from: "const PROCESS_ALLOWANCE_MS = 600;",
  to: "const PROCESS_ALLOWANCE_MS = 60000;",
};

interface Variant {
  readonly label: string;
  readonly edits: readonly Edit[];
  readonly question: string;
}

const VARIANTS: readonly Variant[] = [
  { label: "baseline", edits: [], question: "the suite is green to begin with" },
  {
    label: "race removed",
    edits: [NO_RACE],
    question: "do the ceilings backstop `withBudget` disappearing?",
  },
  {
    label: "spare bound removed",
    edits: [NO_SPARE],
    question: "is an unbounded drain a clock failure or a behaviour failure?",
  },
  {
    label: "reserve removed (the shipped defect)",
    edits: [NO_RESERVE],
    question: "what does a REAL regression look like in the log?",
  },
  {
    label: "both bounds removed",
    edits: [NO_RACE, NO_SPARE],
    question: "what fails when each bound can no longer mask the other?",
  },
  {
    label: "both bounds removed, ceilings neutralised",
    edits: [NO_RACE, NO_SPARE, NO_CEILINGS],
    question: "does the suite still go red with only behaviour to speak?",
  },
];

/**
 * WHICH KIND of assertion failed, not just which test.
 *
 * The budget file's header rests a triage rule on that distinction — "every
 * failure is an elapsedMs ceiling and no behavioural assertion failed" means a
 * starved runner, anything else is a finding — and it attributed a KIND column
 * ("all BEHAVIOURAL", "3 ceilings and 1 behavioural") to this script, which used
 * to print only test names and pass/fail counts. A reader could not re-derive
 * the column from anything this emitted. It emits it now.
 *
 * The kind is read out of bun's own failure output rather than guessed: bun
 * prints the offending source line, a caret under the failing expression, an
 * `Expected:`/`Received:` pair, and then `(fail) <test name> [<wall time>]`. A
 * ceiling is the only assertion in that file made against `elapsedMs`.
 *
 * AND THE MILLISECONDS, which this script used not to print at all. The budget
 * file's header credited it with three ceiling figures and a behavioural range;
 * both are in the text bun hands us, and both were being parsed away. Each
 * failure now carries its wall time, a ceiling failure additionally carries
 * `elapsedMs N against an M ms ceiling`, and every variant ends with a
 * `ceilings beaten:` line in `elapsed/bound` form for the header to quote.
 */
type AssertionKind = "ceiling" | "behavioural" | "timeout";

interface Failure {
  readonly name: string;
  readonly assertion: string;
  readonly kind: AssertionKind;
  /**
   * The MILLISECONDS, which this script used to throw away.
   *
   * hook-time-budget.test.ts's header quoted three ceiling figures and a
   * behavioural range "per scripts/measure-ceiling-detection.ts" while this
   * script printed no milliseconds anywhere — the figures were real, but no
   * reader could re-derive them from the named source. Both numbers are already
   * in the output bun hands us and were simply being parsed away:
   *
   *   `Expected: < 1600` / `Received: 2584`   the ceiling and what beat it
   *   `(fail) … [2661.92ms]`                  the test's own wall time
   *
   * `boundMs`/`elapsedMs` are present only for a ceiling failure; a behavioural
   * one compares something that is not a clock, so only `durationMs` is
   * meaningful there.
   */
  readonly boundMs: number | null;
  readonly elapsedMs: number | null;
  readonly durationMs: number | null;
}

interface Result {
  readonly passed: number;
  readonly failed: number;
  readonly failures: readonly Failure[];
  readonly timedOut: boolean;
}

const COUNT_LINE = /^\s*(\d+)\s+(pass|fail)\s*$/;
/** `(fail) SessionStart … [2661.92ms]` — the trailing bracket is the wall time. */
const FAIL_LINE = /^\(fail\)\s+(.*?)(?:\s+\[([\d.]+)(m?s)\])?$/;
/** `Expected: < 1600` — the ceiling the assertion names. */
const EXPECTED_LINE = /^Expected:\s*<\s*([\d.]+)\s*$/;
/** `Received: 2584` — the elapsedMs that beat it. Non-numeric receiveds ignored. */
const RECEIVED_LINE = /^Received:\s*([\d.]+)\s*$/;
/** `434 |     expect(run.elapsedMs).toBeLessThan(CEILING);` — bun's excerpt. */
const SOURCE_LINE = /^\s*\d+\s\|\s(.*)$/;
/** The caret bun prints directly under the failing expression. */
const CARET_LINE = /^\s*\^\s*$/;
/** Bun colourises when it detects a TTY; strip it so the parse is stable. */
const ANSI = /\u001B\[[0-9;]*m/g;

const kindOf = (assertion: string): AssertionKind => {
  if (assertion === "") {
    return "timeout";
  }
  return assertion.includes("elapsedMs") ? "ceiling" : "behavioural";
};

const parse = (output: string): Result => {
  let passed = 0;
  let failed = 0;
  const failures: Failure[] = [];
  // The last numbered source line bun printed, and the one the caret marked.
  let lastSource = "";
  let markedAssertion = "";
  // The Expected/Received pair bun prints between the caret and the (fail) line.
  let boundMs: number | null = null;
  let elapsedMs: number | null = null;
  for (const raw of output.split("\n")) {
    const line = raw.replace(ANSI, "");
    const counted = COUNT_LINE.exec(line);
    if (counted?.[1] !== undefined) {
      const value = Number(counted[1]);
      if (counted[2] === "pass") {
        passed = value;
      } else {
        failed = value;
      }
      lastSource = "";
      continue;
    }
    if (CARET_LINE.test(line) && lastSource !== "") {
      markedAssertion = lastSource;
      lastSource = "";
      continue;
    }
    const expected = EXPECTED_LINE.exec(line.trim());
    if (expected?.[1] !== undefined) {
      boundMs = Number(expected[1]);
      continue;
    }
    const received = RECEIVED_LINE.exec(line.trim());
    if (received?.[1] !== undefined) {
      elapsedMs = Number(received[1]);
      continue;
    }
    const source = SOURCE_LINE.exec(line);
    if (source?.[1] !== undefined) {
      lastSource = source[1].trim();
      continue;
    }
    const failure = FAIL_LINE.exec(line.trim());
    if (failure?.[1] !== undefined) {
      const kind = kindOf(markedAssertion);
      const raw2 = failure[2];
      failures.push({
        name: failure[1],
        assertion: markedAssertion,
        kind,
        // Only a ceiling compares a clock; a behavioural Expected/Received pair
        // is `0`/`1` or `true`/`false` and would read as nonsense in ms.
        boundMs: kind === "ceiling" ? boundMs : null,
        elapsedMs: kind === "ceiling" ? elapsedMs : null,
        durationMs:
          raw2 === undefined
            ? null
            : Math.round(Number(raw2) * (failure[3] === "s" ? 1000 : 1)),
      });
      // Consumed: a test that times out prints no caret, and must not inherit
      // the previous test's assertion or the previous failure's numbers.
      markedAssertion = "";
      lastSource = "";
      boundMs = null;
      elapsedMs = null;
      continue;
    }
    lastSource = "";
  }
  return { passed, failed, failures, timedOut: output.includes("timed out after") };
};

const countKind = (result: Result, kind: AssertionKind): number =>
  result.failures.filter((failure) => failure.kind === kind).length;

/** "all BEHAVIOURAL" / "3 ceilings and 1 behavioural" — the header's column. */
const kindSummary = (result: Result): string => {
  if (result.failures.length === 0) {
    return "";
  }
  const parts = (["ceiling", "behavioural", "timeout"] as const)
    .map((kind) => [kind, countKind(result, kind)] as const)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${String(count)} ${kind}`);
  return `  [${parts.join(", ")}]`;
};

/** ` (2662 ms wall)` — bun's own per-test time, or nothing if it printed none. */
const wallTime = (failure: Failure): string =>
  failure.durationMs === null ? "" : ` (${String(failure.durationMs)} ms wall)`;

/** `elapsedMs 2584 against a 1600 ms ceiling` — a ceiling failure's two clocks. */
const clockLine = (failure: Failure): string => {
  if (failure.elapsedMs === null || failure.boundMs === null) {
    return "";
  }
  return `elapsedMs ${String(failure.elapsedMs)} against a ${String(failure.boundMs)} ms ceiling`;
};

/**
 * `2584/1600 2220/1400 2579/2200` — every ceiling this variant beat, in the
 * order the tests ran. This is the line hook-time-budget.test.ts's header quotes
 * for the both-bounds-removed row, so the figures there have a source that
 * prints them rather than a script that never could.
 */
const msSummary = (result: Result): string =>
  result.failures
    .filter((failure) => failure.elapsedMs !== null && failure.boundMs !== null)
    .map((failure) => `${String(failure.elapsedMs)}/${String(failure.boundMs)}`)
    .join(" ");

const runBudgetSuite = async (): Promise<Result> => {
  const proc = Bun.spawn({
    // process.execPath, not "bun": this has to work from a checkout where the
    // runtime is not on PATH, which is how it is invoked in CI.
    cmd: [process.execPath, "test", BUDGET_TEST],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return parse(`${stdout}\n${stderr}`);
};

const applyEdits = async (
  edits: readonly Edit[],
): Promise<ReadonlyMap<string, string>> => {
  const originals = new Map<string, string>();
  for (const edit of edits) {
    const path = resolve(REPO_ROOT, edit.file);
    if (!originals.has(edit.file)) {
      originals.set(edit.file, await Bun.file(path).text());
    }
    const current = await Bun.file(path).text();
    const occurrences = current.split(edit.from).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `${edit.file}: expected exactly 1 occurrence of the edited text, found ${String(occurrences)}. The code moved — update this script.`,
      );
    }
    await Bun.write(path, current.replace(edit.from, edit.to));
  }
  return originals;
};

const restore = async (originals: ReadonlyMap<string, string>): Promise<void> => {
  for (const [file, original] of originals) {
    await Bun.write(resolve(REPO_ROOT, file), original);
  }
};

const measure = async (variant: Variant): Promise<Result> => {
  const originals = await applyEdits(variant.edits);
  try {
    return await runBudgetSuite();
  } finally {
    await restore(originals);
  }
};

const main = async (): Promise<number> => {
  const out = process.stdout;
  out.write(`platform ${process.platform}/${process.arch}\n\n`);
  for (const variant of VARIANTS) {
    out.write(`· ${variant.label}\n  ${variant.question}\n`);
    const result = await measure(variant);
    out.write(
      `  ${String(result.passed)} pass / ${String(result.failed)} fail` +
        kindSummary(result) +
        `${result.timedOut ? "  (bun's per-test timeout fired)" : ""}\n`,
    );
    for (const failure of result.failures) {
      out.write(`    fail: ${failure.name}${wallTime(failure)}\n`);
      out.write(
        `          ${failure.kind.toUpperCase()}: ${failure.assertion === "" ? "(no assertion reached — the test timed out)" : failure.assertion}\n`,
      );
      const clock = clockLine(failure);
      if (clock !== "") {
        out.write(`          ${clock}\n`);
      }
    }
    const ceilings = msSummary(result);
    if (ceilings !== "") {
      out.write(`  ceilings beaten: ${ceilings}\n`);
    }
    out.write("\n");
  }
  return 0;
};

if (import.meta.main) {
  process.exit(await main());
}