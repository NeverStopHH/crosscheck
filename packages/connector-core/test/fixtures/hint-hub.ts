/**
 * A hub for the hint hooks: candidates and tripwire endpoints with a latency
 * dial, everything else answered instantly — same philosophy as slow-hub.ts
 * (which predates the hints routes and stays untouched: its callers pin budget
 * incidents that never involved these endpoints).
 */
import { serveLoopback } from "./loopback-serve.ts";

import { DELIVERY_CHANNELS } from "@crosscheck/schema";

export interface HintHubCalls {
  candidates: number;
  tripwire: number;
  /** GET /api/solved-matches — the failure-time fingerprint probe. */
  solvedMatches: number;
  records: number;
  /** GET /api/presence — the statusline's poll and the relay's one refresh. */
  presence: number;
  other: number;
}

export interface HintHubLatency {
  /** GET /api/hints/candidates. */
  candidates: number;
  /** GET /api/hints/tripwire. */
  tripwire: number;
  /** POST /api/records — holds a PostToolUse flush open (state-race tests). */
  records?: number;
  /** GET /api/solved-matches — the failure-time probe's own latency dial. */
  solvedMatches?: number;
  /** GET /api/presence — holds a presence answer past a caller's bound. */
  presence?: number;
}

export interface HintHub {
  readonly url: string;
  readonly calls: HintHubCalls;
  readonly latency: HintHubLatency;
  readonly setCandidates: (candidates: readonly unknown[]) => void;
  /** Whether the candidates, tripwire and solved-match answers say this repo records hint outcomes (07 §13); undefined omits it. */
  readonly setRecordsOutcomes: (recordsOutcomes: boolean | undefined) => void;
  /** Answers to the CALLER's own questions, on the same bounded response. */
  readonly setAnswers: (answers: readonly unknown[]) => void;
  /** The author's notices (landed changes, step 4), on the same response. */
  readonly setNotices: (notices: readonly unknown[]) => void;
  /** The coverage record on the same response; unset, the field is absent. */
  readonly setCoverage: (coverage: unknown) => void;
  /**
   * The delivery channels the hub advertises — every channel a current hub
   * records by default; undefined answers like a hub too old to send it.
   */
  readonly setDeliveryChannels: (channels: readonly string[] | undefined) => void;
  readonly setTripwireSessions: (sessions: readonly unknown[]) => void;
  /** The sessions the tripwire answers for ONE file; other files keep `setTripwireSessions`'s answer. */
  readonly setTripwireSessionsFor: (file: string, sessions: readonly unknown[]) => void;
  /** A status the tripwire fails with (an error envelope), or null to answer again. */
  readonly setTripwireFailure: (status: number | null) => void;
  /**
   * The rows GET /api/presence answers with; null (the default) answers with a
   * body the client cannot read, which is what this hub always did.
   */
  readonly setPresence: (sessions: readonly unknown[] | null) => void;
  /**
   * Run while a GET /api/presence is in flight, before it is answered: what a
   * test sees of the caller's own state at the moment it waits on presence.
   */
  readonly setPresenceProbe: (probe: (() => Promise<void>) | null) => void;
  /** The same, for GET /api/hints/candidates: the caller's state at the moment it asks for a hint. */
  readonly setCandidatesProbe: (probe: (() => Promise<void>) | null) => void;
  /** Rows GET /api/solved-matches answers with. */
  readonly setSolvedMatches: (matches: readonly unknown[]) => void;
  /** The `?fingerprint=` of the last solved-match probe, or null. */
  readonly lastSolvedFingerprint: () => string | null;
  /** The query string of the last candidates call — what went on the wire. */
  readonly lastCandidatesQuery: () => URLSearchParams | null;
  /** Every record body POSTed to /api/records, in order — the delivery pins. */
  readonly postedRecords: readonly Record<string, unknown>[];
  readonly stop: () => void;
}

export const TEAMMATE_DEVELOPER_ID = "dev_nick";
export const SELF_DEVELOPER_ID = "dev_self";
export const CANDIDATE_CLAIM_ID = "clm_cause";
export const CANDIDATE_CONTEXT_ID = "wc_nick";
export const CANDIDATE_BODY =
  "Retrying the refresh call does not help; the key is gone";

/**
 * One injectable candidate: Nick's settled, evidence-backed root cause — the
 * hub resolved its evidence (review 1006b, H4: only a settled root cause or a
 * stated decision is substance; a rejected approach is a pointer).
 */
export const injectableCandidate = (): Record<string, unknown> => ({
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
    // Its own title shares "key" and "rotation" with the canned prompt: the
    // tree is about it (round 4, C2).
    matchedTerms: 2,
  },
  claims: [
    {
      id: CANDIDATE_CLAIM_ID,
      workContextId: CANDIDATE_CONTEXT_ID,
      kind: "root_cause",
      status: "likely_root_cause",
      confidence: 0.8,
      provenance: "declared",
      captureMode: "agent",
      evidenceRefCount: 1,
      evidenceBacked: true,
      authorDeveloperId: TEAMMATE_DEVELOPER_ID,
      authorDeveloperName: "Nick",
      body: CANDIDATE_BODY,
      // What a current hub counts for the canned prompt ("why does
      // src/auth/refresh.ts still 500 after the key rotation") against this
      // body: "refresh" and "key" — a strong match, so this stays substance;
      // the only candidate, so no other tree says either (round 4, C2).
      matchedTerms: 2,
      distinctTerms: 2,
      createdAt: "2026-08-10T08:00:00.000Z",
    },
  ],
});

/** The same tree carrying Nick's rejected approach instead: a pointer since H4. */
export const rejectedApproachCandidate = (): Record<string, unknown> => {
  const base = injectableCandidate();
  const claims = base["claims"] as readonly Record<string, unknown>[];
  return {
    ...base,
    claims: [{ ...claims[0], id: "clm_rejected", kind: "rejected_approach", status: "rejected" }],
  };
};

/** The same context carrying only a bare proposed hypothesis. */
export const proposedOnlyCandidate = (): Record<string, unknown> => {
  const base = injectableCandidate();
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
  const base = injectableCandidate();
  return {
    ...base,
    workContext: {
      ...(base["workContext"] as Record<string, unknown>),
      intent: derivedCandidateIntent(),
    },
    claims: [],
  };
};

/** Both rungs reaped since a week before `now`: the coverage note at its two-line length. */
export const reapedCoverage = (repo: string, now: Date): Record<string, unknown> => {
  const gapSince = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  return {
    repo,
    computedAt: now.toISOString(),
    scope: { sinceIso: gapSince },
    order: { state: "undeclared", reason: "hub_did_not_report" },
    sources: [
      { source: "agent_event", state: "incomplete", reason: "session_reaped", gapSince, observedAt: gapSince },
      { source: "git", state: "incomplete", reason: "commits_reported", gapSince, observedAt: gapSince },
      { source: "ci", state: "unavailable", reason: "no_emitter", gapSince: null, observedAt: null },
      { source: "runtime", state: "unavailable", reason: "out_of_scope_1_0", gapSince: null, observedAt: null },
      { source: "human_edit", state: "unavailable", reason: "no_platform_rung", gapSince: null, observedAt: null },
    ],
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
  rootCauseConfidence: 0.9,
});

/**
 * The #19 shape: the same exact-tier context with NO claims but a file target
 * the prompt named — the case that used to yield silence (foreignCount 0) and
 * now yields a targets-only pointer.
 */
export const targetsOnlyCandidate = (): Record<string, unknown> => {
  const base = injectableCandidate();
  return {
    ...base,
    claims: [],
    matchedTargets: [
      {
        kind: "file",
        value: "src/auth/refresh.ts",
        createdAt: "2026-08-10T08:00:00.000Z",
      },
    ],
  };
};

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
    presence: 0,
    other: 0,
  };
  let presence: readonly unknown[] | null = null;
  let presenceProbe: (() => Promise<void>) | null = null;
  let candidatesProbe: (() => Promise<void>) | null = null;
  let candidates: readonly unknown[] = [injectableCandidate()];
  /** Absent unless a test sets it — what every hub before 07 §13 sends. */
  let recordsOutcomes: boolean | undefined;
  let answers: readonly unknown[] = [];
  let notices: readonly unknown[] = [];
  let coverage: unknown = undefined;
  let deliveryChannels: readonly string[] | undefined = [...DELIVERY_CHANNELS];
  let tripwireSessions: readonly unknown[] = [];
  const tripwireByFile = new Map<string, readonly unknown[]>();
  let tripwireFailure: number | null = null;
  let solvedMatches: readonly unknown[] = [];
  let lastSolvedFingerprint: string | null = null;
  let lastCandidatesQuery: URLSearchParams | null = null;
  const postedRecords: Record<string, unknown>[] = [];
  const server = serveLoopback({
    port: 0,
    fetch: async (request) => {
      const { pathname, searchParams } = new URL(request.url);
      if (pathname === "/api/hints/candidates") {
        calls.candidates += 1;
        lastCandidatesQuery = searchParams;
        await candidatesProbe?.();
        await sleep(latency.candidates);
        return Response.json({
          ok: true,
          data: {
            candidates,
            answers,
            notices,
            coverage,
            deliveryChannels,
            ...(recordsOutcomes === undefined ? {} : { recordsOutcomes }),
          },
        });
      }
      if (pathname === "/api/solved-matches") {
        calls.solvedMatches += 1;
        await sleep(latency.solvedMatches ?? 0);
        lastSolvedFingerprint = new URL(request.url).searchParams.get(
          "fingerprint",
        );
        return Response.json({
          ok: true,
          data: { matches: solvedMatches, ...(recordsOutcomes === undefined ? {} : { recordsOutcomes }) },
        });
      }
      if (pathname === "/api/hints/tripwire") {
        calls.tripwire += 1;
        await sleep(latency.tripwire);
        if (tripwireFailure !== null) {
          return Response.json({ ok: false, error: { code: "unavailable", message: "tripwire down" } }, { status: tripwireFailure });
        }
        const sessions = tripwireByFile.get(searchParams.get("value") ?? "") ?? tripwireSessions;
        return Response.json({
          ok: true,
          data: { sessions, ...(recordsOutcomes === undefined ? {} : { recordsOutcomes }) },
        });
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
      if (pathname === "/api/presence") {
        calls.presence += 1;
        await presenceProbe?.();
        await sleep(latency.presence ?? 0);
        if (presence !== null) {
          return Response.json({ ok: true, data: { sessions: presence } });
        }
      } else {
        calls.other += 1;
      }
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
    setRecordsOutcomes: (next) => {
      recordsOutcomes = next;
    },
    setAnswers: (next) => {
      answers = next;
    },
    setNotices: (next) => {
      notices = next;
    },
    setCoverage: (next) => {
      coverage = next;
    },
    setDeliveryChannels: (next) => {
      deliveryChannels = next;
    },
    setTripwireSessions: (next) => {
      tripwireSessions = next;
    },
    setTripwireSessionsFor: (file, next) => {
      tripwireByFile.set(file, next);
    },
    setTripwireFailure: (status) => {
      tripwireFailure = status;
    },
    setPresence: (next) => {
      presence = next;
    },
    setPresenceProbe: (next) => {
      presenceProbe = next;
    },
    setCandidatesProbe: (next) => {
      candidatesProbe = next;
    },
    setSolvedMatches: (next) => {
      solvedMatches = next;
    },
    lastSolvedFingerprint: () => lastSolvedFingerprint,
    lastCandidatesQuery: () => lastCandidatesQuery,
    stop: () => {
      server.stop(true);
    },
  };
};
