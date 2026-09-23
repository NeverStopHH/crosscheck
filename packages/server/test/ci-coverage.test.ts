/**
 * THE `ci` COVERAGE SOURCE (spec 05 §3.6) — four states that are not ordered.
 *
 * `unavailable` is not a worse `complete`. A repo with no reporter has nothing
 * to be incomplete ABOUT, and the whole value of the field is that a reader can
 * tell "nobody told us" from "somebody told us and it was bad".
 *
 * Two inversions are what these tests actually guard, and both read the same
 * way — an empty set answering as success:
 *
 *   - a repo that has never reported must not read `complete` off an empty
 *     table, and
 *   - a ref this hub has not watched for a quorum's worth of commits expects
 *     NOTHING, so "every expected lane reported" is trivially true and must
 *     still not be `complete`.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  CI_FLAKE_BASE_RUNS,
  CI_LANE_QUORUM_COMMITS,
} from "../src/constants.ts";
import { readCiCoverage } from "../src/services/ci-coverage.ts";
import type { CiCoverage } from "../src/services/ci-coverage.ts";
import {
  TEST_CI_TOKEN,
  TEST_START_ISO,
  createTestHarness,
  jsonRequest,
} from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const REPO = "github.com/acme/api";
const DEFAULT_REF = "main";
// THE HARNESS CLOCK, not a later one. `ingestCiRun` clamps a report's
// timestamps to the hub's own now plus MAX_COMMIT_CLOCK_SKEW_MS — a sender
// may not claim a future this hub has not reached — so fixtures dated after
// it all collapse onto the same clamped instant and every ordering assertion
// reads the same value.
const NOW = new Date(TEST_START_ISO);
const RED = "packages/a.test.ts::suite::red one";

/** Distinct 7-hex shas, for the same reason `ci-delta.test.ts` needs them. */
const sha = (label: string): string => {
  let hash = 0x811c9dc5;
  for (const character of label) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 7);
};

const SUBJECT = sha("subject");

let harness: TestHarness | null = null;

afterEach(() => {
  harness = null;
});

interface RunSpec {
  readonly commit: string;
  readonly minutesAgo: number;
  readonly job?: string;
  readonly leg?: string;
  readonly ref?: string;
  readonly outcome?: "completed" | "truncated" | "crashed";
  readonly failing?: readonly string[];
  readonly rerunKind?: "none" | "same_job" | "new_attempt";
  readonly rerunOf?: string | null;
  readonly attempt?: number;
}

/** One run through the real ingest route, never a direct insert. */
const ingest = async (host: TestHarness, spec: RunSpec): Promise<string> => {
  const startedAt = new Date(NOW.getTime() - spec.minutesAgo * 60_000);
  const failing = spec.failing ?? [];
  const job = spec.job ?? "Test & Typecheck";
  const leg = spec.leg ?? "ubuntu-latest";
  const response = await host.app.request(
    "/api/ci-runs",
    jsonRequest("POST", TEST_CI_TOKEN, {
      repo: REPO,
      provider: "github_actions",
      workflow: "ci",
      job,
      leg,
      ref: spec.ref ?? DEFAULT_REF,
      commitSha: spec.commit,
      runAttempt: spec.attempt ?? 1,
      externalRunId: `ext-${spec.commit}-${job}-${leg}-${String(spec.minutesAgo)}`,
      rerunKind: spec.rerunKind ?? "none",
      rerunOf: spec.rerunOf ?? null,
      outcome: spec.outcome ?? "completed",
      tests: 100,
      failures: failing.length,
      skipped: 0,
      durationMs: 1000,
      ambiguousDropped: 0,
      startedAt: startedAt.toISOString(),
      collectedAt: startedAt.toISOString(),
      results: failing.map((testId) => ({
        testId,
        status: "failed" as const,
        durationMs: 12,
      })),
    }),
  );
  const body = (await response.json()) as {
    data?: { id: string };
    error?: { message: string };
  };
  if (body.data?.id === undefined) {
    throw new Error(`ingest refused: ${body.error?.message ?? "no id"}`);
  }
  return body.data.id;
};

/**
 * Enough earlier commits, each reporting the given lanes, to satisfy BOTH
 * windows this file's answers depend on.
 *
 * `CI_LANE_QUORUM_COMMITS` makes the lanes EXPECTED. But `awaitingRerun` is
 * computed by the delta ladder, whose own base window is
 * `CI_FLAKE_BASE_RUNS`, and with fewer than that every delta answers
 * `insufficient_base` — so a fixture sized to the quorum alone reported
 * `awaitingRerun: 0` and the coverage read `complete` over an unanswered
 * red. Both constants, taken at the larger: a fixture that satisfies one
 * bound and silently misses the other is a test measuring the wrong refusal.
 */
const establishLanes = async (
  host: TestHarness,
  legs: readonly string[],
  ref: string = DEFAULT_REF,
): Promise<void> => {
  const commits = Math.max(CI_LANE_QUORUM_COMMITS, CI_FLAKE_BASE_RUNS);
  for (let index = 0; index < commits; index += 1) {
    for (const leg of legs) {
      await ingest(host, {
        commit: sha(`history${String(index)}`),
        minutesAgo: 600 - index * 10,
        leg,
        ref,
      });
    }
  }
};

const coverageOf = async (
  host: TestHarness,
  commit: string = SUBJECT,
): Promise<CiCoverage> =>
  readCiCoverage({
    db: host.db,
    repo: REPO,
    commitSha: commit,
    defaultRef: DEFAULT_REF,
    now: NOW,
  });

describe("a hub nobody reports to says so, and never says it is fine", () => {
  test("a repo with no CI at all is unavailable, not complete", async () => {
    // THE DEFAULT, AND IT STAYS THE DEFAULT. Every count is zero here, and
    // "every expected lane reported" is trivially true of zero lanes — which
    // is exactly the reading this state exists to refuse.
    harness = await createTestHarness();

    const coverage = await coverageOf(harness);

    expect(coverage.state).toBe("unavailable");
    expect(coverage.lanesExpected).toBe(0);
    expect(coverage.collectedAt).toBeNull();
  });

  test("a repo that reports, at a commit nothing has arrived for, is unknown", async () => {
    // A DIFFERENT SENTENCE from the one above, and the remedy differs: here
    // there is a lane on the way; above there is nothing to wait for.
    harness = await createTestHarness();
    await establishLanes(harness, ["ubuntu-latest"]);

    const coverage = await coverageOf(harness, sha("nothing-here"));

    expect(coverage.state).toBe("unknown");
  });
});

describe("expectation is read off behaviour, never declared", () => {
  test("a ref watched for less than the quorum expects nothing, and is unknown", async () => {
    // THE SECOND INVERSION. With no expectation, `lanesReported === expected`
    // holds trivially — so a naive `complete` would be reported for a hub that
    // has no idea what should have run. An empty set is not a satisfied one.
    harness = await createTestHarness();
    for (let index = 0; index < CI_LANE_QUORUM_COMMITS - 1; index += 1) {
      await ingest(harness, {
        commit: sha(`short${String(index)}`),
        minutesAgo: 600 - index * 10,
      });
    }
    await ingest(harness, { commit: SUBJECT, minutesAgo: 5 });

    const coverage = await coverageOf(harness);

    expect(coverage.state).toBe("unknown");
    expect(coverage.lanesExpected).toBe(0);
    expect(coverage.lanesReported).toBe(0);
  });

  test("every expected lane reporting is complete", async () => {
    harness = await createTestHarness();
    await establishLanes(harness, ["ubuntu-latest", "macos-latest"]);
    await ingest(harness, {
      commit: SUBJECT,
      minutesAgo: 5,
      leg: "ubuntu-latest",
    });
    await ingest(harness, {
      commit: SUBJECT,
      minutesAgo: 5,
      leg: "macos-latest",
    });

    const coverage = await coverageOf(harness);

    expect(coverage.state).toBe("complete");
    expect(coverage.lanesExpected).toBe(2);
    expect(coverage.lanesReported).toBe(2);
    expect(coverage.collectedAt).toBe("2026-07-24T08:55:00.000Z");
  });

  test("a silent expected lane is incomplete, and the counts say which", async () => {
    harness = await createTestHarness();
    await establishLanes(harness, ["ubuntu-latest", "macos-latest"]);
    await ingest(harness, {
      commit: SUBJECT,
      minutesAgo: 5,
      leg: "ubuntu-latest",
    });

    const coverage = await coverageOf(harness);

    expect(coverage.state).toBe("incomplete");
    expect(coverage.lanesExpected).toBe(2);
    expect(coverage.lanesReported).toBe(1);
  });

  test("a lane that ran once long ago is not expected forever", async () => {
    // INTERSECTION, NOT UNION. A union would make a deleted job's silence a
    // permanent `incomplete`, which trains a team to ignore the field — and a
    // field nobody reads is worse than no field.
    harness = await createTestHarness();
    await ingest(harness, {
      commit: sha("ancient"),
      minutesAgo: 900,
      leg: "windows-latest",
    });
    await establishLanes(harness, ["ubuntu-latest"]);
    await ingest(harness, {
      commit: SUBJECT,
      minutesAgo: 5,
      leg: "ubuntu-latest",
    });

    const coverage = await coverageOf(harness);

    expect(coverage.lanesExpected).toBe(1);
    expect(coverage.state).toBe("complete");
  });
});

describe("a run that cannot assert what it ran is not a reporting lane", () => {
  test("a truncated lane is counted and keeps the commit incomplete", async () => {
    // A run that filled the row cap can never establish that any test was
    // green, so it arrived without answering — which is not the same as
    // having answered well.
    harness = await createTestHarness();
    await establishLanes(harness, ["ubuntu-latest"]);
    await ingest(harness, {
      commit: SUBJECT,
      minutesAgo: 5,
      outcome: "truncated",
      failing: [RED],
    });

    const coverage = await coverageOf(harness);

    expect(coverage.state).toBe("incomplete");
    expect(coverage.truncatedLanes).toBe(1);
    expect(coverage.lanesReported).toBe(1);
  });

  test("a crashed lane is counted the same way", async () => {
    harness = await createTestHarness();
    await establishLanes(harness, ["ubuntu-latest"]);
    await ingest(harness, {
      commit: SUBJECT,
      minutesAgo: 5,
      outcome: "crashed",
    });

    const coverage = await coverageOf(harness);

    expect(coverage.state).toBe("incomplete");
    expect(coverage.truncatedLanes).toBe(1);
  });
});

describe("a red nobody has measured twice leaves the question open", () => {
  test("awaiting a re-run is incomplete even with every lane reporting", async () => {
    // THE QUESTION CI WAS ASKED — did this commit break something — has no
    // answer while the only measurement is one red run. Reporting `complete`
    // there would say it does have one.
    harness = await createTestHarness();
    await establishLanes(harness, ["ubuntu-latest"]);
    await ingest(harness, { commit: SUBJECT, minutesAgo: 5, failing: [RED] });

    const coverage = await coverageOf(harness);

    expect(coverage.state).toBe("incomplete");
    expect(coverage.lanesReported).toBe(coverage.lanesExpected);
    expect(coverage.truncatedLanes).toBe(0);
    expect(coverage.awaitingRerun).toBe(1);
  });

  test("once it is measured twice, the lane is complete again", async () => {
    // The control. The verdict may well be `confirmed` — that is a fact about
    // the commit, not a gap in coverage. Coverage asks whether the hub HEARD
    // enough, never whether it liked what it heard.
    harness = await createTestHarness();
    await establishLanes(harness, ["ubuntu-latest"]);
    const primary = await ingest(harness, {
      commit: SUBJECT,
      minutesAgo: 30,
      failing: [RED],
    });
    await ingest(harness, {
      commit: SUBJECT,
      minutesAgo: 5,
      attempt: 2,
      rerunKind: "new_attempt",
      rerunOf: primary,
      failing: [RED],
    });

    const coverage = await coverageOf(harness);

    expect(coverage.awaitingRerun).toBe(0);
    expect(coverage.state).toBe("complete");
  });
});
