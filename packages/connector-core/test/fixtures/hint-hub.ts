/**
 * A hub for the hint hooks: candidates and tripwire endpoints with a latency
 * dial, everything else answered instantly — same philosophy as slow-hub.ts
 * (which predates the hints routes and stays untouched: its callers pin budget
 * incidents that never involved these endpoints).
 */

export interface HintHubCalls {
  candidates: number;
  tripwire: number;
  /** GET /api/solved-matches — the failure-time fingerprint probe. */
  solvedMatches: number;
  records: number;
  other: number;
}

export interface HintHubLatency {
  /** GET /api/hints/candidates. */
  candidates: number;
  /** GET /api/hints/tripwire. */
  tripwire: number;
  /** POST /api/records — holds a PostToolUse flush open (state-race tests). */
  records?: number;
}

export interface HintHub {
  readonly url: string;
  readonly calls: HintHubCalls;
  readonly latency: HintHubLatency;
  readonly setCandidates: (candidates: readonly unknown[]) => void;
  /** Answers to the CALLER's own questions, on the same bounded response. */
  readonly setAnswers: (answers: readonly unknown[]) => void;
  readonly setTripwireSessions: (sessions: readonly unknown[]) => void;
  /** Rows GET /api/solved-matches answers with. */
  readonly setSolvedMatches: (matches: readonly unknown[]) => void;
  /** The `?fingerprint=` of the last solved-match probe, or null. */
  readonly lastSolvedFingerprint: () => string | null;
  /** Every record body POSTed to /api/records, in order — the delivery pins. */
  readonly postedRecords: readonly Record<string, unknown>[];
  readonly stop: () => void;
}

export const TEAMMATE_DEVELOPER_ID = "dev_nick";
export const SELF_DEVELOPER_ID = "dev_self";
export const CANDIDATE_CLAIM_ID = "clm_rejected";
export const CANDIDATE_CONTEXT_ID = "wc_nick";
export const CANDIDATE_BODY =
  "Retrying the refresh call does not help; the key is gone";

/** One injectable candidate: Nick's evidence-backed rejected approach. */
export const rejectedApproachCandidate = (): Record<string, unknown> => ({
  workContext: {
    id: CANDIDATE_CONTEXT_ID,
    title: "Refresh 500s after key rotation",
    status: "analyzing",
    tier: "exact",
    developerId: TEAMMATE_DEVELOPER_ID,
    developerName: "Nick",
    baseCommit: "a1b2c3d4e5f6a7b8",
    createdAt: "2026-08-10T08:00:00.000Z",
    updatedAt: null,
  },
  claims: [
    {
      id: CANDIDATE_CLAIM_ID,
      workContextId: CANDIDATE_CONTEXT_ID,
      kind: "rejected_approach",
      status: "rejected",
      confidence: 0.8,
      provenance: "declared",
      captureMode: "agent",
      evidenceRefCount: 1,
      authorDeveloperId: TEAMMATE_DEVELOPER_ID,
      authorDeveloperName: "Nick",
      body: CANDIDATE_BODY,
      createdAt: "2026-08-10T08:00:00.000Z",
    },
  ],
});

/** The same context carrying only a bare proposed hypothesis. */
export const proposedOnlyCandidate = (): Record<string, unknown> => {
  const base = rejectedApproachCandidate();
  const claims = base["claims"] as readonly Record<string, unknown>[];
  return {
    ...base,
    claims: [
      {
        ...claims[0],
        id: "clm_hypo",
        kind: "hypothesis",
        status: "proposed",
        evidenceRefCount: 0,
      },
    ],
  };
};

/** The stated intent the tripwire ask and the intent-only pointer show. */
export const CANDIDATE_INTENT =
  "Stop the refresh 500s by refetching the JWKS on an unknown kid";

const derivedCandidateIntent = (): Record<string, unknown> => ({
  summary: CANDIDATE_INTENT,
  provenance: "derived",
  confidence: 0.4,
  capturedAt: "2026-08-10T08:05:00.000Z",
});

/**
 * The same context carrying ONLY a derived intent — no claims at all: the
 * "same topic, different files" shape (trial finding #16) that used to be
 * invisible, and now earns a pointer.
 */
export const intentOnlyCandidate = (): Record<string, unknown> => {
  const base = rejectedApproachCandidate();
  return {
    ...base,
    workContext: {
      ...(base["workContext"] as Record<string, unknown>),
      intent: derivedCandidateIntent(),
    },
    claims: [],
  };
};

export const ANSWER_QUESTION_ID = "qn_backoff";
export const ANSWER_CLAIM_ID = "clm_answer";
export const ANSWER_BODY =
  "Both share one token bucket, so the uploader starves the importer";
export const ASKED_BODY = "Is the uploader's backoff shared with the importer?";

/**
 * One answer to a question the READER asked (roadmap R2). Deliberately a
 * BARE PROPOSED OBSERVATION with no evidence — the shape the anchoring
 * asymmetry keeps out of the proactive path. It is delivered as substance
 * only because it was solicited, which is what the §4 exception says and what
 * question-delivery.test.ts pins against the unsolicited control.
 */
export const ANSWER_CONTEXT_ID = "wc_nick_answer";

export const answeredQuestion = (): Record<string, unknown> => ({
  questionId: ANSWER_QUESTION_ID,
  questionBody: ASKED_BODY,
  claimId: ANSWER_CLAIM_ID,
  workContextId: ANSWER_CONTEXT_ID,
  claimBody: ANSWER_BODY,
  claimKind: "observation",
  claimStatus: "proposed",
  confidence: 0.6,
  provenance: "declared",
  answererDeveloperName: "Nick",
  answeredAt: "2026-08-19T09:00:00.000Z",
});

/**
 * One solved tree carrying the failure's own fingerprint — a FINGERPRINT
 * match, so it is the shape allowed to quote its recorded cause.
 */
export const SOLVED_CONTEXT_ID = "wc_solved_before";
export const SOLVED_ROOT_CAUSE =
  "The ingestion mapping drops the key id on rotation";

export const solvedFingerprintMatch = (): Record<string, unknown> => ({
  workContextId: SOLVED_CONTEXT_ID,
  title: "Refresh 500s after key rotation",
  developerName: "Nick",
  repo: "github.com/acme/web",
  solvedAt: "2026-03-12T08:00:00.000Z",
  landedAt: null,
  matchedTargetKind: "error_fingerprint",
  rootCause: SOLVED_ROOT_CAUSE,
});

export const activeTeammateSession = (): Record<string, unknown> => ({
  sessionId: "cc_nick",
  developerId: TEAMMATE_DEVELOPER_ID,
  developerName: "Nick",
  branch: "feat/refresh-fix",
  status: "implementing",
  lastHeartbeatAt: new Date().toISOString(),
  workContextId: CANDIDATE_CONTEXT_ID,
  workContextTitle: "Refresh 500s after key rotation",
  workContextIntent: derivedCandidateIntent(),
});

const sleep = (ms: number): Promise<void> =>
  ms <= 0
    ? Promise.resolve()
    : new Promise((done) => {
        setTimeout(done, ms);
      });

export const startHintHub = (
  latency: HintHubLatency = { candidates: 0, tripwire: 0 },
): HintHub => {
  const calls: HintHubCalls = {
    candidates: 0,
    tripwire: 0,
    solvedMatches: 0,
    records: 0,
    other: 0,
  };
  let candidates: readonly unknown[] = [rejectedApproachCandidate()];
  let answers: readonly unknown[] = [];
  let tripwireSessions: readonly unknown[] = [];
  let solvedMatches: readonly unknown[] = [];
  let lastSolvedFingerprint: string | null = null;
  const postedRecords: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/hints/candidates") {
        calls.candidates += 1;
        await sleep(latency.candidates);
        return Response.json({ ok: true, data: { candidates, answers } });
      }
      if (pathname === "/api/solved-matches") {
        calls.solvedMatches += 1;
        lastSolvedFingerprint = new URL(request.url).searchParams.get(
          "fingerprint",
        );
        return Response.json({ ok: true, data: { matches: solvedMatches } });
      }
      if (pathname === "/api/hints/tripwire") {
        calls.tripwire += 1;
        await sleep(latency.tripwire);
        return Response.json({ ok: true, data: { sessions: tripwireSessions } });
      }
      if (pathname === "/api/records") {
        const body = (await request.json()) as { records: readonly unknown[] };
        calls.records += 1;
        postedRecords.push(...(body.records as Record<string, unknown>[]));
        await sleep(latency.records ?? 0);
        return Response.json({
          ok: true,
          data: {
            accepted: body.records.length,
            duplicates: 0,
            ignored: 0,
            rejected: 0,
          },
        });
      }
      calls.other += 1;
      return Response.json({
        ok: true,
        data: { session: { id: "cc_x", developerId: SELF_DEVELOPER_ID } },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    latency,
    postedRecords,
    setCandidates: (next) => {
      candidates = next;
    },
    setAnswers: (next) => {
      answers = next;
    },
    setTripwireSessions: (next) => {
      tripwireSessions = next;
    },
    setSolvedMatches: (next) => {
      solvedMatches = next;
    },
    lastSolvedFingerprint: () => lastSolvedFingerprint,
    stop: () => {
      server.stop(true);
    },
  };
};
