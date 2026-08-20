/**
 * GET /api/solved-matches — the briefing's "solved before" source (VISION.md
 * §1): solved trees on this repo that share a deterministic target with work
 * that is CURRENTLY active. Strong matches only — error fingerprint or file
 * identity, the exact-tier facts — never text similarity: a SessionStart line
 * asserts relevance unasked, so it gets the highest-precision signal or
 * nothing.
 */
import { describe, expect, test } from "bun:test";

import {
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  TEST_START_ISO,
  validClaimBody,
  validClaimEdgeBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
/** 60 days before TEST_START_ISO — outside any recent-activity window. */
const OLD_ISO = "2026-05-25T09:00:00.000Z";
const OLD_SESSION = "ses_old";
const LIVE_SESSION = "ses_live";
const FINGERPRINT = "fp_3f7a1c9e2b8d4056";

interface MatchView {
  readonly workContextId: string;
  readonly title: string;
  readonly developerName: string;
  readonly solvedAt: string;
  readonly landedAt: string | null;
  readonly matchedTargetKind: string;
}

const fetchMatches = async (
  harness: TestHarness,
  apiKey: string | null,
): Promise<{ status: number; matches: readonly MatchView[] }> => {
  const response = await harness.app.request(
    `/api/solved-matches?repo=${encodeURIComponent(REPO)}`,
    jsonRequest("GET", apiKey),
  );
  if (response.status !== 200) {
    return { status: response.status, matches: [] };
  }
  const body = (await response.json()) as {
    data: { matches: readonly MatchView[] };
  };
  return { status: response.status, matches: body.data.matches };
};

/** An old solved tree with the given targets. */
const solvedTreeRecords = (
  targets: readonly { kind: string; value: string }[],
  rootOverrides: Record<string, unknown> = {},
): readonly Record<string, unknown>[] => [
  recordEnvelope(
    "work_context",
    validWorkContextBody({
      id: "wc_solved",
      sessionId: OLD_SESSION,
      title: "Refresh 500s after key rotation",
      description: undefined,
      createdAt: OLD_ISO,
    }),
    { sessionId: OLD_SESSION },
  ),
  ...targets.map((target) =>
    recordEnvelope(
      "target",
      { workContextId: "wc_solved", ...target },
      { sessionId: OLD_SESSION },
    ),
  ),
  recordEnvelope(
    "claim",
    validClaimBody({
      id: "clm_old_evidence",
      workContextId: "wc_solved",
      authorSessionId: OLD_SESSION,
      kind: "evidence",
      body: "The trace shows the rotated key id being dropped",
      createdAt: OLD_ISO,
    }),
    { sessionId: OLD_SESSION },
  ),
  recordEnvelope(
    "claim",
    validClaimBody({
      id: "clm_old_root",
      workContextId: "wc_solved",
      authorSessionId: OLD_SESSION,
      kind: "root_cause",
      status: "likely_root_cause",
      confidence: 0.9,
      evidenceRefs: ["clm_old_evidence"],
      body: "The ingestion mapping drops the key id on rotation",
      createdAt: OLD_ISO,
      ...rootOverrides,
    }),
    { sessionId: OLD_SESSION },
  ),
];

/** A context active NOW carrying the given targets. */
const liveContextRecords = (
  targets: readonly { kind: string; value: string }[],
): readonly Record<string, unknown>[] => [
  recordEnvelope(
    "work_context",
    validWorkContextBody({
      id: "wc_live",
      sessionId: LIVE_SESSION,
      title: "Login 500s on staging again",
      description: undefined,
      createdAt: TEST_START_ISO,
    }),
    { sessionId: LIVE_SESSION },
  ),
  ...targets.map((target) =>
    recordEnvelope(
      "target",
      { workContextId: "wc_live", ...target },
      { sessionId: LIVE_SESSION },
    ),
  ),
];

interface Setup {
  readonly harness: TestHarness;
  readonly developer: TestDeveloper;
}

const setup = async (): Promise<Setup> => {
  const { harness, developer } = await createHarnessWithSession({
    id: OLD_SESSION,
  });
  await registerTestSession(harness, developer.apiKey, { id: LIVE_SESSION });
  return { harness, developer };
};

const seed = async (
  setupResult: Setup,
  records: readonly Record<string, unknown>[],
): Promise<void> => {
  const posted = await postRecords(setupResult.harness, setupResult.developer, {
    records,
  });
  if (posted.status !== 200 || (posted.data?.rejected ?? 1) > 0) {
    throw new Error(`seed failed: ${JSON.stringify(posted.data?.results)}`);
  }
};

describe("GET /api/solved-matches", () => {
  test("requires an api key like every other route", async () => {
    // Arrange
    const context = await setup();

    // Act
    const result = await fetchMatches(context.harness, null);

    // Assert
    expect(result.status).toBe(401);
  });

  test("a live context sharing an error fingerprint surfaces the solved tree", async () => {
    // Arrange
    const context = await setup();
    await seed(
      context,
      solvedTreeRecords([
        { kind: "error_fingerprint", value: FINGERPRINT },
        { kind: "file", value: "src/auth/refresh.ts" },
      ]),
    );
    await seed(
      context,
      liveContextRecords([{ kind: "error_fingerprint", value: FINGERPRINT }]),
    );

    // Act
    const result = await fetchMatches(context.harness, context.developer.apiKey);

    // Assert
    expect(result.status).toBe(200);
    expect(result.matches).toHaveLength(1);
    const match = result.matches[0];
    expect(match?.workContextId).toBe("wc_solved");
    expect(match?.title).toBe("Refresh 500s after key rotation");
    expect(match?.developerName).toBe("Nick");
    expect(match?.solvedAt).toBe(OLD_ISO);
    expect(match?.matchedTargetKind).toBe("error_fingerprint");
  });

  test("a shared file surfaces the solved tree with the file match kind", async () => {
    // Arrange
    const context = await setup();
    await seed(
      context,
      solvedTreeRecords([{ kind: "file", value: "src/auth/refresh.ts" }]),
    );
    await seed(
      context,
      liveContextRecords([{ kind: "file", value: "src/auth/refresh.ts" }]),
    );

    // Act
    const result = await fetchMatches(context.harness, context.developer.apiKey);

    // Assert
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.matchedTargetKind).toBe("file");
  });

  test("a symbol-only overlap is not a strong match", async () => {
    // Arrange: symbols recur across unrelated work (helpers, handlers) —
    // below the precision an unasked briefing line demands.
    const context = await setup();
    await seed(
      context,
      solvedTreeRecords([{ kind: "symbol", value: "refreshToken" }]),
    );
    await seed(
      context,
      liveContextRecords([{ kind: "symbol", value: "refreshToken" }]),
    );

    // Act
    const result = await fetchMatches(context.harness, context.developer.apiKey);

    // Assert
    expect(result.matches).toHaveLength(0);
  });

  test("without current activity on the shared target there is no match", async () => {
    // Arrange: the solved tree alone, nothing live touching its targets.
    const context = await setup();
    await seed(
      context,
      solvedTreeRecords([{ kind: "error_fingerprint", value: FINGERPRINT }]),
    );

    // Act
    const result = await fetchMatches(context.harness, context.developer.apiKey);

    // Assert
    expect(result.matches).toHaveLength(0);
  });

  test("a fingerprint match survives a pair window crowded past the cap", async () => {
    // Arrange: one hot shared file (a lockfile shape) across enough unsolved
    // contexts that the (candidate, live, kind) pairs alone exceed
    // SOLVED_MATCH_MAX_PAIR_ROWS — 16 contexts sharing one file make 240
    // ordered pairs. The solved tree's fingerprint pair is seeded LAST: with
    // LIMIT and no ORDER BY the planner chooses which rows survive the cap,
    // and the highest-precision pair is exactly what must never be its
    // choice to drop.
    const context = await setup();
    const hotFile = { kind: "file", value: "bun.lock" };
    const noiseContexts = 15;
    for (let i = 0; i < noiseContexts; i += 1) {
      await seed(context, [
        recordEnvelope(
          "work_context",
          validWorkContextBody({
            id: `wc_noise_${String(i)}`,
            sessionId: LIVE_SESSION,
            title: `Lockfile churn investigation ${String(i)}`,
            description: undefined,
            createdAt: TEST_START_ISO,
          }),
          { sessionId: LIVE_SESSION },
        ),
        recordEnvelope(
          "target",
          { workContextId: `wc_noise_${String(i)}`, ...hotFile },
          { sessionId: LIVE_SESSION },
        ),
      ]);
    }
    await seed(
      context,
      solvedTreeRecords([
        hotFile,
        { kind: "error_fingerprint", value: FINGERPRINT },
      ]),
    );
    await seed(
      context,
      liveContextRecords([{ kind: "error_fingerprint", value: FINGERPRINT }]),
    );

    // Act
    const result = await fetchMatches(context.harness, context.developer.apiKey);

    // Assert: the solved tree surfaces, and through its fingerprint.
    expect(result.status).toBe(200);
    const match = result.matches.find(
      (entry) => entry.workContextId === "wc_solved",
    );
    expect(match?.matchedTargetKind).toBe("error_fingerprint");
  });

  test("an unsolved old tree never surfaces here", async () => {
    // Arrange: same shape, but no evidenced root cause — not solved.
    const context = await setup();
    await seed(context, [
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          id: "wc_solved",
          sessionId: OLD_SESSION,
          title: "Refresh 500s after key rotation",
          description: undefined,
          createdAt: OLD_ISO,
        }),
        { sessionId: OLD_SESSION },
      ),
      recordEnvelope(
        "target",
        {
          workContextId: "wc_solved",
          kind: "error_fingerprint",
          value: FINGERPRINT,
        },
        { sessionId: OLD_SESSION },
      ),
    ]);
    await seed(
      context,
      liveContextRecords([{ kind: "error_fingerprint", value: FINGERPRINT }]),
    );

    // Act
    const result = await fetchMatches(context.harness, context.developer.apiKey);

    // Assert
    expect(result.matches).toHaveLength(0);
  });

  test("a derived root cause never marks a tree solved", async () => {
    // Arrange: the wire admits derived + likely_root_cause + evidence at the
    // confidence cap (schema check), but SOLVED is a trust label and every
    // sibling trust surface (contradictions, similarity-gate, hint selection)
    // gates on declared provenance — solved must too.
    const context = await setup();
    await seed(
      context,
      solvedTreeRecords([{ kind: "error_fingerprint", value: FINGERPRINT }], {
        provenance: "derived",
        captureMode: "auto",
        confidence: 0.5,
      }),
    );
    await seed(
      context,
      liveContextRecords([{ kind: "error_fingerprint", value: FINGERPRINT }]),
    );

    // Act
    const result = await fetchMatches(context.harness, context.developer.apiKey);

    // Assert — a machine's guess is nobody's vouched answer
    expect(result.matches).toHaveLength(0);
  });

  test("a derived rival cannot deadlock a declared solved tree", async () => {
    // Arrange: the peer side of the same gate — a derived rival root cause
    // joined by a contradicts edge is not a standing answer, so it must not
    // censor the solved label off a genuinely vouched diagnosis.
    const context = await setup();
    await seed(context, [
      ...solvedTreeRecords([{ kind: "error_fingerprint", value: FINGERPRINT }]),
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_derived_rival",
          workContextId: "wc_solved",
          authorSessionId: OLD_SESSION,
          kind: "root_cause",
          status: "likely_root_cause",
          provenance: "derived",
          captureMode: "auto",
          confidence: 0.5,
          evidenceRefs: ["clm_old_evidence"],
          body: "The session cache, not the mapping, serves the stale key",
          createdAt: OLD_ISO,
        }),
        { sessionId: OLD_SESSION },
      ),
      recordEnvelope(
        "claim_edge",
        validClaimEdgeBody({
          id: "edge_derived_rival",
          fromClaimId: "clm_derived_rival",
          toClaimId: "clm_old_root",
          kind: "contradicts",
          authorSessionId: OLD_SESSION,
          createdAt: OLD_ISO,
        }),
        { sessionId: OLD_SESSION },
      ),
    ]);
    await seed(
      context,
      liveContextRecords([{ kind: "error_fingerprint", value: FINGERPRINT }]),
    );

    // Act
    const result = await fetchMatches(context.harness, context.developer.apiKey);

    // Assert — the declared diagnosis still reads solved
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.workContextId).toBe("wc_solved");
  });
});
