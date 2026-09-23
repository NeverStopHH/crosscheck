/**
 * THE FLAKE FILTER'S LADDER (spec 05 §3.5), rung by rung — and the order.
 *
 * `ciBehaviorDeltas` answers one question: did THIS commit break this test, or
 * was the test already unreliable? Five reasons can be the answer, and only one
 * of them accuses anybody. The tests below pin each rung to the situation that
 * must produce it, and then pin the ORDER — because every wrong order points
 * the same way, toward `confirmed`.
 *
 * The order test is the one that matters most and is easiest to lose: a hub
 * with no history has an EMPTY base window, so "was this test failing before?"
 * finds nothing and reads as "no, it was green". That is an absence being read
 * as evidence, in the accusing direction, and only `insufficient_base` coming
 * first prevents it.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { CI_FLAKE_BASE_RUNS } from "../src/constants.ts";
import { ciBehaviorDeltas } from "../src/services/ci-delta.ts";
import type { CiBehaviorDelta } from "../src/services/ci-delta.ts";
import { TEST_CI_TOKEN, createTestHarness, jsonRequest } from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const REPO = "github.com/acme/api";
const DEFAULT_REF = "main";
const NOW = new Date("2026-07-24T12:00:00.000Z");
const RED = "packages/a.test.ts::suite::red one";
const OTHER = "packages/b.test.ts::suite::other";

/**
 * A commit sha the wire will accept — 7 hex characters, the shape
 * `CiRunReportSchema` requires. Fixtures that spelled them "base0" and "c1"
 * were refused by the ingest route, which is the route doing its job: a
 * sha-shaped field is the only thing a later reader can hand to git.
 *
 * DETERMINISTIC AND COLLISION-FREE, both load-bearing. A first attempt sliced
 * the label's own bytes and mapped every `base<n>` onto the same seven
 * characters — so a five-commit window became a one-commit window and every
 * rung below answered `insufficient_base`. The window is keyed on DISTINCT
 * commit, so a fixture that cannot produce distinct shas cannot exercise the
 * thing it is testing.
 */
const sha = (label: string): string => {
  let hash = 0x811c9dc5;
  for (const character of label) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 7);
};

const SUBJECT = sha("subject");

const LANE = {
  repo: REPO,
  provider: "github_actions" as const,
  workflow: "ci",
  job: "Test & Typecheck",
  leg: "ubuntu-latest",
  ref: DEFAULT_REF,
};

let harness: TestHarness | null = null;

afterEach(() => {
  harness = null;
});

interface RunSpec {
  readonly commit: string;
  /** Minutes before NOW, so a fixture reads as an age rather than a date. */
  readonly minutesAgo: number;
  readonly ref?: string;
  readonly rerunKind?: "none" | "same_job" | "new_attempt";
  readonly rerunOf?: string | null;
  readonly outcome?: "completed" | "crashed";
  readonly failing?: readonly string[];
  readonly attempt?: number;
}

/**
 * One run, through the REAL ingest route rather than an insert.
 *
 * A fixture that wrote rows directly would let this file pass while the only
 * writer in production stored something else — the shape `intent-ladder.test.ts`
 * was caught in, where every row was hand-built and no test ever exercised the
 * write path's own coupling.
 */
const ingest = async (host: TestHarness, spec: RunSpec): Promise<string> => {
  const startedAt = new Date(NOW.getTime() - spec.minutesAgo * 60_000);
  const failing = spec.failing ?? [];
  const response = await host.app.request(
    "/api/ci-runs",
    jsonRequest("POST", TEST_CI_TOKEN, {
      ...LANE,
      ref: spec.ref ?? LANE.ref,
      commitSha: spec.commit,
      runAttempt: spec.attempt ?? 1,
      externalRunId: `ext-${spec.commit}-${String(spec.minutesAgo)}`,
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
    ok: boolean;
    data?: { id: string };
    error?: { message: string };
  };
  if (body.data?.id === undefined) {
    throw new Error(`ingest refused: ${body.error?.message ?? "no id"}`);
  }
  return body.data.id;
};

/**
 * A base window of `CI_FLAKE_BASE_RUNS` green runs at DISTINCT commits, oldest
 * furthest back. Derived from the constant rather than written as five, so
 * raising the constant does not leave a fixture one run short and every rung
 * below quietly answering `insufficient_base`.
 */
const greenBase = async (
  host: TestHarness,
  ref: string = DEFAULT_REF,
): Promise<void> => {
  for (let index = 0; index < CI_FLAKE_BASE_RUNS; index += 1) {
    await ingest(host, {
      commit: sha(`base${String(index)}`),
      minutesAgo: 600 - index * 10,
      ref,
    });
  }
};

const deltasFor = async (
  host: TestHarness,
  commit: string,
  ref: string = DEFAULT_REF,
): Promise<readonly CiBehaviorDelta[]> =>
  ciBehaviorDeltas({
    db: host.db,
    lane: { ...LANE, ref },
    defaultRef: DEFAULT_REF,
    commitSha: commit,
    now: NOW,
  });

const only = (deltas: readonly CiBehaviorDelta[]): CiBehaviorDelta => {
  expect(deltas.length).toBe(1);
  const first = deltas[0];
  if (first === undefined) {
    throw new Error("no delta");
  }
  return first;
};

describe("each rung answers for its own reason", () => {
  test("too little history says so, and does not say the test was green", async () => {
    // Arrange: one red run and nothing else. The window is EMPTY, so "was it
    // failing before?" has no rows to find — and finding nothing is exactly
    // what a stably green history also looks like.
    harness = await createTestHarness();
    await ingest(harness, { commit: SUBJECT, minutesAgo: 5, failing: [RED] });

    // Act
    const delta = only(await deltasFor(harness, SUBJECT));

    // Assert: the refusal names the cause, and the count is the honest
    // denominator rather than a number rounded up to the bound.
    expect(delta.delta).toBe("unconfirmed");
    expect(delta.reason).toBe("insufficient_base");
    expect(delta.baseRuns).toBe(0);
    expect(delta.testId).toBe(RED);
  });

  test("a test that was already failing sends the reader somewhere else", async () => {
    // Arrange: a full window, but this test is non-green inside it.
    harness = await createTestHarness();
    await greenBase(harness);
    await ingest(harness, {
      commit: sha("wasred"),
      minutesAgo: 400,
      failing: [RED],
    });
    await ingest(harness, { commit: SUBJECT, minutesAgo: 5, failing: [RED] });

    const delta = only(await deltasFor(harness, SUBJECT));

    expect(delta.delta).toBe("unconfirmed");
    expect(delta.reason).toBe("not_stably_green");
  });

  test("an unmeasured commit is not an accused one", async () => {
    // Arrange: stably green base, one red run, NOBODY re-ran it. One red run
    // cannot separate a broken commit from an unreliable test.
    harness = await createTestHarness();
    await greenBase(harness);
    await ingest(harness, { commit: SUBJECT, minutesAgo: 5, failing: [RED] });

    const delta = only(await deltasFor(harness, SUBJECT));

    expect(delta.delta).toBe("unconfirmed");
    expect(delta.reason).toBe("awaiting_rerun");
    expect(delta.baseRuns).toBe(CI_FLAKE_BASE_RUNS);
    expect(delta.rerunKind).toBe("none");
  });

  test("green on the second measurement is the test's fault, not the commit's", async () => {
    harness = await createTestHarness();
    await greenBase(harness);
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
      failing: [],
    });

    const delta = only(await deltasFor(harness, SUBJECT));

    expect(delta.delta).toBe("flaky");
    expect(delta.reason).toBe("rerun_green");
    // WHICH re-run, because a same_job re-run cannot rule out host state and
    // a reader deciding whether to trust this needs to know which they hold.
    expect(delta.rerunKind).toBe("new_attempt");
  });

  test("red twice on one commit over a green base is the only rung that accuses", async () => {
    harness = await createTestHarness();
    await greenBase(harness);
    const primary = await ingest(harness, {
      commit: SUBJECT,
      minutesAgo: 30,
      failing: [RED],
    });
    await ingest(harness, {
      commit: SUBJECT,
      minutesAgo: 5,
      attempt: 2,
      rerunKind: "same_job",
      rerunOf: primary,
      failing: [RED],
    });

    const delta = only(await deltasFor(harness, SUBJECT));

    expect(delta.delta).toBe("confirmed");
    expect(delta.reason).toBe("rerun_red");
    expect(delta.rerunKind).toBe("same_job");
  });
});

describe("the order of the rungs is the contract", () => {
  test("no history outranks every reason below it", async () => {
    // THE ANCHOR. Same situation as `confirmed` — red, then red again on the
    // same commit — but with NO base window. Move `insufficient_base` below
    // any rung beneath it and this reads `rerun_red`/`confirmed`: an
    // accusation assembled out of an empty table, because "was it failing
    // before?" found nothing and nothing was taken for "no".
    harness = await createTestHarness();
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

    const delta = only(await deltasFor(harness, SUBJECT));

    expect(delta.delta).toBe("unconfirmed");
    expect(delta.reason).toBe("insufficient_base");
  });

  test("an already-failing test outranks the re-run that would confirm it", async () => {
    // The second ordering hazard, same direction: a test red in the base AND
    // red on both measurements here. `not_stably_green` is the truth; reading
    // the re-run first would blame this commit for a test that was already
    // broken when it arrived.
    harness = await createTestHarness();
    await greenBase(harness);
    await ingest(harness, {
      commit: sha("wasred"),
      minutesAgo: 400,
      failing: [RED],
    });
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

    const delta = only(await deltasFor(harness, SUBJECT));

    expect(delta.reason).toBe("not_stably_green");
  });
});

describe("what never enters the answer", () => {
  test("a crashed run yields no delta at all", async () => {
    // An infrastructure failure is not a fact about a commit in EITHER
    // direction. Its result set is empty because the runner died.
    harness = await createTestHarness();
    await greenBase(harness);
    await ingest(harness, {
      commit: SUBJECT,
      minutesAgo: 5,
      outcome: "crashed",
      failing: [],
    });

    expect(await deltasFor(harness, SUBJECT)).toEqual([]);
  });

  test("a crashed run in the window is not a green one", async () => {
    // The same rule read from the base side. Four green runs plus a crash is
    // FOUR runs, not five — counting the crash would manufacture the window
    // that lets the next rung accuse.
    harness = await createTestHarness();
    for (let index = 0; index < CI_FLAKE_BASE_RUNS - 1; index += 1) {
      await ingest(harness, {
        commit: sha(`base${String(index)}`),
        minutesAgo: 600 - index * 10,
      });
    }
    await ingest(harness, {
      commit: sha("crashed"),
      minutesAgo: 500,
      outcome: "crashed",
    });
    await ingest(harness, { commit: SUBJECT, minutesAgo: 5, failing: [RED] });

    const delta = only(await deltasFor(harness, SUBJECT));

    expect(delta.reason).toBe("insufficient_base");
    expect(delta.baseRuns).toBe(CI_FLAKE_BASE_RUNS - 1);
  });

  test("one commit measured five times is one run, not five", async () => {
    // DISTINCT COMMIT. A window filled by re-running one commit cannot say
    // whether a test is stably green ACROSS commits, which is the only thing
    // it is read for — so the count stays 1 and the ladder refuses.
    harness = await createTestHarness();
    for (let index = 0; index < CI_FLAKE_BASE_RUNS; index += 1) {
      await ingest(harness, {
        commit: sha("samecommit"),
        minutesAgo: 600 - index * 10,
        attempt: index + 1,
      });
    }
    await ingest(harness, { commit: SUBJECT, minutesAgo: 5, failing: [RED] });

    const delta = only(await deltasFor(harness, SUBJECT));

    expect(delta.reason).toBe("insufficient_base");
    expect(delta.baseRuns).toBe(1);
  });
});

describe("a window borrowed from another ref says it borrowed", () => {
  test("a feature branch with no history of its own falls back, and is labelled", async () => {
    // THE HUB HOLDS NO REPOSITORY and cannot check that this branch descends
    // from main. The fallback is an assumption, so it travels as one.
    harness = await createTestHarness();
    await greenBase(harness, DEFAULT_REF);
    await ingest(harness, {
      commit: SUBJECT,
      minutesAgo: 5,
      ref: "feat/thing",
      failing: [RED],
    });

    const delta = only(await deltasFor(harness, SUBJECT, "feat/thing"));

    expect(delta.baseWindowSource).toBe("default_ref_fallback");
    expect(delta.baseRuns).toBe(CI_FLAKE_BASE_RUNS);
    expect(delta.reason).toBe("awaiting_rerun");
  });

  test("a lane with its own history does not borrow", async () => {
    // The control: a branch that HAS its own window is measured against it,
    // and the label says so. A fallback taken when it was not needed would be
    // an assumption introduced for nothing.
    harness = await createTestHarness();
    await greenBase(harness, "feat/thing");
    await ingest(harness, {
      commit: SUBJECT,
      minutesAgo: 5,
      ref: "feat/thing",
      failing: [RED],
    });

    const delta = only(await deltasFor(harness, SUBJECT, "feat/thing"));

    expect(delta.baseWindowSource).toBe("same_ref");
  });
});

describe("every non-green test gets its own answer", () => {
  test("two failures on one run are judged apart", async () => {
    // A run-level verdict would make one flaky test taint a real regression,
    // or one real regression accuse a flaky neighbour. The unit is the TEST.
    harness = await createTestHarness();
    await greenBase(harness);
    await ingest(harness, {
      commit: sha("otherred"),
      minutesAgo: 400,
      failing: [OTHER],
    });
    const primary = await ingest(harness, {
      commit: SUBJECT,
      minutesAgo: 30,
      failing: [RED, OTHER],
    });
    await ingest(harness, {
      commit: SUBJECT,
      minutesAgo: 5,
      attempt: 2,
      rerunKind: "new_attempt",
      rerunOf: primary,
      failing: [RED, OTHER],
    });

    const deltas = await deltasFor(harness, SUBJECT);
    const byId = new Map(deltas.map((delta) => [delta.testId, delta]));

    expect(byId.get(RED)?.reason).toBe("rerun_red");
    expect(byId.get(RED)?.delta).toBe("confirmed");
    expect(byId.get(OTHER)?.reason).toBe("not_stably_green");
    expect(byId.get(OTHER)?.delta).toBe("unconfirmed");
  });
});
