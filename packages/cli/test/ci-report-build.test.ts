/**
 * FROM A PARSED RUN TO THE WIRE (spec 05 §3.3, §3.4, §3.7).
 *
 * Three contracts the reporter owns and the hub cannot check for it:
 *
 *   - ONLY NON-GREEN ROWS travel, and `skipped` is one of them — a test that
 *     stops running looks green to any rule built on absence;
 *   - a DUPLICATED `(file, chain, name)` triple is dropped, BOTH copies, and
 *     counted in `ambiguousDropped` (CI-6) — never given a positional ordinal;
 *   - a list that HIT `CI_MAX_TEST_ROWS` is `truncated`, because such a run can
 *     never establish that any test was green (CI-2's rule, at the source).
 */
import { describe, expect, test } from "bun:test";

import {
  CI_MAX_TEST_ROWS,
  CiRunReportSchema,
  MAX_CI_TEST_ID_CHARS,
} from "@crosscheck/schema";

import {
  buildCiRunReport,
  buildCrashedCiRunReport,
  testIdOf,
} from "../src/ci-report/report.ts";
import type { CiReportLane } from "../src/ci-report/report.ts";
import type { JunitCase, JunitRun } from "../src/ci-report/junit.ts";

const LANE: CiReportLane = {
  repo: "github.com/acme/api",
  workflow: "CI",
  job: "test",
  leg: "ubuntu-latest",
  ref: "main",
  commitSha: "a1b2c3d4e5f6a7b8",
  runAttempt: 1,
  externalRunId: "35572434868",
};
const WRITTEN_AT = new Date("2026-07-24T08:59:00.000Z");
const COLLECTED_AT = new Date("2026-07-24T08:59:30.000Z");
const RUN_DURATION_MS = 100;

const aCase = (overrides: Partial<JunitCase> = {}): JunitCase => ({
  file: "packages/a.test.ts",
  chain: [],
  name: "green",
  status: "passed",
  durationMs: 1,
  ...overrides,
});

const isRed = (entry: JunitCase): boolean =>
  entry.status === "failed" || entry.status === "errored";

const runOf = (cases: readonly JunitCase[]): JunitRun => ({
  tests: cases.length,
  failures: cases.filter(isRed).length,
  skipped: cases.filter((entry) => entry.status === "skipped").length,
  durationMs: RUN_DURATION_MS,
  cases,
});

const build = (cases: readonly JunitCase[]) =>
  buildCiRunReport({
    run: runOf(cases),
    lane: LANE,
    rerun: { kind: "none" },
    junitWrittenAt: WRITTEN_AT,
    collectedAt: COLLECTED_AT,
  });

describe("test_id is file :: chain :: name, both separators always present", () => {
  test("a nested test joins its chain outermost-first with ' > '", () => {
    expect(
      testIdOf(aCase({ chain: ["outer", "inner"], name: "nested red" })),
    ).toBe("packages/a.test.ts::outer > inner::nested red");
  });

  test("a top-level test has an EMPTY middle segment", () => {
    expect(testIdOf(aCase({ name: "top" }))).toBe("packages/a.test.ts::::top");
  });

  test("a describe named `a > b` stays one segment in the id", () => {
    expect(testIdOf(aCase({ chain: ["a > b"], name: "t" }))).toBe(
      "packages/a.test.ts::a > b::t",
    );
  });

  test("an id over the wire bound is cut at MAX_CI_TEST_ID_CHARS, deterministically", () => {
    const id = testIdOf(aCase({ name: "n".repeat(MAX_CI_TEST_ID_CHARS) }));

    expect(id.length).toBe(MAX_CI_TEST_ID_CHARS);
    expect(id.startsWith("packages/a.test.ts::::nnn")).toBe(true);
  });
});

describe("only non-green rows travel, and skipped is one of them", () => {
  test("a green test produces no row; a failed and a skipped one do", () => {
    const built = build([
      aCase({ name: "green" }),
      aCase({ name: "red", status: "failed", durationMs: 12 }),
      aCase({ name: "off", status: "skipped" }),
    ]);

    expect(built.body.results).toEqual([
      { testId: "packages/a.test.ts::::red", status: "failed", durationMs: 12 },
      { testId: "packages/a.test.ts::::off", status: "skipped", durationMs: 1 },
    ]);
    expect(built.body.outcome).toBe("completed");
  });

  test("an errored test is stored as `errored`", () => {
    const built = build([aCase({ name: "boom", status: "errored" })]);

    expect(built.body.results.map((row) => row.status)).toEqual(["errored"]);
  });

  test("a row carries exactly testId, status and durationMs — nothing else", () => {
    const built = build([aCase({ name: "red", status: "failed" })]);

    expect(Object.keys(built.body.results[0] ?? {}).sort()).toEqual([
      "durationMs",
      "status",
      "testId",
    ]);
  });
});

describe("an ambiguous test is dropped and said (CI-6)", () => {
  test("two identical triples, one green and one red, yield ZERO rows and ambiguousDropped = 1", () => {
    // The measured fixture: two `dup name` tests inside `outer`, identical in
    // name and classname, differing only in `line`.
    const built = build([
      aCase({ chain: ["outer"], name: "dup name", status: "passed" }),
      aCase({ chain: ["outer"], name: "dup name", status: "failed" }),
      aCase({ chain: ["outer"], name: "kept", status: "failed" }),
    ]);

    expect(built.body.results.map((row) => row.testId)).toEqual([
      "packages/a.test.ts::outer::kept",
    ]);
    expect(built.body.ambiguousDropped).toBe(1);
  });

  test("two DIFFERENT duplicated triples count as two, however many copies each has", () => {
    const built = build([
      aCase({ name: "x", status: "failed" }),
      aCase({ name: "x", status: "failed" }),
      aCase({ name: "x", status: "failed" }),
      aCase({ name: "y", status: "passed" }),
      aCase({ name: "y", status: "passed" }),
    ]);

    expect(built.body.results).toEqual([]);
    expect(built.body.ambiguousDropped).toBe(2);
  });

  test("same name under DIFFERENT describes is two tests, not an ambiguity", () => {
    const built = build([
      aCase({ chain: ["a"], name: "same", status: "failed" }),
      aCase({ chain: ["b"], name: "same", status: "failed" }),
    ]);

    expect(built.body.results).toHaveLength(2);
    expect(built.body.ambiguousDropped).toBe(0);
  });

  test("two ids that collide only AFTER the bound cut are ambiguous too", () => {
    const stem = "n".repeat(MAX_CI_TEST_ID_CHARS);
    const built = build([
      aCase({ name: `${stem}1`, status: "failed" }),
      aCase({ name: `${stem}2`, status: "failed" }),
    ]);

    expect(built.body.results).toEqual([]);
    expect(built.body.ambiguousDropped).toBe(1);
  });
});

describe("a list that hit the row cap is truncated (CI-2 at the source)", () => {
  const reds = (count: number): JunitCase[] =>
    Array.from({ length: count }, (_, index) =>
      aCase({ name: `red ${String(index)}`, status: "failed" }),
    );

  test("exactly CI_MAX_TEST_ROWS non-green rows is `truncated`, and the list is the cap", () => {
    const built = build(reds(CI_MAX_TEST_ROWS));

    expect(built.body.outcome).toBe("truncated");
    expect(built.body.results).toHaveLength(CI_MAX_TEST_ROWS);
    expect(CiRunReportSchema.safeParse(built.body).success).toBe(true);
  });

  test("one under the cap is `completed`", () => {
    const built = build(reds(CI_MAX_TEST_ROWS - 1));

    expect(built.body.outcome).toBe("completed");
    expect(built.body.results).toHaveLength(CI_MAX_TEST_ROWS - 1);
  });

  test("well over the cap still sends exactly the cap, never more", () => {
    const built = build(reds(CI_MAX_TEST_ROWS * 2));

    expect(built.body.results).toHaveLength(CI_MAX_TEST_ROWS);
    expect(built.body.outcome).toBe("truncated");
    expect(built.nonGreen).toBe(CI_MAX_TEST_ROWS * 2);
  });
});

describe("the body is the lane, the totals and the clock — and validates on the wire", () => {
  test("lane, provider, totals and timestamps are carried; started_at is derived from the file's own clock", () => {
    const built = build([aCase({ name: "red", status: "failed" })]);

    expect(built.body.provider).toBe("github_actions");
    expect(built.body.repo).toBe(LANE.repo);
    expect(built.body.workflow).toBe("CI");
    expect(built.body.job).toBe("test");
    expect(built.body.leg).toBe("ubuntu-latest");
    expect(built.body.ref).toBe("main");
    expect(built.body.commitSha).toBe(LANE.commitSha);
    expect(built.body.runAttempt).toBe(1);
    expect(built.body.externalRunId).toBe("35572434868");
    expect(built.body.rerunKind).toBe("none");
    expect(built.body.rerunOf).toBeNull();
    expect(built.body.tests).toBe(1);
    expect(built.body.failures).toBe(1);
    expect(built.body.skipped).toBe(0);
    expect(built.body.durationMs).toBe(RUN_DURATION_MS);
    // The junit file's mtime is when the runner finished; the run started one
    // duration earlier. bun writes no timestamp, so this is the only clock.
    expect(built.body.startedAt).toBe(
      new Date(WRITTEN_AT.getTime() - RUN_DURATION_MS).toISOString(),
    );
    expect(built.body.collectedAt).toBe(COLLECTED_AT.toISOString());
    expect(CiRunReportSchema.safeParse(built.body).success).toBe(true);
  });

  test("a same_job re-run names the run it repeats", () => {
    const built = buildCiRunReport({
      run: runOf([aCase()]),
      lane: LANE,
      rerun: { kind: "same_job", of: "cir_0123456789abcdef0123456789abcdef" },
      junitWrittenAt: WRITTEN_AT,
      collectedAt: COLLECTED_AT,
    });

    expect(built.body.rerunKind).toBe("same_job");
    expect(built.body.rerunOf).toBe("cir_0123456789abcdef0123456789abcdef");
    expect(CiRunReportSchema.safeParse(built.body).success).toBe(true);
  });

  test("failedFiles lists each file with a failed or errored test once, in first-seen order; skipped alone does not count", () => {
    const built = build([
      aCase({ file: "packages/b.test.ts", name: "b1", status: "failed" }),
      aCase({ file: "packages/a.test.ts", name: "a1", status: "errored" }),
      aCase({ file: "packages/b.test.ts", name: "b2", status: "failed" }),
      aCase({ file: "packages/c.test.ts", name: "c1", status: "skipped" }),
      aCase({ file: "packages/d.test.ts", name: "d1", status: "passed" }),
    ]);

    expect(built.failedFiles).toEqual(["packages/b.test.ts", "packages/a.test.ts"]);
  });
});

describe("a run that produced no readable report is `crashed`, with nothing to say about any test", () => {
  test("zero totals, no rows, both timestamps at collection", () => {
    const body = buildCrashedCiRunReport({
      lane: LANE,
      rerun: { kind: "none" },
      collectedAt: COLLECTED_AT,
    });

    expect(body.outcome).toBe("crashed");
    expect(body.tests).toBe(0);
    expect(body.failures).toBe(0);
    expect(body.skipped).toBe(0);
    expect(body.durationMs).toBe(0);
    expect(body.results).toEqual([]);
    expect(body.ambiguousDropped).toBe(0);
    expect(body.startedAt).toBe(COLLECTED_AT.toISOString());
    expect(body.collectedAt).toBe(COLLECTED_AT.toISOString());
    expect(CiRunReportSchema.safeParse(body).success).toBe(true);
  });
});
