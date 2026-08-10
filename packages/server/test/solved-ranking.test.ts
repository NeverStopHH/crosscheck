/**
 * Solved-tree identification and the decay floor (VISION.md §1 collective
 * memory): a work context whose diagnosis holds a non-superseded
 * likely_root_cause claim WITH evidence refs is SOLVED, and a solved tree the
 * query lexically matched must not decay into invisibility under fresh noise —
 * the answer from March is the point of retaining everything.
 *
 * The floor mutation (SOLVED_DECAY_FLOOR → 0 in scripts/mutation-check.ts)
 * re-breaks the ranking test here on every pull request.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import {
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  TEST_START_ISO,
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
  options: { readonly embedder?: unknown } = {},
): Promise<SolvedHarness> => {
  const harness = await createTestHarness(
    options as Parameters<typeof createTestHarness>[0],
  );
  const developer = await createTestDeveloper(
    harness,
    "Nick",
    "nick@example.com",
  );
  await registerTestSession(harness, developer.apiKey, { id: SOLVED_SESSION });
  await registerTestSession(harness, developer.apiKey, { id: FRESH_SESSION });
  return { harness, developer };
};

describe("solved trees in search", () => {
  test("a 60-day-old solved tree owning the exact target outranks fresh text noise", async () => {
    // Arrange
    const { harness, developer } = await createSolvedHarness();
    await seed(harness, developer, solvedTreeRecords());
    await seed(harness, developer, freshNoiseRecords());

    // Act: "refresh.ts" hits wc_solved's file target, "login" hits wc_fresh's
    // title — without the floor, 60 days of decay bury the actual answer.
    const results = await search(harness, developer.apiKey, "refresh.ts login");

    // Assert
    expect(results[0]?.id).toBe("wc_solved");
    expect(results.map((entry) => entry.id)).toContain("wc_fresh");
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
  });
});
