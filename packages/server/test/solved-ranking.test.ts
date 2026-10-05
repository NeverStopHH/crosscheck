/**
 * Solved-tree identification and the decay floor (VISION.md §1 collective
 * memory): a work context whose diagnosis holds a non-superseded
 * likely_root_cause claim WITH evidence refs is SOLVED, and a solved tree the
 * query lexically matched must not decay into invisibility under fresh noise —
 * the answer from March is the point of retaining everything.
 *
 * The floor lifts only a tree whose root cause is still CURRENT about the code
 * (1.0 spec 02 §5): a cause the code has moved past, or one nobody ever
 * revalidated, decays like any other row. The floor is a strengthening, and
 * missing evidence may weaken a conclusion, never strengthen one.
 *
 * The floor mutation (SOLVED_DECAY_FLOOR → 0 in scripts/mutation-check.ts)
 * re-breaks the ranking test here on every pull request.
 */
import { describe, expect, test } from "bun:test";
import { NO_COMMIT_SHA } from "@crosscheck/schema";
import { sql } from "drizzle-orm";

import {
  RRF_K,
  SOLVED_DECAY_FLOOR,
  TEXT_TIER_WEIGHT,
  TIER_CANDIDATES,
} from "../src/services/search.ts";

import {
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  TEST_START_ISO,
  VALID_SESSION_BODY,
  validClaimBody,
  validWorkContextBody,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";
import { createFakeEmbedder } from "./fixtures/fake-embedder.ts";

/**
 * 60 days before TEST_START_ISO — decay 0.5^(60/14) ≈ 0.051, far below the
 * floor, so the floored and unfloored rankings disagree unambiguously.
 */
const OLD_CREATED_ISO = "2026-05-25T09:00:00.000Z";

const SOLVED_SESSION = "ses_solved";
const FRESH_SESSION = "ses_fresh";

interface ResultView {
  readonly id: string;
  readonly tier: string;
  readonly score?: number;
  readonly resultKind?: string;
  readonly solvedAt?: string | null;
}

const search = async (
  harness: TestHarness,
  apiKey: string,
  query: string,
): Promise<readonly ResultView[]> => {
  const response = await harness.app.request(
    `/api/search?query=${encodeURIComponent(query)}`,
    jsonRequest("GET", apiKey),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: { results: ResultView[] };
  };
  return body.data.results;
};

const seed = async (
  harness: TestHarness,
  developer: TestDeveloper,
  records: readonly Record<string, unknown>[],
): Promise<void> => {
  const posted = await postRecords(harness, developer, { records });
  if (posted.status !== 200 || (posted.data?.rejected ?? 1) > 0) {
    throw new Error(`seed failed: ${JSON.stringify(posted.data?.results)}`);
  }
};

/**
 * Records what a revalidation found under wc_solved's root cause — the reading
 * the hub derives the claim's validity from (1.0 spec 02 §5): `unchanged`
 * makes it current, `changed` makes it stale.
 */
const reviseRootCause = async (
  harness: TestHarness,
  developer: TestDeveloper,
  result: "changed" | "unchanged",
): Promise<void> => {
  const touching = result === "changed" ? ["deadbee"] : [];
  const response = await harness.app.request(
    "/api/claim-revalidations",
    jsonRequest("POST", developer.apiKey, {
      repo: VALID_SESSION_BODY.repo,
      entries: [
        {
          claimId: "clm_solved_root",
          result,
          basis: "context_targets",
          refCommit: "ff00aa11",
          touchingCommits: touching,
          touchingTotal: touching.length,
        },
      ],
      revalidated: 1,
      total: 1,
    }),
  );
  if (response.status !== 200) {
    throw new Error(`revalidation failed: ${String(response.status)} ${await response.text()}`);
  }
};

/** An old context owning the file target, solved by an evidenced root cause. */
const solvedTreeRecords = (): readonly Record<string, unknown>[] => [
  recordEnvelope(
    "work_context",
    validWorkContextBody({
      id: "wc_solved",
      sessionId: SOLVED_SESSION,
      title: "Token refresh 500s on staging",
      description: undefined,
      createdAt: OLD_CREATED_ISO,
    }),
    { sessionId: SOLVED_SESSION },
  ),
  recordEnvelope(
    "target",
    { workContextId: "wc_solved", kind: "file", value: "src/auth/refresh.ts" },
    { sessionId: SOLVED_SESSION },
  ),
  recordEnvelope(
    "claim",
    validClaimBody({
      id: "clm_solved_evidence",
      workContextId: "wc_solved",
      authorSessionId: SOLVED_SESSION,
      kind: "evidence",
      body: "Stack trace shows the rotated signing key being reused",
      createdAt: OLD_CREATED_ISO,
    }),
    { sessionId: SOLVED_SESSION },
  ),
  recordEnvelope(
    "claim",
    validClaimBody({
      id: "clm_solved_root",
      workContextId: "wc_solved",
      authorSessionId: SOLVED_SESSION,
      kind: "root_cause",
      status: "likely_root_cause",
      confidence: 0.9,
      evidenceRefs: ["clm_solved_evidence"],
      body: "The ingestion mapping drops the key id on rotation",
      createdAt: OLD_CREATED_ISO,
    }),
    { sessionId: SOLVED_SESSION },
  ),
];

/**
 * A rival evidence-backed root cause on wc_solved, in open contradiction
 * with clm_solved_root — the two-standing-answers deadlock.
 */
const deadlockRecords = (): readonly Record<string, unknown>[] => [
  recordEnvelope(
    "claim",
    validClaimBody({
      id: "clm_rival_evidence",
      workContextId: "wc_solved",
      authorSessionId: SOLVED_SESSION,
      kind: "evidence",
      body: "Cache trace shows the stale token surviving rotation",
      createdAt: OLD_CREATED_ISO,
    }),
    { sessionId: SOLVED_SESSION },
  ),
  recordEnvelope(
    "claim",
    validClaimBody({
      id: "clm_solved_rival",
      workContextId: "wc_solved",
      authorSessionId: SOLVED_SESSION,
      kind: "root_cause",
      status: "likely_root_cause",
      confidence: 0.8,
      evidenceRefs: ["clm_rival_evidence"],
      body: "The session cache, not the mapping, serves the stale key",
      createdAt: OLD_CREATED_ISO,
    }),
    { sessionId: SOLVED_SESSION },
  ),
  recordEnvelope(
    "claim_edge",
    {
      id: "edge_solved_deadlock",
      fromClaimId: "clm_solved_rival",
      toClaimId: "clm_solved_root",
      kind: "contradicts",
      authorSessionId: SOLVED_SESSION,
      createdAt: OLD_CREATED_ISO,
    },
    { sessionId: SOLVED_SESSION },
  ),
];

const freshNoiseRecords = (): readonly Record<string, unknown>[] => [
  recordEnvelope(
    "work_context",
    validWorkContextBody({
      id: "wc_fresh",
      sessionId: FRESH_SESSION,
      title: "Login page errors after deploy",
      description: undefined,
      createdAt: TEST_START_ISO,
    }),
    { sessionId: FRESH_SESSION },
  ),
];

interface SolvedHarness {
  readonly harness: TestHarness;
  readonly developer: TestDeveloper;
}

const createSolvedHarness = async (
  options: { readonly embedder?: unknown; readonly solvedBaseCommit?: string } = {},
): Promise<SolvedHarness> => {
  const { solvedBaseCommit, ...harnessOptions } = options;
  const harness = await createTestHarness(
    harnessOptions as Parameters<typeof createTestHarness>[0],
  );
  const developer = await createTestDeveloper(
    harness,
    "Nick",
    "nick@example.com",
  );
  await registerTestSession(harness, developer.apiKey, {
    id: SOLVED_SESSION,
    ...(solvedBaseCommit === undefined ? {} : { baseCommit: solvedBaseCommit }),
  });
  await registerTestSession(harness, developer.apiKey, { id: FRESH_SESSION });
  return { harness, developer };
};

describe("solved trees in search", () => {
  test("a 60-day-old solved tree whose cause is still current outranks fresh text noise", async () => {
    // Arrange
    const { harness, developer } = await createSolvedHarness();
    await seed(harness, developer, solvedTreeRecords());
    await seed(harness, developer, freshNoiseRecords());
    await reviseRootCause(harness, developer, "unchanged");

    // Act: "refresh.ts" hits wc_solved's file target, "login" hits wc_fresh's
    // title — without the floor, 60 days of decay bury the actual answer.
    const results = await search(harness, developer.apiKey, "refresh.ts login");

    // Assert
    expect(results[0]?.id).toBe("wc_solved");
    expect(results.map((entry) => entry.id)).toContain("wc_fresh");
  });

  test("a solved tree whose cause the code has moved past decays like any other row", async () => {
    // Arrange: the files the root cause names changed after it was recorded.
    const { harness, developer } = await createSolvedHarness();
    await seed(harness, developer, solvedTreeRecords());
    await seed(harness, developer, freshNoiseRecords());
    await reviseRootCause(harness, developer, "changed");

    // Act
    const results = await search(harness, developer.apiKey, "refresh.ts login");

    // Assert: still found and still labelled solved, but no longer lifted
    // above fresh work.
    expect(results[0]?.id).toBe("wc_fresh");
    expect(results.find((entry) => entry.id === "wc_solved")?.resultKind).toBe("solved");
  });

  test("a solved tree whose cause nobody revalidated keeps the floor, as the hint gate does", async () => {
    // Arrange: no revalidation row at all, so the cause's validity is unknown
    // — the state of almost every cause ever recorded.
    const { harness, developer } = await createSolvedHarness();
    await seed(harness, developer, solvedTreeRecords());
    await seed(harness, developer, freshNoiseRecords());

    // Act
    const results = await search(harness, developer.apiKey, "refresh.ts login");

    // Assert
    expect(results[0]?.id).toBe("wc_solved");
  });

  test("a solved tree whose cause is bound to no commit gets no floor", async () => {
    // Arrange: the author session's base commit is the no-commit placeholder,
    // so the cause has no observation point and can never be revalidated.
    const { harness, developer } = await createSolvedHarness({
      solvedBaseCommit: NO_COMMIT_SHA,
    });
    await seed(harness, developer, solvedTreeRecords());
    await seed(harness, developer, freshNoiseRecords());

    // Act
    const results = await search(harness, developer.apiKey, "refresh.ts login");

    // Assert
    expect(results[0]?.id).toBe("wc_fresh");
    expect(results.find((entry) => entry.id === "wc_solved")?.resultKind).toBe("solved");
  });

  test("solved results carry the solved result kind and when they were diagnosed", async () => {
    // Arrange
    const { harness, developer } = await createSolvedHarness();
    await seed(harness, developer, solvedTreeRecords());
    await seed(harness, developer, freshNoiseRecords());

    // Act
    const results = await search(harness, developer.apiKey, "refresh.ts login");

    // Assert
    const solved = results.find((entry) => entry.id === "wc_solved");
    const fresh = results.find((entry) => entry.id === "wc_fresh");
    expect(solved?.resultKind).toBe("solved");
    expect(solved?.solvedAt).toBe(OLD_CREATED_ISO);
    expect(fresh?.resultKind).toBe("open");
    expect(fresh?.solvedAt).toBeNull();
  });

  test("a superseded root cause no longer marks the tree solved", async () => {
    // Arrange: the author revised the root cause away — the supersedes edge
    // TARGETS the retracted claim (same filter the hints path applies).
    const { harness, developer } = await createSolvedHarness();
    await seed(harness, developer, solvedTreeRecords());
    await seed(harness, developer, freshNoiseRecords());
    await seed(harness, developer, [
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_solved_revision",
          workContextId: "wc_solved",
          authorSessionId: SOLVED_SESSION,
          kind: "root_cause",
          status: "proposed",
          body: "Actually the session cache, not the mapping",
          createdAt: OLD_CREATED_ISO,
        }),
        { sessionId: SOLVED_SESSION },
      ),
      recordEnvelope(
        "claim_edge",
        {
          id: "edge_solved_revision",
          fromClaimId: "clm_solved_revision",
          toClaimId: "clm_solved_root",
          kind: "supersedes",
          authorSessionId: SOLVED_SESSION,
          createdAt: OLD_CREATED_ISO,
        },
        { sessionId: SOLVED_SESSION },
      ),
    ]);

    // Act
    const results = await search(harness, developer.apiKey, "refresh.ts login");

    // Assert: no surviving evidenced root cause — no floor, no solved label.
    const solved = results.find((entry) => entry.id === "wc_solved");
    expect(solved?.resultKind).toBe("open");
    expect(results[0]?.id).toBe("wc_fresh");
  });

  test("two evidenced root causes in open contradiction read as deadlocked, not solved", async () => {
    // Arrange: the referee-mode deadlock (DESIGN.md §4) — a second
    // evidence-backed likely_root_cause joined to the first by a contradicts
    // edge. Nobody retracted anything, so the tree holds two standing
    // answers that cannot both be right: that is a live dispute, and a
    // dispute must not earn the solved floor, the solved label, or the
    // solved-before pointer.
    const { harness, developer } = await createSolvedHarness();
    await seed(harness, developer, solvedTreeRecords());
    await seed(harness, developer, freshNoiseRecords());
    await seed(harness, developer, deadlockRecords());

    // Act
    const results = await search(harness, developer.apiKey, "refresh.ts login");

    // Assert
    const solved = results.find((entry) => entry.id === "wc_solved");
    expect(solved?.resultKind).toBe("open");
    expect(results[0]?.id).toBe("wc_fresh");
  });

  test("a deadlock resolved by superseding one side reads solved again", async () => {
    // Pin, not a red-first test: green before the deadlock rule existed
    // (everything read solved then) and green after — it exists to pin the
    // rule's escape hatch. A superseded rival is no longer a QUALIFYING
    // peer, so the surviving root cause settles the tree again; without
    // this, one contradicts edge would unsolve a tree forever.
    const { harness, developer } = await createSolvedHarness();
    await seed(harness, developer, solvedTreeRecords());
    await seed(harness, developer, freshNoiseRecords());
    await seed(harness, developer, deadlockRecords());
    await seed(harness, developer, [
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_rival_retraction",
          workContextId: "wc_solved",
          authorSessionId: SOLVED_SESSION,
          kind: "root_cause",
          status: "proposed",
          body: "Retracting the cache theory — the trace was from stage",
          createdAt: OLD_CREATED_ISO,
        }),
        { sessionId: SOLVED_SESSION },
      ),
      recordEnvelope(
        "claim_edge",
        {
          id: "edge_rival_retracted",
          fromClaimId: "clm_rival_retraction",
          toClaimId: "clm_solved_rival",
          kind: "supersedes",
          authorSessionId: SOLVED_SESSION,
          createdAt: OLD_CREATED_ISO,
        },
        { sessionId: SOLVED_SESSION },
      ),
    ]);
    // The surviving cause is still current, so the settled tree earns the
    // floor back as well as the label.
    await reviseRootCause(harness, developer, "unchanged");

    // Act
    const results = await search(harness, developer.apiKey, "refresh.ts login");

    // Assert
    const solved = results.find((entry) => entry.id === "wc_solved");
    expect(solved?.resultKind).toBe("solved");
    expect(results[0]?.id).toBe("wc_solved");
  });

  test("an evidence-free likely_root_cause on the hub does not mark the tree solved", async () => {
    // Arrange: the wire schema already refuses evidence-free likely_root_cause
    // claims, so this state is unreachable through ingest — it is planted
    // directly to prove the HUB-side rule stands on its own (defense in depth,
    // same layering as the hint selector's status guard).
    const { harness, developer } = await createSolvedHarness();
    await seed(harness, developer, solvedTreeRecords());
    await seed(harness, developer, freshNoiseRecords());
    await harness.db.execute(
      sql`UPDATE claims SET evidence_refs = '[]'::jsonb WHERE id = 'clm_solved_root'`,
    );

    // Act
    const results = await search(harness, developer.apiKey, "refresh.ts login");

    // Assert
    const solved = results.find((entry) => entry.id === "wc_solved");
    expect(solved?.resultKind).toBe("open");
    expect(results[0]?.id).toBe("wc_fresh");
  });

  test("a solved tree matched only by the vector tier gets no floor", async () => {
    // Pin, not a red-first test: the pre-floor ranking already behaves this
    // way, and the point is that adding the floor must NOT extend it to
    // semantic-only matches — the floor is scoped to fingerprint/target/FTS
    // matches, where the match is a fact rather than a similarity guess.
    const { harness, developer } = await createSolvedHarness({
      embedder: createFakeEmbedder(),
    });
    // Solved tree on the login topic axis, no lexical overlap with the query.
    await seed(harness, developer, [
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          id: "wc_solved",
          sessionId: SOLVED_SESSION,
          title: "Login 500s traced to signin token reuse",
          description: undefined,
          createdAt: OLD_CREATED_ISO,
        }),
        { sessionId: SOLVED_SESSION },
      ),
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_solved_evidence",
          workContextId: "wc_solved",
          authorSessionId: SOLVED_SESSION,
          kind: "evidence",
          body: "Signin trace shows token reuse",
          createdAt: OLD_CREATED_ISO,
        }),
        { sessionId: SOLVED_SESSION },
      ),
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_solved_root",
          workContextId: "wc_solved",
          authorSessionId: SOLVED_SESSION,
          kind: "root_cause",
          status: "likely_root_cause",
          confidence: 0.9,
          evidenceRefs: ["clm_solved_evidence"],
          body: "Signin session store returns the stale token",
          createdAt: OLD_CREATED_ISO,
        }),
        { sessionId: SOLVED_SESSION },
      ),
    ]);
    await seed(harness, developer, [
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          id: "wc_fresh",
          sessionId: FRESH_SESSION,
          title: "Authentication flow review",
          description: undefined,
          createdAt: TEST_START_ISO,
        }),
        { sessionId: FRESH_SESSION },
      ),
    ]);

    // Act: "authentication" shares the login topic axis with both contexts but
    // no token ≥3 chars with wc_solved's doc — wc_solved is vector-only.
    const results = await search(harness, developer.apiKey, "authentication");

    // Assert: still labelled solved, but the fresh lexical match ranks first.
    const solved = results.find((entry) => entry.id === "wc_solved");
    expect(solved?.tier).toBe("vector");
    expect(solved?.resultKind).toBe("solved");
    expect(results[0]?.id).toBe("wc_fresh");

    // The ORDER above cannot pin the tier gate on its own: even floored, a
    // vector-only row scores below the fresh two-tier row, so the ordering
    // stays put with the gate deleted. The SCORE can — the floored and
    // unfloored ranges are disjoint at any vector rank: a floored vector-only
    // row scores at least SOLVED_DECAY_FLOOR·TEXT_TIER_WEIGHT/(RRF_K +
    // TIER_CANDIDATES), while this 60-day-old unfloored one scores at most
    // TEXT_TIER_WEIGHT/(RRF_K + 1)·0.5^(60/14), an order of magnitude less.
    //
    // VERIFY: bun -e 'const s=await import("./packages/server/src/services/search.ts");const floored=s.SOLVED_DECAY_FLOOR*s.TEXT_TIER_WEIGHT/(s.RRF_K+s.TIER_CANDIDATES);const unfloored=s.TEXT_TIER_WEIGHT/(s.RRF_K+1)*0.5**(60/14);console.log(floored.toFixed(4),unfloored.toFixed(4),floored>unfloored)'
    // PRINTS: 0.0078 0.0008 true
    const flooredMinimum =
      (SOLVED_DECAY_FLOOR * TEXT_TIER_WEIGHT) / (RRF_K + TIER_CANDIDATES);
    expect(solved?.score ?? Number.POSITIVE_INFINITY).toBeLessThan(
      flooredMinimum,
    );
  });
});
