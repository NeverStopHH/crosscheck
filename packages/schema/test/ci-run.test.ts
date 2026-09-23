/**
 * The CI wire's own refusals (spec 05 §3.2, §3.7).
 *
 * Every assertion here is about something the HUB cannot check later. The hub
 * holds no repository, so it cannot tell a head sha from a merge sha; it never
 * saw the runner, so it cannot tell a complete list from a clipped one. What
 * the wire can do is refuse the shapes that are internally contradictory —
 * a re-run pointing nowhere, a completed run that filled its own cap, more
 * failures than tests — and those refusals are the only place they can happen.
 */
import { describe, expect, test } from "bun:test";

import {
  CI_MAX_TEST_ROWS,
  CI_PROVIDERS,
  CI_RERUN_KINDS,
  CI_RUN_OUTCOMES,
  CI_TEST_STATUSES,
  CiRunReportSchema,
  MAX_CI_LANE_FIELD_CHARS,
  MAX_CI_TEST_ID_CHARS,
} from "../src/index.ts";

const validRun = (extra: Record<string, unknown> = {}): unknown => ({
  repo: "github.com/acme/api",
  provider: "github_actions",
  workflow: "ci",
  job: "Test & Typecheck",
  leg: "ubuntu-latest",
  ref: "main",
  commitSha: "a1b2c3d4",
  runAttempt: 1,
  externalRunId: "35572434868",
  rerunKind: "none",
  rerunOf: null,
  outcome: "completed",
  tests: 3187,
  failures: 1,
  skipped: 3,
  durationMs: 501_310,
  startedAt: "2026-09-21T10:15:00.000Z",
  collectedAt: "2026-09-21T10:23:21.000Z",
  ambiguousDropped: 0,
  results: [
    {
      testId:
        "packages/server/test/claim-validity.test.ts::claim validity::a rejected approach is judged by its code",
      status: "failed",
      durationMs: 346,
    },
  ],
  ...extra,
});

describe("the CI run wire", () => {
  test("a well-formed report parses", () => {
    expect(CiRunReportSchema.safeParse(validRun()).success).toBe(true);
  });

  test("an empty leg is a value, not a missing field", () => {
    // Arrange: a job with no matrix. An OPTIONAL leg would let the same lane
    // arrive under two spellings, and two spellings of one lane is a base
    // window that silently splits in half.
    expect(CiRunReportSchema.safeParse(validRun({ leg: "" })).success).toBe(true);
    const { leg: _dropped, ...withoutLeg } = validRun() as Record<string, unknown>;
    expect(CiRunReportSchema.safeParse(withoutLeg).success).toBe(false);
  });

  test("a commit that is not an object name is refused", () => {
    for (const bad of ["", "HEAD", "main", "--upload-pack=x", "zzzzzzz", "a1b2c3"]) {
      expect(CiRunReportSchema.safeParse(validRun({ commitSha: bad })).success).toBe(
        false,
      );
    }
  });

  test("a re-run must point somewhere, and a primary run must not", () => {
    // Both directions: a `same_job` with no target could never be joined to
    // the run it re-ran, and a `none` carrying a target would let a primary
    // run silently clear another lane's red.
    expect(
      CiRunReportSchema.safeParse(validRun({ rerunKind: "same_job", rerunOf: null }))
        .success,
    ).toBe(false);
    expect(
      CiRunReportSchema.safeParse(validRun({ rerunKind: "none", rerunOf: "cir_x" }))
        .success,
    ).toBe(false);
    expect(
      CiRunReportSchema.safeParse(
        validRun({ rerunKind: "new_attempt", rerunOf: "cir_x" }),
      ).success,
    ).toBe(true);
  });

  test("a run that filled the row cap cannot call itself completed", () => {
    // THE ONE CONTRADICTION THE WIRE CAN SEE. A full list is indistinguishable
    // from a clipped one once it reaches the hub, and `completed` is what
    // licenses "every test not in this list was green". So the wire refuses
    // the combination rather than trusting the reporter to downgrade itself.
    const full = Array.from({ length: CI_MAX_TEST_ROWS }, (_unused, index) => ({
      testId: `packages/x.test.ts::suite::case ${String(index)}`,
      status: "failed",
      durationMs: 1,
    }));
    expect(
      CiRunReportSchema.safeParse(validRun({ outcome: "completed", results: full }))
        .success,
    ).toBe(false);
    expect(
      CiRunReportSchema.safeParse(validRun({ outcome: "truncated", results: full }))
        .success,
    ).toBe(true);
    expect(
      CiRunReportSchema.safeParse(
        validRun({ outcome: "completed", results: full.slice(0, -1) }),
      ).success,
    ).toBe(true);
  });

  test("the row list is capped", () => {
    const over = Array.from({ length: CI_MAX_TEST_ROWS + 1 }, (_unused, index) => ({
      testId: `packages/x.test.ts::suite::case ${String(index)}`,
      status: "failed",
      durationMs: 1,
    }));
    expect(
      CiRunReportSchema.safeParse(validRun({ outcome: "truncated", results: over }))
        .success,
    ).toBe(false);
  });

  test("counts cannot contradict each other", () => {
    // EACH CASE HOLDS THE OTHER COUNT DOWN, or they are not two cases. The
    // first draft left the fixture's `skipped: 3` in place while lowering
    // `tests` to 2, so the skipped refusal fired on the failures case too and
    // the failures refusal was never exercised — proven by mutating it away
    // and watching this test stay green.
    expect(
      CiRunReportSchema.safeParse(validRun({ tests: 2, failures: 3, skipped: 0 }))
        .success,
    ).toBe(false);
    expect(
      CiRunReportSchema.safeParse(validRun({ tests: 2, failures: 0, skipped: 3 }))
        .success,
    ).toBe(false);
    // The control: at the boundary both are legal.
    expect(
      CiRunReportSchema.safeParse(validRun({ tests: 3, failures: 3, skipped: 0 }))
        .success,
    ).toBe(true);
  });

  test("the lane fields and the test id are bounded", () => {
    expect(
      CiRunReportSchema.safeParse(
        validRun({ job: "j".repeat(MAX_CI_LANE_FIELD_CHARS) }),
      ).success,
    ).toBe(true);
    expect(
      CiRunReportSchema.safeParse(
        validRun({ job: "j".repeat(MAX_CI_LANE_FIELD_CHARS + 1) }),
      ).success,
    ).toBe(false);
    expect(
      CiRunReportSchema.safeParse(
        validRun({
          results: [
            {
              testId: "t".repeat(MAX_CI_TEST_ID_CHARS + 1),
              status: "failed",
              durationMs: 1,
            },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  test("the enums are closed, and each value means something different", () => {
    // A provider with no reporter must be REFUSED at the wire rather than
    // stored and later rendered as `unknown`, which reads as "nothing has
    // arrived yet" for a repo where nothing ever can.
    expect(CiRunReportSchema.safeParse(validRun({ provider: "circleci" })).success).toBe(
      false,
    );
    expect(CiRunReportSchema.safeParse(validRun({ outcome: "failed" })).success).toBe(
      false,
    );
    expect(
      CiRunReportSchema.safeParse(
        validRun({ results: [{ testId: "a::b::c", status: "passed", durationMs: 1 }] }),
      ).success,
    ).toBe(false);

    expect([...CI_PROVIDERS]).toEqual(["github_actions"]);
    expect([...CI_RERUN_KINDS]).toEqual(["none", "same_job", "new_attempt"]);
    expect([...CI_RUN_OUTCOMES]).toEqual(["completed", "truncated", "crashed"]);
    expect([...CI_TEST_STATUSES]).toEqual(["failed", "errored", "skipped"]);
  });

  test("a skipped test is stored, not dropped", () => {
    // A test that stops running looks GREEN to any rule built on absence, so
    // `skipped` is a non-green status and travels like the other two.
    expect(
      CiRunReportSchema.safeParse(
        validRun({
          results: [{ testId: "a::b::c", status: "skipped", durationMs: 0 }],
        }),
      ).success,
    ).toBe(true);
  });
});
