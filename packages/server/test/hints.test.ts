import { describe, expect, test } from "bun:test";

import { createRecordingEmbedder } from "./fixtures/fake-embedder.ts";
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

    // Assert
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
