/**
 * `/api/ci-runs` against a real hub (spec 05 §3.2, §3.7, §4).
 *
 * Four things only the HUB can decide, and each is asserted here rather than
 * argued for in a comment:
 *
 *   - who may write (a token that is not the admin token, and refuses when
 *     no reporter is configured rather than opening),
 *   - whether this attempt is new (a retrying runner must not manufacture a
 *     second green run out of one),
 *   - whether a re-run names a run it could possibly be a re-run OF,
 *   - and whether a sender's clock may reach beyond the hub's own.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  TEST_ADMIN_TOKEN,
  TEST_CI_TOKEN,
  createTestHarness,
  jsonRequest,
} from "./helpers.ts";
import type { TestHarness, TestHarnessOptions } from "./helpers.ts";
import { CI_RETENTION_DAYS } from "../src/constants.ts";

const REPO = "github.com/acme/api";
const COMMIT = "a1b2c3d4";
const SECONDS_PER_DAY = 24 * 60 * 60;
const CLOCK_SKEW_MS = 120_000;

const report = (
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  repo: REPO,
  provider: "github_actions",
  workflow: "ci",
  job: "Test & Typecheck",
  leg: "ubuntu-latest",
  ref: "main",
  commitSha: COMMIT,
  runAttempt: 1,
  externalRunId: "35572434868",
  rerunKind: "none",
  rerunOf: null,
  outcome: "completed",
  tests: 3187,
  failures: 1,
  skipped: 3,
  durationMs: 501_310,
  startedAt: "2026-07-24T08:50:00.000Z",
  collectedAt: "2026-07-24T08:59:00.000Z",
  ambiguousDropped: 0,
  results: [
    {
      testId: "packages/a.test.ts::suite::red one",
      status: "failed",
      durationMs: 12,
    },
  ],
  ...extra,
});

interface PostResult {
  readonly status: number;
  readonly body: {
    readonly ok: boolean;
    readonly data?: { readonly id: string; readonly status: string };
    readonly error?: { readonly code: string; readonly message: string };
  };
}

const post = async (
  harness: TestHarness,
  body: unknown,
  token: string | null = TEST_CI_TOKEN,
): Promise<PostResult> => {
  const response = await harness.app.request(
    "/api/ci-runs",
    jsonRequest("POST", token, body),
  );
  return {
    status: response.status,
    body: (await response.json()) as PostResult["body"],
  };
};

const createDeveloper = async (harness: TestHarness): Promise<string> => {
  const response = await harness.app.request(
    "/api/developers",
    jsonRequest("POST", TEST_ADMIN_TOKEN, {
      name: "Alice",
      email: "alice-ci@example.com",
    }),
  );
  const body = (await response.json()) as { data: { apiKey: string } };
  return body.data.apiKey;
};

const readRuns = async (
  harness: TestHarness,
  apiKey: string,
  commit: string = COMMIT,
): Promise<{
  status: number;
  runs: readonly {
    id: string;
    outcome: string;
    startedAt: string;
    results: readonly { testId: string }[];
  }[];
}> => {
  const response = await harness.app.request(
    `/api/ci-runs?repo=${encodeURIComponent(REPO)}&commit=${commit}`,
    jsonRequest("GET", apiKey),
  );
  const body = (await response.json()) as {
    data: {
      runs: readonly {
        id: string;
        outcome: string;
        startedAt: string;
        results: readonly { testId: string }[];
      }[];
    };
  };
  return { status: response.status, runs: body.data.runs };
};

const harnesses: TestHarness[] = [];
const freshHarness = async (
  options: TestHarnessOptions = {},
): Promise<TestHarness> => {
  const harness = await createTestHarness(options);
  harnesses.push(harness);
  return harness;
};

afterEach(() => {
  harnesses.length = 0;
});

describe("POST /api/ci-runs — who may write", () => {
  test("the CI token writes and the run comes back readable", async () => {
    const harness = await freshHarness();
    const created = await post(harness, report());

    expect(created.status).toBe(201);
    expect(created.body.data?.status).toBe("accepted");
    expect(created.body.data?.id.startsWith("cir_")).toBe(true);

    const apiKey = await createDeveloper(harness);
    const read = await readRuns(harness, apiKey);
    expect(read.status).toBe(200);
    expect(read.runs).toHaveLength(1);
    expect(read.runs[0]?.outcome).toBe("completed");
    expect(read.runs[0]?.results).toHaveLength(1);
  });

  test("the admin token is NOT a CI token", async () => {
    // One token, one capability. The admin token also flips `pin_policy` and
    // `suspect_attribution`, and a CI secret is readable by every workflow in
    // the repository — including ones a fork can influence.
    const harness = await freshHarness();
    const refused = await post(harness, report(), TEST_ADMIN_TOKEN);

    expect(refused.status).toBe(401);
    expect(refused.body.error?.code).toBe("unauthorized");
  });

  test("a hub with no reporter refuses rather than opens", async () => {
    // The DEFAULT install. Absent configuration must never mean "anyone may
    // write": a route that opens when unconfigured is the failure mode a
    // missing environment variable should not be able to cause.
    const harness = await freshHarness({ ciToken: null });

    expect((await post(harness, report(), null)).status).toBe(503);
    expect((await post(harness, report(), "anything")).status).toBe(503);
    expect(
      (await post(harness, report(), TEST_ADMIN_TOKEN)).body.error?.code,
    ).toBe("ci_disabled");
  });

  test("a missing or wrong bearer is refused", async () => {
    const harness = await freshHarness();
    expect((await post(harness, report(), null)).status).toBe(401);
    expect((await post(harness, report(), "wrong")).status).toBe(401);
  });

  test("reading needs a member, not the CI token", async () => {
    const harness = await freshHarness();
    const anonymous = await harness.app.request(
      `/api/ci-runs?repo=${encodeURIComponent(REPO)}&commit=${COMMIT}`,
      jsonRequest("GET", null),
    );
    expect(anonymous.status).toBe(401);
  });
});

describe("POST /api/ci-runs — what counts as a new attempt", () => {
  test("a retried POST of one attempt is a duplicate, not a second run", async () => {
    // A runner whose POST times out and retries must not manufacture a second
    // row: two copies of one attempt would both count toward a base window,
    // and "stably green over five runs" would become "stably green over five
    // copies of one run".
    const harness = await freshHarness();
    const first = await post(harness, report());
    const again = await post(harness, report());

    expect(first.body.data?.status).toBe("accepted");
    expect(again.status).toBe(200);
    expect(again.body.data?.status).toBe("duplicate");
    expect(again.body.data?.id).toBe(first.body.data?.id);
  });

  test("a same_job re-run does not collide with the run it repeats", async () => {
    // GitHub does not increment `GITHUB_RUN_ATTEMPT` for a second `bun test`
    // inside one job, so lane + commit + attempt are IDENTICAL. Without the
    // re-run kind in the key, the hub would answer `duplicate` to the one row
    // the flake filter is waiting for.
    const harness = await freshHarness();
    const primary = await post(harness, report());
    const rerun = await post(
      harness,
      report({ rerunKind: "same_job", rerunOf: primary.body.data?.id }),
    );

    expect(rerun.status).toBe(201);
    expect(rerun.body.data?.status).toBe("accepted");
    expect(rerun.body.data?.id).not.toBe(primary.body.data?.id);
  });

  test("a different leg is a different run at the same commit", async () => {
    const harness = await freshHarness();
    const ubuntu = await post(harness, report());
    const macos = await post(harness, report({ leg: "macos-latest" }));

    expect(macos.body.data?.status).toBe("accepted");
    expect(macos.body.data?.id).not.toBe(ubuntu.body.data?.id);
  });
});

describe("POST /api/ci-runs — what a re-run may point at", () => {
  test("a re-run of another lane is refused", async () => {
    // Accepting it would let a green run somewhere else clear a red one here
    // — an exoneration assembled out of two unrelated facts.
    const harness = await freshHarness();
    const ubuntu = await post(harness, report());
    const crossLane = await post(
      harness,
      report({
        leg: "macos-latest",
        rerunKind: "new_attempt",
        runAttempt: 2,
        rerunOf: ubuntu.body.data?.id,
      }),
    );

    expect(crossLane.status).toBe(409);
    expect(crossLane.body.error?.code).toBe("ci_run_rejected");
    expect(crossLane.body.error?.message).toContain("different lane or commit");
  });

  test("a re-run of another commit is refused", async () => {
    const harness = await freshHarness();
    const first = await post(harness, report());
    const crossCommit = await post(
      harness,
      report({
        commitSha: "deadbeef",
        rerunKind: "new_attempt",
        runAttempt: 2,
        rerunOf: first.body.data?.id,
      }),
    );

    expect(crossCommit.status).toBe(409);
    expect(crossCommit.body.error?.message).toContain("different lane or commit");
  });

  test("a re-run of a run this hub never saw is refused, and says so", async () => {
    const harness = await freshHarness();
    const dangling = await post(
      harness,
      report({
        rerunKind: "new_attempt",
        runAttempt: 2,
        rerunOf: "cir_nosuchrun",
      }),
    );

    expect(dangling.status).toBe(409);
    expect(dangling.body.error?.message).toContain("no run this hub holds");
  });

  test("a re-run of the same lane and commit is accepted", async () => {
    const harness = await freshHarness();
    const primary = await post(harness, report());
    const rerun = await post(
      harness,
      report({
        rerunKind: "new_attempt",
        runAttempt: 2,
        rerunOf: primary.body.data?.id,
      }),
    );

    expect(rerun.status).toBe(201);
  });
});

describe("POST /api/ci-runs — the sender's clock", () => {
  test("a future timestamp is clamped to the hub's own", async () => {
    // Unclamped, a forged `started_at` can never be overtaken by honest
    // evidence and can never fall out of retention: one value would pin a
    // lane's window open for good. The sender controls BOTH timestamps.
    const harness = await freshHarness();
    await post(
      harness,
      report({
        startedAt: "2099-01-01T00:00:00.000Z",
        collectedAt: "2099-01-01T00:00:00.000Z",
      }),
    );

    const apiKey = await createDeveloper(harness);
    const read = await readRuns(harness, apiKey);
    const stored = Date.parse(read.runs[0]?.startedAt ?? "");
    const hubNow = harness.clock.now().getTime();

    expect(read.runs).toHaveLength(1);
    expect(stored).toBeLessThanOrEqual(hubNow + CLOCK_SKEW_MS);
    expect(stored).toBeGreaterThan(hubNow - CLOCK_SKEW_MS);
  });

  test("a run older than retention is pruned on the next write", async () => {
    const harness = await freshHarness();
    await post(harness, report());

    harness.clock.advanceSeconds((CI_RETENTION_DAYS + 1) * SECONDS_PER_DAY);
    await post(
      harness,
      report({
        commitSha: "beefcafe",
        startedAt: harness.clock.now().toISOString(),
        collectedAt: harness.clock.now().toISOString(),
      }),
    );

    const apiKey = await createDeveloper(harness);
    // The old commit's run is gone; the write that pruned it is still there.
    expect((await readRuns(harness, apiKey)).runs).toHaveLength(0);
    expect((await readRuns(harness, apiKey, "beefcafe")).runs).toHaveLength(1);
  });
});
