import { eq } from "drizzle-orm";
import { parseRecord } from "@crosscheck/schema";
import type {
  Claim,
  ClaimEdge,
  KnownRecordKind,
  Target,
  WorkContext,
} from "@crosscheck/schema";

import { agentSessions } from "../db/schema.ts";
import { embedContextDoc } from "./normalized-doc.ts";
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
