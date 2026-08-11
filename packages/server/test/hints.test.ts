import { describe, expect, test } from "bun:test";

import { createRecordingEmbedder } from "./fixtures/fake-embedder.ts";
import { HINT_MAX_CLAIMS_PER_CONTEXT } from "../src/services/hints.ts";
import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  createTestHarness,
  createTestDeveloper,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validClaimBody,
  validClaimEdgeBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
const SECOND_SESSION_ID = "ses_02";
const TARGET_FILE = "src/auth/refresh.ts";

interface ClaimCandidateView {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly evidenceRefCount: number;
  readonly authorDeveloperName: string;
  readonly body: string;
}

interface ContextCandidateView {
  readonly workContext: {
    readonly id: string;
    readonly title: string;
    readonly tier: string;
    readonly developerName: string;
    readonly baseCommit: string;
  };
  readonly claims: readonly ClaimCandidateView[];
}

const fetchCandidates = async (
  harness: TestHarness,
  developer: TestDeveloper,
  query: string,
): Promise<{ status: number; candidates: readonly ContextCandidateView[] }> => {
  const params = new URLSearchParams({ query, repo: REPO });
  const response = await harness.app.request(
    `/api/hints/candidates?${params.toString()}`,
    jsonRequest("GET", developer.apiKey),
  );
  if (response.status !== 200) {
    return { status: response.status, candidates: [] };
  }
  const body = (await response.json()) as {
    data: { candidates: readonly ContextCandidateView[] };
  };
  return { status: response.status, candidates: body.data.candidates };
};

interface TripwireSessionView {
  readonly sessionId: string;
  readonly developerName: string;
  readonly branch: string;
  readonly lastHeartbeatAt: string;
  readonly workContextTitle: string;
}

const fetchTripwire = async (
  harness: TestHarness,
  developer: TestDeveloper,
  value: string,
): Promise<{ status: number; sessions: readonly TripwireSessionView[] }> => {
  const params = new URLSearchParams({ repo: REPO, value });
  const response = await harness.app.request(
    `/api/hints/tripwire?${params.toString()}`,
    jsonRequest("GET", developer.apiKey),
  );
  if (response.status !== 200) {
    return { status: response.status, sessions: [] };
  }
  const body = (await response.json()) as {
    data: { sessions: readonly TripwireSessionView[] };
  };
  return { status: response.status, sessions: body.data.sessions };
};

/** Nick's context with the auth-refresh file target and two claims. */
const seedNickContext = async (
  harness: TestHarness,
  nick: TestDeveloper,
): Promise<void> => {
  const seeded = await postRecords(harness, nick, {
    records: [
      recordEnvelope(
        "work_context",
        validWorkContextBody({ title: "Refresh 500s after key rotation" }),
      ),
      recordEnvelope("target", {
        workContextId: WORK_CONTEXT_ID,
        kind: "file",
        value: TARGET_FILE,
      }),
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_rejected",
          kind: "rejected_approach",
          body: "Retrying the refresh call does not help; the key is gone",
          status: "rejected",
          evidenceRefs: ["clm_01"],
        }),
      ),
      recordEnvelope("claim", validClaimBody()),
    ],
  });
  expect(seeded.data?.accepted).toBe(4);
};

const setupTwoDevelopers = async (): Promise<{
  harness: TestHarness;
  nick: TestDeveloper;
  robin: TestDeveloper;
}> => {
  const { harness, developer: nick } = await createHarnessWithSession();
  await seedNickContext(harness, nick);
  const robin = await addTestDeveloperWithSession(
    harness,
    "Robin",
    "robin@example.com",
    { id: SECOND_SESSION_ID, branch: "fix/refresh-500" },
  );
  return { harness, nick, robin };
};

describe("GET /api/hints/candidates", () => {
  test("returns a matching teammate context with claims and trust fields", async () => {
    // Arrange
    const { harness, robin } = await setupTwoDevelopers();

    // Act — Robin's prompt mentions the file Nick's context targets
    const result = await fetchCandidates(harness, robin, "why does refresh.ts 500");

    // Assert
    expect(result.status).toBe(200);
    expect(result.candidates.length).toBe(1);
    const candidate = result.candidates[0];
    expect(candidate?.workContext.id).toBe(WORK_CONTEXT_ID);
    expect(candidate?.workContext.tier).toBe("exact");
    expect(candidate?.workContext.developerName).toBe("Nick");
    expect(candidate?.workContext.baseCommit).toBe(VALID_SESSION_BODY.baseCommit);
    const rejected = candidate?.claims.find((claim) => claim.id === "clm_rejected");
    expect(rejected?.kind).toBe("rejected_approach");
    expect(rejected?.evidenceRefCount).toBe(1);
    expect(rejected?.authorDeveloperName).toBe("Nick");
  });

  test("a solved candidate context carries the solved kind and diagnosis age", async () => {
    // Arrange: Nick's tree gains an evidenced, non-superseded root cause —
    // the solved rule (services/solved.ts). The hints surface must hand the
    // renderer the same fact search results carry, so the hint can say
    // "from a solved diagnosis" with its age.
    const { harness, nick, robin } = await setupTwoDevelopers();
    await postRecords(harness, nick, {
      records: [
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_root",
            kind: "root_cause",
            status: "likely_root_cause",
            confidence: 0.9,
            evidenceRefs: ["clm_01"],
            body: "The rotation job drops the key id before re-signing",
          }),
        ),
      ],
    });

    // Act
    const result = await fetchCandidates(harness, robin, "refresh.ts");

    // Assert
    const context = result.candidates[0]?.workContext as
      | { resultKind?: string; solvedAt?: string | null }
      | undefined;
    expect(context?.resultKind).toBe("solved");
    expect(typeof context?.solvedAt).toBe("string");
  });

  test("an unsolved candidate context is marked open", async () => {
    // Arrange
    const { harness, robin } = await setupTwoDevelopers();

    // Act
    const result = await fetchCandidates(harness, robin, "refresh.ts");

    // Assert
    const context = result.candidates[0]?.workContext as
      | { resultKind?: string; solvedAt?: string | null }
      | undefined;
    expect(context?.resultKind).toBe("open");
    expect(context?.solvedAt).toBeNull();
  });

  test("excludes the caller's own work contexts", async () => {
    // Arrange
    const { harness, nick } = await setupTwoDevelopers();

    // Act — Nick asks about his own work
    const result = await fetchCandidates(harness, nick, "why does refresh.ts 500");

    // Assert — a developer's own context is knowledge, not a hint
    expect(result.status).toBe(200);
    expect(result.candidates.length).toBe(0);
  });

  test("a query matching nothing yields no candidates, not recency filler", async () => {
    // Arrange
    const { harness, robin } = await setupTwoDevelopers();

    // Act
    const result = await fetchCandidates(harness, robin, "quantum chromodynamics");

    // Assert — a NON-blank miss returns zero search rows, so this silence
    // does not exercise the tier floor; the blank-query test below is the
    // one that does.
    expect(result.status).toBe(200);
    expect(result.candidates.length).toBe(0);
  });

  test("a blank query yields no candidates although recency rows exist", async () => {
    // Arrange — Nick's fresh context would top a recency listing
    const { harness, robin } = await setupTwoDevelopers();

    // Act — blank is route-reachable (the route defaults query to ""), and
    // the connector's own hasSearchableWord gate never fires for a non-Claude
    // consumer of /api/hints/candidates
    const result = await fetchCandidates(harness, robin, "");

    // Assert — a blank query DOES return recency rows from the search, so
    // HINT_ELIGIBLE_TIERS is the only thing standing between this endpoint
    // and the filler feed its comment names; widening the server's tier
    // floor to include "recency" turns this red
    expect(result.status).toBe(200);
    expect(result.candidates.length).toBe(0);
  });

  test("never embeds the query — the vector tier is not part of the sync path", async () => {
    // Arrange: a hub WITH an embedder configured
    const embedder = createRecordingEmbedder();
    const harness = await createTestHarness({ embedder });
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    await registerTestSession(harness, nick.apiKey);
    await seedNickContext(harness, nick);
    const robin = await addTestDeveloperWithSession(
      harness,
      "Robin",
      "robin@example.com",
      { id: SECOND_SESSION_ID },
    );
    const query = "authentication login failure after refresh";

    // Act
    const result = await fetchCandidates(harness, robin, query);

    // Assert — ingest may embed docs, but the hint path must not embed the
    // query: the embed deadline alone (2 s) is wider than the whole 800 ms
    // hook budget this endpoint serves.
    expect(result.status).toBe(200);
    expect(embedder.embeddedTexts).not.toContain(query);
  });

  test("rejects an oversized query at the boundary", async () => {
    const { harness, robin } = await setupTwoDevelopers();
    const result = await fetchCandidates(harness, robin, "x".repeat(2001));
    expect(result.status).toBe(400);
  });
});

/** A timestamp strictly after every record TEST_START_ISO stamps. */
const LATER_ISO = "2026-07-24T10:00:00.000Z";

describe("candidate pool integrity", () => {
  test("a claim revised away by a supersedes edge is no longer served", async () => {
    // Arrange — Nick publishes a theory, then revises it: append-only,
    // revision = new claim + supersedes edge (DESIGN.md §5)
    const { harness, nick, robin } = await setupTwoDevelopers();
    const revised = await postRecords(harness, nick, {
      records: [
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_old_theory",
            kind: "root_cause",
            body: "The cache TTL is the root cause of the refresh 500s",
            status: "likely_root_cause",
            evidenceRefs: ["clm_01"],
          }),
        ),
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_new_theory",
            kind: "root_cause",
            body: "The rotated key never reached the refresh worker",
            status: "likely_root_cause",
            evidenceRefs: ["clm_01"],
            createdAt: LATER_ISO,
          }),
        ),
        recordEnvelope(
          "claim_edge",
          validClaimEdgeBody({
            id: "edge_supersede",
            fromClaimId: "clm_new_theory",
            toClaimId: "clm_old_theory",
            kind: "supersedes",
          }),
        ),
      ],
    });
    expect(revised.data?.accepted).toBe(3);

    // Act — Robin's prompt touches the context after the revision landed
    const result = await fetchCandidates(harness, robin, "why does refresh.ts 500");

    // Assert — the retracted theory must never reach a reader's context
    const ids = result.candidates[0]?.claims.map((claim) => claim.id) ?? [];
    expect(ids).toContain("clm_new_theory");
    expect(ids).not.toContain("clm_old_theory");
  });

  test("the caller's own contexts cannot crowd a teammate's out of the pool", async () => {
    // Arrange — Nick's finding is two months old (decay ranks it below any
    // fresh context); Robin then fills a whole search pool with his own fresh
    // contexts on the same file. The teammate row must be excluded from the
    // SEARCH, not filtered after the pool bound.
    const OLD_ISO = "2026-05-25T09:00:00.000Z";
    const { harness, developer: nick } = await createHarnessWithSession();
    const seeded = await postRecords(harness, nick, {
      records: [
        recordEnvelope(
          "work_context",
          validWorkContextBody({
            title: "Refresh 500s after key rotation",
            createdAt: OLD_ISO,
          }),
        ),
        recordEnvelope("target", {
          workContextId: WORK_CONTEXT_ID,
          kind: "file",
          value: TARGET_FILE,
        }),
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_rejected",
            kind: "rejected_approach",
            body: "Retrying the refresh call does not help; the key is gone",
            status: "rejected",
            evidenceRefs: ["clm_01"],
            createdAt: OLD_ISO,
          }),
        ),
      ],
    });
    expect(seeded.data?.accepted).toBe(3);
    const robin = await addTestDeveloperWithSession(
      harness,
      "Robin",
      "robin@example.com",
      { id: SECOND_SESSION_ID },
    );
    const OWN_CONTEXTS = 10;
    const ownRecords = Array.from({ length: OWN_CONTEXTS }, (_, index) => {
      const id = `wc_robin_${String(index).padStart(2, "0")}`;
      return [
        recordEnvelope(
          "work_context",
          validWorkContextBody({
            id,
            sessionId: SECOND_SESSION_ID,
            title: `Robin session number ${String(index)}`,
          }),
          { sessionId: SECOND_SESSION_ID },
        ),
        recordEnvelope(
          "target",
          { workContextId: id, kind: "file", value: TARGET_FILE },
          { sessionId: SECOND_SESSION_ID },
        ),
      ];
    }).flat();
    const posted = await postRecords(harness, robin, { records: ownRecords });
    expect(posted.data?.accepted).toBe(OWN_CONTEXTS * 2);

    // Act
    const result = await fetchCandidates(harness, robin, "why does refresh.ts 500");

    // Assert — Nick's context must survive however active Robin is
    const ids = result.candidates.map((candidate) => candidate.workContext.id);
    expect(ids).toContain(WORK_CONTEXT_ID);
  });

  test("a claim-heavy context cannot starve a sibling context's claim window", async () => {
    // Arrange — Nick's first context holds two whole windows of older claims;
    // his second context on the same file holds one fresh claim
    const { harness, nick, robin } = await setupTwoDevelopers();
    const fillers = Array.from(
      { length: HINT_MAX_CLAIMS_PER_CONTEXT * 2 },
      (_, index) =>
        recordEnvelope(
          "claim",
          validClaimBody({
            id: `clm_filler_${String(index).padStart(2, "0")}`,
            body: `Observation number ${String(index)} about the refresh handler`,
          }),
        ),
    );
    const seeded = await postRecords(harness, nick, {
      records: [
        ...fillers,
        recordEnvelope(
          "work_context",
          validWorkContextBody({
            id: "wc_sibling",
            title: "Key rotation window during refresh",
          }),
        ),
        recordEnvelope("target", {
          workContextId: "wc_sibling",
          kind: "file",
          value: TARGET_FILE,
        }),
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_sibling",
            workContextId: "wc_sibling",
            body: "The sibling context's only claim",
            createdAt: LATER_ISO,
          }),
        ),
      ],
    });
    expect(seeded.data?.accepted).toBe(HINT_MAX_CLAIMS_PER_CONTEXT * 2 + 3);

    // Act
    const result = await fetchCandidates(harness, robin, "why does refresh.ts 500");

    // Assert — each context's claim window is its own
    const sibling = result.candidates.find(
      (candidate) => candidate.workContext.id === "wc_sibling",
    );
    expect(sibling?.claims.map((claim) => claim.id)).toContain("clm_sibling");
  });

  test("the newest claims survive when a context outgrows its window", async () => {
    // Arrange — append-only revision means the most settled claim is the
    // NEWEST; bury it under one whole window of older observations
    const { harness, nick, robin } = await setupTwoDevelopers();
    const fillers = Array.from(
      { length: HINT_MAX_CLAIMS_PER_CONTEXT },
      (_, index) =>
        recordEnvelope(
          "claim",
          validClaimBody({
            id: `clm_early_${String(index).padStart(2, "0")}`,
            body: `Early observation number ${String(index)}`,
          }),
        ),
    );
    const seeded = await postRecords(harness, nick, {
      records: [
        ...fillers,
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_settled_late",
            kind: "root_cause",
            status: "likely_root_cause",
            evidenceRefs: ["clm_01"],
            body: "Settled on day five: the rotated key never propagated",
            createdAt: LATER_ISO,
          }),
        ),
      ],
    });
    expect(seeded.data?.accepted).toBe(HINT_MAX_CLAIMS_PER_CONTEXT + 1);

    // Act
    const result = await fetchCandidates(harness, robin, "why does refresh.ts 500");

    // Assert — the window keeps the newest claims, not the oldest
    const candidate = result.candidates.find(
      (row) => row.workContext.id === WORK_CONTEXT_ID,
    );
    expect(candidate?.claims.map((claim) => claim.id)).toContain(
      "clm_settled_late",
    );
  });
});

describe("GET /api/hints/tripwire", () => {
  test("reports an active teammate session targeting the same file", async () => {
    // Arrange
    const { harness, robin } = await setupTwoDevelopers();

    // Act — Robin is about to edit the file Nick's live session targeted
    const result = await fetchTripwire(harness, robin, TARGET_FILE);

    // Assert
    expect(result.status).toBe(200);
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0]?.developerName).toBe("Nick");
    expect(result.sessions[0]?.branch).toBe(VALID_SESSION_BODY.branch);
    expect(result.sessions[0]?.workContextTitle).toBe(
      "Refresh 500s after key rotation",
    );
  });

  test("the caller's own sessions never trip it", async () => {
    // Arrange
    const { harness, nick } = await setupTwoDevelopers();

    // Act
    const result = await fetchTripwire(harness, nick, TARGET_FILE);

    // Assert — own parallel worktrees are the self-exclusion case (§4)
    expect(result.status).toBe(200);
    expect(result.sessions.length).toBe(0);
  });

  test("a stale heartbeat is not an active session", async () => {
    // Arrange
    const { harness, robin } = await setupTwoDevelopers();
    harness.clock.advanceSeconds(91);

    // Act
    const result = await fetchTripwire(harness, robin, TARGET_FILE);

    // Assert — presence-fresh means heartbeat inside the 90 s TTL
    expect(result.sessions.length).toBe(0);
  });

  test("a different file does not trip", async () => {
    const { harness, robin } = await setupTwoDevelopers();
    const result = await fetchTripwire(harness, robin, "src/other/file.ts");
    expect(result.sessions.length).toBe(0);
  });
});
