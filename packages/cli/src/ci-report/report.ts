/**
 * FROM A PARSED RUN TO THE WIRE (spec 05 §3.3, §3.4, §3.7).
 *
 *   test_id = "<file>::<describe chain, OUTERMOST first, joined by ' > '>::<name>"
 *
 * A top-level test has an EMPTY middle segment, so both separators are always
 * present. `line` is never in the id — it moves on any edit above the test.
 *
 * ONLY NON-GREEN ROWS TRAVEL, and that is a contract rather than a saving: a
 * run row asserts *these are all the non-green tests I ran*, and the hub can
 * lean on that assertion only when the run `completed`. A list that HIT
 * `CI_MAX_TEST_ROWS` is therefore `truncated` here, at the source — such a run
 * can never establish that any test was green, and the wire schema refuses a
 * `completed` run that filled the cap. `skipped` is a non-green row: a test
 * that stops running looks green to any rule built on absence.
 *
 * A DUPLICATED ID IS DROPPED, BOTH COPIES, AND COUNTED. Two same-named tests
 * under one describe in one file emit identical name and classname (measured,
 * §3.4), differing only in `line` and `time`. A positional ordinal would be
 * stable only until somebody reordered the file, and a test that cannot be
 * identified cannot carry a verdict — so neither copy is sent, and
 * `ambiguousDropped` says how many identities were lost. The key is the id
 * AS SENT: two ids that agree only after the bound cut, or two describe
 * chains that spell the same id, are the same ambiguity on the hub and are
 * treated as one here.
 */
import { CI_MAX_TEST_ROWS, MAX_CI_TEST_ID_CHARS } from "@crosscheck/schema";
import type { CiRunReport, CiTestResult } from "@crosscheck/schema";

import type { JunitCase, JunitRun } from "./junit.ts";

/** The one provider that has a reporter (`CI_PROVIDERS`); this is it. */
const CI_PROVIDER = "github_actions";

const ID_SEPARATOR = "::";
const CHAIN_SEPARATOR = " > ";

/** UTF-16 high-surrogate range: a cut landing after one leaves half a character. */
const HIGH_SURROGATE_FLOOR = 0xd800;
const HIGH_SURROGATE_CEILING = 0xdbff;

export interface CiReportLane {
  readonly repo: string;
  readonly workflow: string;
  readonly job: string;
  readonly leg: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly runAttempt: number;
  readonly externalRunId: string;
}

export type CiReportRerun =
  | { readonly kind: "none" }
  | { readonly kind: "same_job"; readonly of: string };

export interface BuiltCiRunReport {
  readonly body: CiRunReport;
  /** Files with a failed or errored test, first seen first — what to re-run. */
  readonly failedFiles: readonly string[];
  /** Non-green rows BEFORE the cap, so a truncation can be said with its size. */
  readonly nonGreen: number;
}

/**
 * Cut at the wire bound, and never through a surrogate pair: the bound is in
 * UTF-16 units (what the schema's `max` counts), and a lone high surrogate
 * would be a character nobody wrote.
 */
const cutToBound = (id: string): string => {
  if (id.length <= MAX_CI_TEST_ID_CHARS) {
    return id;
  }
  const cut = id.slice(0, MAX_CI_TEST_ID_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= HIGH_SURROGATE_FLOOR && last <= HIGH_SURROGATE_CEILING
    ? cut.slice(0, -1)
    : cut;
};

export const testIdOf = (testCase: JunitCase): string =>
  cutToBound(
    [testCase.file, testCase.chain.join(CHAIN_SEPARATOR), testCase.name].join(
      ID_SEPARATOR,
    ),
  );

const idOccurrences = (
  cases: readonly JunitCase[],
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const testCase of cases) {
    const id = testIdOf(testCase);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
};

const isRed = (testCase: JunitCase): boolean =>
  testCase.status === "failed" || testCase.status === "errored";

const isNonGreen = (testCase: JunitCase): boolean =>
  testCase.status !== "passed";

const toRow = (testCase: JunitCase): CiTestResult | null =>
  testCase.status === "passed"
    ? null
    : {
        testId: testIdOf(testCase),
        status: testCase.status,
        durationMs: testCase.durationMs,
      };

/** Distinct files with a red test, in the order the runner reported them. */
const failedFilesOf = (cases: readonly JunitCase[]): readonly string[] => [
  ...new Set(cases.filter(isRed).map((testCase) => testCase.file)),
];

const laneFields = (lane: CiReportLane, rerun: CiReportRerun) => ({
  repo: lane.repo,
  provider: CI_PROVIDER,
  workflow: lane.workflow,
  job: lane.job,
  leg: lane.leg,
  ref: lane.ref,
  commitSha: lane.commitSha,
  runAttempt: lane.runAttempt,
  externalRunId: lane.externalRunId,
  rerunKind: rerun.kind,
  rerunOf: rerun.kind === "none" ? null : rerun.of,
});

export interface BuildCiRunReportInput {
  readonly run: JunitRun;
  readonly lane: CiReportLane;
  readonly rerun: CiReportRerun;
  /**
   * The junit file's mtime — the moment the runner finished writing, and the
   * only clock bun's report carries (it emits no `timestamp`). The run started
   * one suite duration earlier. Both are clamped on the hub anyway (§3.2).
   */
  readonly junitWrittenAt: Date;
  readonly collectedAt: Date;
}

export const buildCiRunReport = (
  input: BuildCiRunReportInput,
): BuiltCiRunReport => {
  const { run, lane, rerun } = input;
  const counts = idOccurrences(run.cases);
  const unique = run.cases.filter(
    (testCase) => (counts.get(testIdOf(testCase)) ?? 0) === 1,
  );
  const ambiguousDropped = [...counts.values()].filter((n) => n > 1).length;
  const nonGreen = unique
    .filter(isNonGreen)
    .map(toRow)
    .filter((row): row is CiTestResult => row !== null);
  const truncated = nonGreen.length >= CI_MAX_TEST_ROWS;
  return {
    body: {
      ...laneFields(lane, rerun),
      outcome: truncated ? "truncated" : "completed",
      tests: run.tests,
      failures: run.failures,
      skipped: run.skipped,
      durationMs: run.durationMs,
      startedAt: new Date(
        input.junitWrittenAt.getTime() - run.durationMs,
      ).toISOString(),
      collectedAt: input.collectedAt.toISOString(),
      ambiguousDropped,
      results: nonGreen.slice(0, CI_MAX_TEST_ROWS),
    },
    failedFiles: failedFilesOf(run.cases),
    nonGreen: nonGreen.length,
  };
};

export interface BuildCrashedCiRunReportInput {
  readonly lane: CiReportLane;
  readonly rerun: CiReportRerun;
  readonly collectedAt: Date;
}

/**
 * The lane RAN and produced nothing readable — a missing or half-written
 * junit file. Zero of everything, `crashed`, so the hub sees a run that said
 * nothing rather than a lane that never reported: the two look identical
 * from the outside and mean different things (§2, principle 4).
 */
export const buildCrashedCiRunReport = (
  input: BuildCrashedCiRunReportInput,
): CiRunReport => ({
  ...laneFields(input.lane, input.rerun),
  outcome: "crashed",
  tests: 0,
  failures: 0,
  skipped: 0,
  durationMs: 0,
  startedAt: input.collectedAt.toISOString(),
  collectedAt: input.collectedAt.toISOString(),
  ambiguousDropped: 0,
  results: [],
});
