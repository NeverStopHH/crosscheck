/**
 * THE TWO EVIDENCE AXES, RUNG BY RUNG (1.0 spec 08 §3.1, §3.3, §3.5).
 *
 * `readEvidenceAxes` answers "was anything actually RUN behind this sentence".
 * Ten reasons can be the answer and only one of them — `red_then_green` —
 * claims a fix was shown to land. Every test below pins one rung to the
 * situation that must produce it.
 *
 * THE ORDER THAT MATTERS: every absence must resolve DOWNWARD. A hub with no
 * CI rows, no revalidations and no fingerprints must answer `unsupported`, and
 * never `repository_verified` on the strength of an empty table. That is
 * principle 5, and the tests that assert it are the ones worth keeping.
 *
 * Rows are seeded through the REAL routes rather than inserted, so a change to
 * a write path cannot leave this file passing against a shape production never
 * stores. The one exception is marked where it occurs and says why.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { EvidenceAxes } from "@crosscheck/schema";
import { NO_COMMIT_SHA } from "@crosscheck/schema";

import { claims } from "../src/db/schema.ts";
import {
  parseVerificationRef,
  readEvidenceAxes,
} from "../src/services/evidence-axes.ts";
import type { ClaimAxesRow } from "../src/services/evidence-axes.ts";
import {
  TEST_CI_TOKEN,
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  validClaimBody,
  validWorkContextBody,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = "github.com/acme/api";
const FAILING_TEST = "packages/a.test.ts::suite::the refresh path drops the key";
const BOUND_COMMIT = "a1b2c3d";
const LATER_COMMIT = "e4f5a6b";
const FINGERPRINT = "sha256:3f2a9c1188aa77bb";

const LANE = {
  repo: REPO,
  provider: "github_actions" as const,
  workflow: "ci",
  job: "Test & Typecheck",
  leg: "ubuntu-latest",
  ref: "main",
};

let harness: TestHarness | null = null;

afterEach(() => {
  harness = null;
});

interface RunSpec {
  readonly commit: string;
  readonly outcome?: "completed" | "crashed";
  readonly failing?: readonly string[];
  readonly attempt?: number;
}

/** One CI run, through the real ingest route (05 §3.3). */
const ingestRun = async (host: TestHarness, spec: RunSpec): Promise<void> => {
  const failing = spec.failing ?? [];
  const at = new Date("2026-07-24T12:00:00.000Z").toISOString();
  const response = await host.app.request(
    "/api/ci-runs",
    jsonRequest("POST", TEST_CI_TOKEN, {
      ...LANE,
      commitSha: spec.commit,
      runAttempt: spec.attempt ?? 1,
      externalRunId: `ext-${spec.commit}-${String(spec.attempt ?? 1)}`,
      rerunKind: "none",
      rerunOf: null,
      outcome: spec.outcome ?? "completed",
      tests: 100,
      failures: failing.length,
      skipped: 0,
      durationMs: 1000,
      ambiguousDropped: 0,
      startedAt: at,
      collectedAt: at,
      results: failing.map((testId) => ({
        testId,
        status: "failed" as const,
        durationMs: 12,
      })),
    }),
  );
  // 201, not 200: the CI route CREATES a run. Asserted rather than ignored,
  // because a silently refused seed makes every rung below read as an honest
  // absence — which is the one failure mode this file exists to catch.
  if (response.status !== 201) {
    throw new Error(`ci ingest refused with ${String(response.status)}`);
  }
};

/** A context plus one claim, through /api/records. */
const seedClaim = async (
  host: TestHarness,
  developer: TestDeveloper,
  overrides: Record<string, unknown>,
): Promise<void> => {
  await postRecords(
    host,
    developer,
    recordEnvelope("work_context", validWorkContextBody()),
  );
  const { data } = await postRecords(
    host,
    developer,
    recordEnvelope("claim", validClaimBody(overrides)),
  );
  if (data?.results[0]?.status !== "accepted") {
    throw new Error(
      `claim refused: ${data?.results[0]?.issues?.join(" ") ?? "unknown"}`,
    );
  }
};

/** A revalidation of clm_01 at a later commit, through the real route. */
const revalidateAt = async (
  host: TestHarness,
  developer: TestDeveloper,
  refCommit: string,
): Promise<void> => {
  const response = await host.app.request(
    "/api/claim-revalidations",
    jsonRequest("POST", developer.apiKey, {
      repo: REPO,
      entries: [
        {
          claimId: "clm_01",
          result: "unchanged",
          basis: "declared",
          refCommit,
          touchingCommits: [],
          touchingTotal: 0,
        },
      ],
      revalidated: 1,
      total: 1,
    }),
  );
  if (response.status !== 200) {
    throw new Error(`revalidation refused with ${String(response.status)}`);
  }
};

/**
 * The claim as the READ path sees it — selected from the table, never
 * hand-built, so a column the ingest path stopped writing shows up here.
 */
const axesOf = async (
  host: TestHarness,
  claimId = "clm_01",
): Promise<EvidenceAxes | undefined> => {
  const rows = await host.db
    .select({
      id: claims.id,
      workContextId: claims.workContextId,
      verificationRef: claims.verificationRef,
      commitBinding: claims.commitBinding,
      observedAtCommit: claims.observedAtCommit,
    })
    .from(claims)
    .where(eq(claims.id, claimId));
  const axes = await readEvidenceAxes({
    db: host.db,
    repo: REPO,
    claims: rows as readonly ClaimAxesRow[],
  });
  return axes.get(claimId);
};

describe("parseVerificationRef", () => {
  test("splits at the FIRST colon, because both values contain more", () => {
    // Arrange & Act — a test id is "<file>::<describe chain>::<name>".
    const ciTest = parseVerificationRef(`ci_test:${FAILING_TEST}`);
    const fingerprint = parseVerificationRef(
      `error_fingerprint:${FINGERPRINT}`,
    );

    // Assert — splitting on every colon would mangle both, and a mangled value
    // resolves against nothing, which would surface as `ref_unresolved`: a
    // sentence about the world, reported for a parser bug.
    expect(ciTest).toEqual({ kind: "ci_test", value: FAILING_TEST });
    expect(fingerprint).toEqual({
      kind: "error_fingerprint",
      value: FINGERPRINT,
    });
  });

  test("refuses a kind this version does not know, rather than guessing", () => {
    expect(parseVerificationRef("profiler_trace:flame.json")).toBeNull();
    expect(parseVerificationRef("no-colon-at-all")).toBeNull();
    expect(parseVerificationRef(":leading")).toBeNull();
    expect(parseVerificationRef("ci_test:")).toBeNull();
  });
});

describe("EV-2 — support fails closed", () => {
  test("a claim with no ref is unsupported, and says which absence", async () => {
    // Arrange — every claim written before 08 is this claim.
    const { harness: host, developer } = await createHarnessWithSession();
    await seedClaim(host, developer, {});

    // Act
    const axes = await axesOf(host);

    // Assert
    expect(axes?.support).toBe("unsupported");
    expect(axes?.supportReason).toBe("no_verification_ref");
  });

  test("a malformed ref is unsupported, and NOT confused with unresolved", async () => {
    // Arrange
    const { harness: host, developer } = await createHarnessWithSession();
    await seedClaim(host, developer, {
      verificationRef: "profiler_trace:flame.json",
    });

    // Act
    const axes = await axesOf(host);

    // Assert — one is a claim we cannot READ, the other a claim we read and
    // could not FIND. Collapsing them would hide a newer producer's ref behind
    // "no such row", which reads as the world's answer to our question.
    expect(axes?.support).toBe("unsupported");
    expect(axes?.supportReason).toBe("ref_malformed");
  });

  test("a well-formed ref naming nothing this hub holds is unresolved", async () => {
    // Arrange — no CI rows at all, which is the state of every repo with no
    // reporter.
    const { harness: host, developer } = await createHarnessWithSession();
    await seedClaim(host, developer, {
      verificationRef: `ci_test:${FAILING_TEST}`,
    });

    // Act
    const axes = await axesOf(host);

    // Assert — an empty table is not a green.
    expect(axes?.support).toBe("unsupported");
    expect(axes?.supportReason).toBe("ref_unresolved");
  });

  test("an unresolvable fingerprint does not borrow another context's", async () => {
    // Arrange — a fingerprint exists on the hub, but a DIFFERENT one. A hash
    // this context never observed says nothing about whether this claim's
    // check was run.
    const { harness: host, developer } = await createHarnessWithSession();
    await seedClaim(host, developer, {
      verificationRef: `error_fingerprint:${FINGERPRINT}`,
    });
    await postRecords(
      host,
      developer,
      recordEnvelope("target", {
        workContextId: WORK_CONTEXT_ID,
        kind: "error_fingerprint",
        value: "sha256:0000000000000000",
      }),
    );

    // Act
    const axes = await axesOf(host);

    // Assert
    expect(axes?.supportReason).toBe("ref_unresolved");
  });
});

describe("EV-3 — repository_verified needs four legs", () => {
  test("a resolved fingerprint stops at tool_observed, always", async () => {
    // Arrange — a fingerprint is the hash of a failure that was SEEN. Nothing
    // about it can say a fix landed, so leg 2 refuses it however much else is
    // true. The CI rows below satisfy every other leg.
    const { harness: host, developer } = await createHarnessWithSession();
    await seedClaim(host, developer, {
      verificationRef: `error_fingerprint:${FINGERPRINT}`,
      observedAtCommit: BOUND_COMMIT,
    });
    await postRecords(
      host,
      developer,
      recordEnvelope("target", {
        workContextId: WORK_CONTEXT_ID,
        kind: "error_fingerprint",
        value: FINGERPRINT,
      }),
    );
    await ingestRun(host, { commit: BOUND_COMMIT, failing: [FAILING_TEST] });
    await revalidateAt(host, developer, LATER_COMMIT);
    await ingestRun(host, { commit: LATER_COMMIT, failing: [] });

    // Act
    const axes = await axesOf(host);

    // Assert
    expect(axes?.support).toBe("tool_observed");
    expect(axes?.supportReason).toBe("observed_failure");
  });

  test("an unbound claim cannot be verified, and the reason names the leg", async () => {
    // Arrange — leg 1. Every leg below is an argument about what happened AT a
    // commit, so a claim bound to none of them cannot reach any of them.
    //
    // THE SESSION REGISTERS WITH THE NO-COMMIT PLACEHOLDER, and it has to:
    // spec 02's D2 binds a claim that names no commit to its session's base
    // commit instead, so simply omitting `observedAtCommit` yields a
    // `session_base` binding rather than none. A first version of this test
    // did exactly that and read `ci_observed` — the rung was never exercised.
    // `none` is reached only when nothing usable ever reached the row, which
    // is what a session with no resolvable HEAD reports.
    const { harness: host, developer } = await createHarnessWithSession({
      baseCommit: NO_COMMIT_SHA,
    });
    await seedClaim(host, developer, {
      verificationRef: `ci_test:${FAILING_TEST}`,
    });
    await ingestRun(host, { commit: BOUND_COMMIT, failing: [FAILING_TEST] });

    // Act
    const axes = await axesOf(host);

    // Assert
    expect(axes?.support).toBe("tool_observed");
    expect(axes?.supportReason).toBe("no_binding");
  });

  test("a red with nobody having looked since is not a verification", async () => {
    // Arrange — legs 1, 2 and 3, and no leg 4: the test failed at the claim's
    // commit and no revalidation has re-checked the surface since. "Nobody
    // looked" is an absence, and it resolves downward.
    const { harness: host, developer } = await createHarnessWithSession();
    await seedClaim(host, developer, {
      verificationRef: `ci_test:${FAILING_TEST}`,
      observedAtCommit: BOUND_COMMIT,
    });
    await ingestRun(host, { commit: BOUND_COMMIT, failing: [FAILING_TEST] });

    // Act
    const axes = await axesOf(host);

    // Assert
    expect(axes?.support).toBe("tool_observed");
    expect(axes?.supportReason).toBe("ci_observed");
    expect(axes?.observedAt).not.toBeNull();
  });

  test("all four legs read repository_verified and name the green commit", async () => {
    // Arrange — red at the claim's own bound commit, green in the SAME lane at
    // a commit 02 re-checked the surface at. Before and after come from the
    // rows, never from two runners' clocks.
    const { harness: host, developer } = await createHarnessWithSession();
    await seedClaim(host, developer, {
      verificationRef: `ci_test:${FAILING_TEST}`,
      observedAtCommit: BOUND_COMMIT,
    });
    await ingestRun(host, { commit: BOUND_COMMIT, failing: [FAILING_TEST] });
    await revalidateAt(host, developer, LATER_COMMIT);
    await ingestRun(host, { commit: LATER_COMMIT, failing: [] });

    // Act
    const axes = await axesOf(host);

    // Assert
    expect(axes?.support).toBe("repository_verified");
    expect(axes?.supportReason).toBe("red_then_green");
    expect(axes?.verifiedAtCommit).toBe(LATER_COMMIT);
  });

  test("a test still failing at the later commit is never verified", async () => {
    // Arrange — the green leg is ABSENCE from a completed run's non-green
    // list. Here the test is present in it, so there is no green to pair.
    const { harness: host, developer } = await createHarnessWithSession();
    await seedClaim(host, developer, {
      verificationRef: `ci_test:${FAILING_TEST}`,
      observedAtCommit: BOUND_COMMIT,
    });
    await ingestRun(host, { commit: BOUND_COMMIT, failing: [FAILING_TEST] });
    await revalidateAt(host, developer, LATER_COMMIT);
    await ingestRun(host, { commit: LATER_COMMIT, failing: [FAILING_TEST] });

    // Act
    const axes = await axesOf(host);

    // Assert
    expect(axes?.support).toBe("tool_observed");
    expect(axes?.supportReason).not.toBe("red_then_green");
  });

  test("a crashed run at the later commit cannot establish a green", async () => {
    // Arrange — THE INVERSION THIS PROJECT EXISTS TO REFUSE. A crashed run
    // reports no non-green rows, so its empty list looks exactly like a pass.
    // Only a `completed` run asserts that its list is all of them.
    const { harness: host, developer } = await createHarnessWithSession();
    await seedClaim(host, developer, {
      verificationRef: `ci_test:${FAILING_TEST}`,
      observedAtCommit: BOUND_COMMIT,
    });
    await ingestRun(host, { commit: BOUND_COMMIT, failing: [FAILING_TEST] });
    await revalidateAt(host, developer, LATER_COMMIT);
    await ingestRun(host, {
      commit: LATER_COMMIT,
      outcome: "crashed",
      failing: [],
    });

    // Act
    const axes = await axesOf(host);

    // Assert
    expect(axes?.support).toBe("tool_observed");
    expect(axes?.supportReason).not.toBe("red_then_green");
  });
});

describe("EV-1(b) — the read model refuses to promote a stored human mode", () => {
  test("a row carrying capture_mode 'human' still reads agent_derived", async () => {
    // Arrange — THE ROW IS WRITTEN DIRECTLY, and that is the point rather than
    // a shortcut: since §3.2a the wire cannot express `human`, so the only way
    // such a row exists is a hub upgraded from an earlier build, where the
    // field rode the wire verbatim. §4 keeps those rows; this is the lock that
    // covers them.
    const { harness: host, developer } = await createHarnessWithSession();
    await seedClaim(host, developer, {});
    await host.db
      .update(claims)
      .set({ captureMode: "human" as "agent" })
      .where(eq(claims.id, "clm_01"));

    // Act
    const axes = await axesOf(host);

    // Assert — in 1.0 every claim is agent_derived, and no stored value
    // promotes it. The probe fails closed and stays closed.
    expect(axes?.who).toBe("agent_derived");
  });
});
