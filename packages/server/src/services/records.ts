import { eq } from "drizzle-orm";
import { parseRecord } from "@crosscheck/schema";
import type {
  Claim,
  ClaimEdge,
  CommitEvidence,
  HintDelivery,
  KnownRecordKind,
  LandedEvidence,
  Question,
  QuestionAnswer,
  Target,
  WorkContext,
} from "@crosscheck/schema";

import { agentSessions } from "../db/schema.ts";
import { ingestCommitEvidence } from "./commit-evidence.ts";
import { ingestHintDelivery } from "./hint-deliveries.ts";
import { ingestLandedEvidence } from "./landed.ts";
import { embedContextDoc } from "./normalized-doc.ts";
import { answerQuestion, askQuestionFromRecord } from "./questions.ts";
import {
  ingestClaim,
  ingestClaimEdge,
  ingestTarget,
  ingestWorkContext,
  rejectedOutcome,
} from "./record-handlers.ts";
import type { HandlerOutcome, RecordStatus } from "./record-handlers.ts";
import type { Db } from "../db/client.ts";
import type { Embedder } from "./embedder.ts";
import type { Clock } from "../types.ts";

interface Deps {
  readonly db: Db;
  readonly now: Clock;
  /** Enables the ingest-side embedding work; absent = keyless install. */
  readonly embedder?: Embedder | null;
}

export interface RecordResult {
  readonly index: number;
  readonly status: RecordStatus;
  readonly id?: string;
  readonly issues?: readonly string[];
}

export interface IngestSummary {
  readonly results: readonly RecordResult[];
  readonly accepted: number;
  readonly duplicates: number;
  readonly ignored: number;
  readonly rejected: number;
}

type IngestableKind = Exclude<KnownRecordKind, "session" | "hint">;

/** Kinds that parse fine but are never ingested over this endpoint. */
const NOT_INGESTABLE_NOTES: Readonly<Partial<Record<KnownRecordKind, string>>> =
  {
    session:
      "kind session: sessions are registered via /api/sessions, not ingested",
    hint: "kind hint: hints are server-emitted, not ingested",
  };

// Liveness gate for the PRODUCER session only: author sessions referenced in
// record bodies MAY already be ended — a spool flush arriving via a successor
// session is legitimate. Only the session doing the flushing must be live.
const checkProducerSession = async (
  db: Db,
  developerId: string,
  sessionId: string,
): Promise<string | null> => {
  const rows = await db
    .select({
      developerId: agentSessions.developerId,
      endedAt: agentSessions.endedAt,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  const session = rows[0];
  if (session === undefined) {
    return `producer.sessionId: session "${sessionId}" not found`;
  }
  if (session.developerId !== developerId) {
    return "producer.sessionId: session belongs to another developer";
  }
  if (session.endedAt !== null) {
    return "producer.sessionId: session has already ended — late writes are rejected";
  }
  return null;
};

/**
 * The spool-replay path for a question (roadmap R2). The TOOL asks through
 * `POST /api/questions`, which resolves a developer name and can refuse in
 * sentences; this path carries an already-resolved question that a flush is
 * re-sending, so its whole job is to reach the same service with the same
 * rules. A budget refusal is a REJECTION here — a spool cannot retry into a
 * budget that only frees up when somebody answers.
 */
/**
 * WHY THIS KIND SHIPS WITH NO PRODUCER. No connector mints a `question`
 * record today — `ask_teammate` posts to /api/questions, which resolves the
 * developer TERM (a record body cannot say "Kim is the name of three
 * developers here"). So this arm is reachable only by a hand-rolled or
 * modified client, which is exactly the threat model the budgets are written
 * for, and it was where the TTL and all three budgets could be lifted at once
 * through an untrusted `createdAt` (services/questions.ts, askQuestionFromRecord).
 *
 * It is kept rather than deleted because the hole is closed at the mechanism —
 * the hub owns `createdAt` here exactly as it owns `status` and `expiresAt` —
 * and because this arm is now the ONLY path that exercises that gate: the
 * route stamps its own clock and cannot. The tests that prove a caller cannot
 * buy themselves a longer TTL or a bigger budget run through here.
 */
const ingestQuestion = async (
  deps: Deps,
  developerId: string,
  body: Question,
): Promise<HandlerOutcome> => {
  const outcome = await askQuestionFromRecord(deps, developerId, body);
  switch (outcome.outcome) {
    case "asked":
      return { status: "accepted", id: outcome.question.id };
    case "duplicate":
      return { status: "duplicate", id: outcome.questionId };
    case "budget":
      return rejectedOutcome(`question budget: ${outcome.reason}`);
    case "invalid":
      return rejectedOutcome(`question: ${outcome.reason}`);
  }
};

/** The spool-replay path for an answer: claim + `answers` edge, one write. */
const ingestQuestionAnswer = async (
  deps: Deps,
  developerId: string,
  body: QuestionAnswer,
): Promise<HandlerOutcome> => {
  const outcome = await answerQuestion(deps, developerId, body);
  switch (outcome.outcome) {
    case "answered":
      return { status: "accepted", id: outcome.claimId };
    case "duplicate":
      return { status: "duplicate", id: outcome.claimId };
    case "refused":
      return rejectedOutcome(`questionId: ${outcome.reason}`);
  }
};

const dispatchRecord = (
  deps: Deps,
  developerId: string,
  kind: IngestableKind,
  body: unknown,
): Promise<HandlerOutcome> => {
  // Bodies were validated by parseRecord against the kind's schema.
  switch (kind) {
    case "work_context":
      return ingestWorkContext(deps, developerId, body as WorkContext);
    case "target":
      return ingestTarget(deps, developerId, body as Target);
    case "claim":
      return ingestClaim(deps, developerId, body as Claim);
    case "claim_edge":
      return ingestClaimEdge(deps, developerId, body as ClaimEdge);
    case "commit_evidence":
      return ingestCommitEvidence(deps, developerId, body as CommitEvidence);
    case "landed_evidence":
      return ingestLandedEvidence(deps, developerId, body as LandedEvidence);
    case "hint_delivery":
      return ingestHintDelivery(deps, developerId, body as HintDelivery);
    case "question":
      return ingestQuestion(deps, developerId, body as Question);
    case "question_answer":
      return ingestQuestionAnswer(deps, developerId, body as QuestionAnswer);
  }
};

/** Work context whose normalized doc an ACCEPTED record regenerated. */
const touchedContextId = (
  kind: IngestableKind,
  body: unknown,
): string | undefined => {
  switch (kind) {
    case "work_context":
      return (body as WorkContext).id;
    case "target":
      return (body as Target).workContextId;
    case "claim":
      return (body as Claim).workContextId;
    case "claim_edge":
      return undefined;
    // Commit evidence touches no work context and therefore no doc to re-embed.
    case "commit_evidence":
      return undefined;
    // Landing stamps a timestamp; the searchable doc is unchanged.
    case "landed_evidence":
      return undefined;
    // Delivery telemetry references a context but changes nothing about it.
    case "hint_delivery":
      return undefined;
    // A question is addressed AT a context, never filed into it: nothing
    // about the context's own searchable doc changes.
    case "question":
      return undefined;
    // The answer's claim already refreshed its own context's doc inside the
    // shared claim gate (ingestClaimWithin); re-embedding here would pay for
    // the same doc twice per flush.
    case "question_answer":
      return undefined;
  }
};

interface IngestOneResult {
  readonly outcome: HandlerOutcome;
  /** Set only when the record was accepted and regenerated a context's doc. */
  readonly touched?: string;
}

const ingestOne = async (
  deps: Deps,
  developerId: string,
  input: unknown,
): Promise<IngestOneResult> => {
  const parsed = parseRecord(input);
  if (!parsed.ok) {
    return { outcome: { status: "rejected", issues: parsed.issues } };
  }
  if (parsed.unknownKind) {
    // Forward compatibility (DESIGN.md §5): unknown kinds are never an error.
    return { outcome: { status: "ignored" } };
  }
  const kind = parsed.envelope.kind as KnownRecordKind;
  const notIngestableNote = NOT_INGESTABLE_NOTES[kind];
  if (notIngestableNote !== undefined) {
    return { outcome: { status: "ignored", issues: [notIngestableNote] } };
  }
  if (parsed.envelope.producer.developerId !== developerId) {
    return {
      outcome: rejectedOutcome(
        "producer.developerId: does not match authenticated developer",
      ),
    };
  }
  const gateIssue = await checkProducerSession(
    deps.db,
    developerId,
    parsed.envelope.producer.sessionId,
  );
  if (gateIssue !== null) {
    return { outcome: rejectedOutcome(gateIssue) };
  }
  const ingestableKind = kind as IngestableKind;
  const outcome = await dispatchRecord(
    deps,
    developerId,
    ingestableKind,
    parsed.body,
  );
  if (outcome.status !== "accepted") {
    return { outcome };
  }
  const touched = touchedContextId(ingestableKind, parsed.body);
  return touched === undefined ? { outcome } : { outcome, touched };
};

const countByStatus = (
  results: readonly RecordResult[],
  status: RecordStatus,
): number => results.filter((result) => result.status === status).length;

/**
 * Processes a spool flush strictly in input order, so a batch that creates a
 * work context and then its targets/claims succeeds in a single request.
 * Failures are per-record (partial success) — spool semantics.
 *
 * Context docs are EMBEDDED ONCE PER FLUSH, after the loop: only the final
 * doc state matters, so a 100-claim batch to one context costs one provider
 * call, not 100. This also covers targets-only flushes — a context whose
 * latest ingest was a target is re-embedded here rather than staying
 * invisible to the vector tier until the next claim.
 */
export const ingestRecords = async (
  deps: Deps,
  developerId: string,
  inputs: readonly unknown[],
): Promise<IngestSummary> => {
  const results: RecordResult[] = [];
  const touchedContexts = new Set<string>();
  for (let index = 0; index < inputs.length; index += 1) {
    const { outcome, touched } = await ingestOne(
      deps,
      developerId,
      inputs[index],
    );
    results.push({ index, ...outcome });
    if (touched !== undefined) {
      touchedContexts.add(touched);
    }
  }
  const embedder = deps.embedder ?? null;
  if (embedder !== null) {
    for (const workContextId of touchedContexts) {
      await embedContextDoc(deps.db, embedder, workContextId);
    }
  }
  return {
    results,
    accepted: countByStatus(results, "accepted"),
    duplicates: countByStatus(results, "duplicate"),
    ignored: countByStatus(results, "ignored"),
    rejected: countByStatus(results, "rejected"),
  };
};
