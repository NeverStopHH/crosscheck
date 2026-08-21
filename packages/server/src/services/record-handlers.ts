import { and, eq, inArray, sql } from "drizzle-orm";
import type { Claim, ClaimEdge, Intent, Target, WorkContext } from "@crosscheck/schema";

import { EVENT_KINDS } from "../constants.ts";
import {
  agentSessions,
  claimEdges,
  claims,
  workContexts,
  workContextTargets,
} from "../db/schema.ts";
import { appendEvent } from "./events.ts";
import { refreshNormalizedDoc } from "./normalized-doc.ts";
import {
  DECLARED_PROVENANCE,
  applyCrossSimilarity,
  embedClaimBody,
  findSimilarOwnClaim,
} from "./similarity-gate.ts";
import type { Db, DbExecutor } from "../db/client.ts";
import type { Embedder } from "./embedder.ts";
import type { Clock } from "../types.ts";

interface Deps {
  readonly db: Db;
  readonly now: Clock;
  /** Optional so handler unit tests without a vector tier stay minimal. */
  readonly embedder?: Embedder | null;
}

/** Handler dependencies bound to an open transaction (or the root db). */
interface ExecutorDeps {
  readonly db: DbExecutor;
  readonly now: Clock;
}

export type RecordStatus = "accepted" | "duplicate" | "ignored" | "rejected";

export interface HandlerOutcome {
  readonly status: RecordStatus;
  readonly id?: string;
  readonly issues?: readonly string[];
}

export const rejectedOutcome = (issue: string): HandlerOutcome => ({
  status: "rejected",
  issues: [issue],
});

const accepted = (id?: string): HandlerOutcome => ({
  status: "accepted",
  ...(id === undefined ? {} : { id }),
});

const duplicate = (id?: string): HandlerOutcome => ({
  status: "duplicate",
  ...(id === undefined ? {} : { id }),
});

const resolveSessionOwner = async (
  db: DbExecutor,
  sessionId: string,
): Promise<string | undefined> => {
  const rows = await db
    .select({ developerId: agentSessions.developerId })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  return rows[0]?.developerId;
};

const resolveWorkContextOwner = async (
  db: DbExecutor,
  workContextId: string,
): Promise<string | undefined> => {
  const rows = await db
    .select({ developerId: agentSessions.developerId })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(eq(workContexts.id, workContextId))
    .limit(1);
  return rows[0]?.developerId;
};

// Deliberately does not check endedAt: author sessions MAY already be ended —
// a spool flush from a successor session is legitimate. Only the producer
// session must be live (enforced by checkProducerSession in records.ts).
// Exported for the hint-delivery handler, which asks the identical question
// about the RECEIVING session (services/hint-deliveries.ts).
export const checkOwnedSession = async (
  db: DbExecutor,
  developerId: string,
  sessionId: string,
  field: string,
): Promise<string | null> => {
  const ownerId = await resolveSessionOwner(db, sessionId);
  if (ownerId === undefined) {
    return `${field}: session "${sessionId}" not found`;
  }
  if (ownerId !== developerId) {
    return `${field}: session belongs to another developer`;
  }
  return null;
};

type WorkContextRow = typeof workContexts.$inferSelect;

/**
 * The intent MERGE rule (trial finding #16). Title, status and description
 * keep replace semantics — every registration re-sends them — but an intent
 * is captured ONCE and a later work_context record usually carries none
 * (SessionStart re-fire on `--resume`, the mid-session recovery, Cursor's
 * late registration): `body.intent ?? null` wiped it on every such record.
 * So: a record WITHOUT the field keeps the stored intent; a record WITH one
 * replaces it — except that a DERIVED intent never overwrites a DECLARED one
 * (a late-flushed derived spool record must not undo `set_intent`; declared
 * over declared is the re-declare supersede). Hub-enforced, because spool
 * replay order is nobody's promise.
 */
const mergeIntent = (
  current: Record<string, unknown> | null,
  next: Intent | undefined,
): Record<string, unknown> | null => {
  if (next === undefined) {
    return current;
  }
  if (
    current !== null &&
    current["provenance"] === DECLARED_PROVENANCE &&
    next.provenance !== DECLARED_PROVENANCE
  ) {
    return current;
  }
  return next;
};

const workContextChanges = (
  current: WorkContextRow,
  body: WorkContext,
): Partial<WorkContextRow> | null => {
  const next = {
    title: body.title,
    description: body.description ?? null,
    intent: mergeIntent(current.intent ?? null, body.intent),
    status: body.status,
  };
  // Accepted v0 limitation: JSON.stringify intent comparison is key-order
  // sensitive, so a semantically equal intent with reordered keys counts as
  // a change and triggers a harmless no-op-ish update.
  const hasChange =
    next.title !== current.title ||
    next.description !== current.description ||
    JSON.stringify(next.intent) !== JSON.stringify(current.intent) ||
    next.status !== current.status;
  return hasChange ? next : null;
};

const updateExistingWorkContext = async (
  deps: ExecutorDeps,
  developerId: string,
  body: WorkContext,
): Promise<HandlerOutcome> => {
  const rows = await deps.db
    .select({ workContext: workContexts, ownerId: agentSessions.developerId })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(eq(workContexts.id, body.id))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new Error("work context insert conflicted but row was not found");
  }
  if (row.ownerId !== developerId) {
    return rejectedOutcome("id: work context belongs to another developer");
  }
  const changes = workContextChanges(row.workContext, body);
  if (changes === null) {
    return duplicate(body.id);
  }
  // session_id stays the creating session — updates never re-home a context.
  await deps.db
    .update(workContexts)
    .set({ ...changes, updatedAt: deps.now() })
    .where(eq(workContexts.id, body.id));
  await refreshNormalizedDoc(deps.db, body.id);
  // Outbox discipline: ids and metadata only — WHICH fields changed, never
  // their text (the feed phrases "intent" from the list, no summary crosses).
  await appendEvent(deps, EVENT_KINDS.WORK_CONTEXT_UPDATED, {
    workContextId: body.id,
    developerId,
    changed: Object.entries(changes)
      .filter(([field, value]) => value !== row.workContext[field as keyof WorkContextRow])
      .map(([field]) => field),
  });
  return accepted(body.id);
};

export const ingestWorkContext = async (
  deps: Deps,
  developerId: string,
  body: WorkContext,
): Promise<HandlerOutcome> => {
  // One transaction so the conflict probe, the ownership check, and the
  // update all act on the same snapshot — no TOCTOU between them.
  // Context-doc embedding happens ONCE PER FLUSH in ingestRecords, not here:
  // a batch touching one context must not re-embed it per record.
  return deps.db.transaction(async (tx) => {
    const txDeps: ExecutorDeps = { db: tx, now: deps.now };
    const sessionIssue = await checkOwnedSession(
      tx,
      developerId,
      body.sessionId,
      "sessionId",
    );
    if (sessionIssue !== null) {
      return rejectedOutcome(sessionIssue);
    }
    const inserted = await tx
      .insert(workContexts)
      .values({
        id: body.id,
        sessionId: body.sessionId,
        title: body.title,
        description: body.description ?? null,
        intent: body.intent ?? null,
        status: body.status,
        createdAt: new Date(body.createdAt),
        updatedAt:
          body.updatedAt === undefined ? null : new Date(body.updatedAt),
      })
      .onConflictDoNothing()
      .returning({ id: workContexts.id });
    if (inserted[0] === undefined) {
      return updateExistingWorkContext(txDeps, developerId, body);
    }
    await refreshNormalizedDoc(tx, body.id);
    await appendEvent(txDeps, EVENT_KINDS.WORK_CONTEXT_CREATED, {
      workContextId: body.id,
      sessionId: body.sessionId,
      developerId,
    });
    return accepted(body.id);
  });
};

export const ingestTarget = async (
  deps: Deps,
  developerId: string,
  body: Target,
): Promise<HandlerOutcome> => {
  const ownerId = await resolveWorkContextOwner(deps.db, body.workContextId);
  if (ownerId === undefined) {
    return rejectedOutcome(
      `workContextId: work context "${body.workContextId}" not found`,
    );
  }
  if (ownerId !== developerId) {
    return rejectedOutcome(
      "workContextId: work context belongs to another developer",
    );
  }
  const inserted = await deps.db
    .insert(workContextTargets)
    .values({
      workContextId: body.workContextId,
      kind: body.kind,
      value: body.value,
    })
    .onConflictDoNothing()
    .returning({ workContextId: workContextTargets.workContextId });
  if (inserted[0] === undefined) {
    return duplicate();
  }
  // The doc regenerates so the new target value is searchable. Not wrapped in
  // a transaction with the insert: a crash between the two leaves a doc one
  // target short until the next ingest touches the context — self-healing,
  // and the record itself is already durable.
  await refreshNormalizedDoc(deps.db, body.workContextId);
  // No per-target event: a busy session emits dozens of targets and would
  // flood the outbox, drowning the signals SSE consumers care about.
  return accepted();
};

// Accepted v0 limitation: homoglyph lookalikes (e.g. Cyrillic "а" for "a")
// bypass this normalization; the similarity block's embedding dedup covers
// visually-identical bodies.
const normalizeClaimBody = (body: string): string =>
  body.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Ingest dedup gate, deterministic v0 (DESIGN.md §3): same work context, same
 * kind, same author developer, same provenance, same status, normalized-equal
 * body. Similarity/embedding dedup arrives with the search block. NEVER dedup
 * across developers — provenance is the product; cross-author near-duplicates
 * become relates_to edges in the search block instead of merged rows.
 *
 * PROVENANCE AND STATUS ARE PART OF THE SCOPE, and the promotion loop is why
 * (DESIGN.md §3 Tier 1): promoting a draft posts a DECLARED claim with the
 * draft's exact body plus a supersedes edge, and discarding posts the same
 * body with status REJECTED. Dedup exists to collapse re-observations — which
 * arrive with identical provenance and status — not append-only revisions;
 * without this scope the revision collapsed into the draft row and the edge
 * bounced off a claim id that was never inserted.
 *
 * Accepted v0 limitation: candidates are loaded and normalized in JS; the
 * SQL normalized column that pushes this into the query comes with the
 * search block.
 */
const findDedupMatch = async (
  db: DbExecutor,
  developerId: string,
  body: Claim,
): Promise<{ readonly id: string } | undefined> => {
  const candidates = await db
    .select({ id: claims.id, body: claims.body })
    .from(claims)
    .innerJoin(agentSessions, eq(claims.authorSessionId, agentSessions.id))
    .where(
      and(
        eq(claims.workContextId, body.workContextId),
        eq(claims.kind, body.kind),
        eq(agentSessions.developerId, developerId),
        eq(claims.provenance, body.provenance),
        eq(claims.status, body.status),
      ),
    );
  const normalized = normalizeClaimBody(body.body);
  return candidates.find(
    (candidate) => normalizeClaimBody(candidate.body) === normalized,
  );
};

/** A claim id can only conflict with itself (spool replay) or a foreign owner. */
const classifyClaimIdConflict = async (
  db: DbExecutor,
  developerId: string,
  claimId: string,
): Promise<HandlerOutcome> => {
  const rows = await db
    .select({ ownerId: agentSessions.developerId })
    .from(claims)
    .innerJoin(agentSessions, eq(claims.authorSessionId, agentSessions.id))
    .where(eq(claims.id, claimId))
    .limit(1);
  const ownerId = rows[0]?.ownerId;
  if (ownerId !== undefined && ownerId !== developerId) {
    return rejectedOutcome("id: claim id already used by another developer");
  }
  // Spool replay of an already-stored claim id with a drifted body.
  return duplicate(claimId);
};

/**
 * Pre-transaction probe: will the transaction classify this claim as a
 * duplicate without needing its vector? Advisory only — the transaction
 * re-checks under its own snapshot — but it decides whether an embedding
 * provider gets paid: a spool replay (the NORMAL path when a flush times out)
 * and a deterministic re-observation must not cost an HTTP call each.
 */
const isDeterministicDuplicate = async (
  db: DbExecutor,
  developerId: string,
  body: Claim,
): Promise<boolean> => {
  const byIdRows = await db
    .select({ id: claims.id })
    .from(claims)
    .where(eq(claims.id, body.id))
    .limit(1);
  if (byIdRows[0] !== undefined) {
    return true;
  }
  return (await findDedupMatch(db, developerId, body)) !== undefined;
};

export const ingestClaim = async (
  deps: Deps,
  developerId: string,
  body: Claim,
): Promise<HandlerOutcome> => {
  // Embedded BEFORE the transaction: an external HTTP call must never hold a
  // transaction open on single-connection PGlite. Null = keyless install, a
  // failed embed, or a claim the deterministic gate will classify anyway —
  // in every case the similarity gate silently stands down and the
  // deterministic gate below still runs (DESIGN.md §6 degradation).
  const embedder = deps.embedder ?? null;
  const claimVector =
    embedder === null ||
    (await isDeterministicDuplicate(deps.db, developerId, body))
      ? null
      : await embedClaimBody(embedder, body.body);
  // One transaction so dedup match, INSERT, and dedup_count bump are atomic —
  // two concurrent flushes cannot both miss the match and double-insert.
  // Context-doc embedding happens once per flush in ingestRecords.
  return deps.db.transaction(async (tx) => {
    const txDeps: ExecutorDeps = { db: tx, now: deps.now };
    const authorIssue = await checkOwnedSession(
      tx,
      developerId,
      body.authorSessionId,
      "authorSessionId",
    );
    if (authorIssue !== null) {
      return rejectedOutcome(authorIssue);
    }
    // The work context must exist but may belong to another developer:
    // extending someone else's diagnosis tree is the product (DESIGN.md §3).
    const contextRows = await tx
      .select({ id: workContexts.id })
      .from(workContexts)
      .where(eq(workContexts.id, body.workContextId))
      .limit(1);
    if (contextRows[0] === undefined) {
      return rejectedOutcome(
        `workContextId: work context "${body.workContextId}" not found`,
      );
    }

    const dedupMatch = await findDedupMatch(tx, developerId, body);
    if (dedupMatch !== undefined) {
      if (dedupMatch.id === body.id) {
        // Exact spool replay: a retransmission, not a re-observation —
        // dedup_count and last_seen_at stay untouched.
        return duplicate(body.id);
      }
      await tx
        .update(claims)
        .set({
          dedupCount: sql`${claims.dedupCount} + 1`,
          lastSeenAt: deps.now(),
        })
        .where(eq(claims.id, dedupMatch.id));
      return duplicate(dedupMatch.id);
    }

    // Similarity dedup (DESIGN.md §3): same scope as the deterministic gate —
    // same developer, same context, same kind — with cosine > 0.93 standing in
    // for body equality. 15 rewordings of one re-observed error become one
    // weighted claim, not 15 rows.
    if (claimVector !== null && embedder !== null) {
      const similar = await findSimilarOwnClaim(
        tx,
        developerId,
        body,
        claimVector,
        embedder.model,
      );
      if (similar !== undefined) {
        await tx
          .update(claims)
          .set({
            dedupCount: sql`${claims.dedupCount} + 1`,
            lastSeenAt: deps.now(),
          })
          .where(eq(claims.id, similar.id));
        return duplicate(similar.id);
      }
    }

    const createdAt = new Date(body.createdAt);
    // evidenceRefs are persisted as-is; materializing supports-edges from them
    // is a follow-up — referenced claims may arrive later in the same flush.
    const inserted = await tx
      .insert(claims)
      .values({
        id: body.id,
        workContextId: body.workContextId,
        authorSessionId: body.authorSessionId,
        kind: body.kind,
        body: body.body,
        status: body.status,
        confidence: body.confidence,
        captureMode: body.captureMode,
        provenance: body.provenance,
        evidenceRefs: body.evidenceRefs,
        embedding: claimVector === null ? null : [...claimVector],
        embeddingModel:
          claimVector === null || embedder === null ? null : embedder.model,
        lastSeenAt: createdAt,
        createdAt,
      })
      .onConflictDoNothing()
      .returning({ id: claims.id });
    if (inserted[0] === undefined) {
      return classifyClaimIdConflict(tx, developerId, body.id);
    }
    // Cross-session similarity: relates_to edge or contradiction candidate
    // (similarity-gate.ts). After the insert so both edge endpoints exist.
    if (claimVector !== null && embedder !== null) {
      await applyCrossSimilarity(
        tx,
        deps.now,
        developerId,
        body,
        claimVector,
        embedder.model,
      );
    }
    await refreshNormalizedDoc(tx, body.workContextId);
    // Outbox discipline: ids and metadata only — never the claim body text.
    await appendEvent(txDeps, EVENT_KINDS.CLAIM_ADDED, {
      claimId: body.id,
      workContextId: body.workContextId,
      authorSessionId: body.authorSessionId,
      developerId,
      kind: body.kind,
      status: body.status,
    });
    return accepted(body.id);
  });
};

const findEdgeIdByTriple = async (
  db: DbExecutor,
  body: ClaimEdge,
): Promise<string | undefined> => {
  const rows = await db
    .select({ id: claimEdges.id })
    .from(claimEdges)
    .where(
      and(
        eq(claimEdges.fromClaimId, body.fromClaimId),
        eq(claimEdges.toClaimId, body.toClaimId),
        eq(claimEdges.kind, body.kind),
      ),
    )
    .limit(1);
  return rows[0]?.id;
};

/** Disambiguates which unique constraint swallowed the edge INSERT. */
const classifyEdgeConflict = async (
  db: DbExecutor,
  body: ClaimEdge,
): Promise<HandlerOutcome> => {
  const byIdRows = await db
    .select({
      fromClaimId: claimEdges.fromClaimId,
      toClaimId: claimEdges.toClaimId,
      kind: claimEdges.kind,
    })
    .from(claimEdges)
    .where(eq(claimEdges.id, body.id))
    .limit(1);
  const existing = byIdRows[0];
  if (existing !== undefined) {
    const isSameTriple =
      existing.fromClaimId === body.fromClaimId &&
      existing.toClaimId === body.toClaimId &&
      existing.kind === body.kind;
    return isSameTriple
      ? duplicate(body.id)
      : rejectedOutcome("id: already used by a different edge");
  }
  return duplicate(await findEdgeIdByTriple(db, body));
};

export const ingestClaimEdge = async (
  deps: Deps,
  developerId: string,
  body: ClaimEdge,
): Promise<HandlerOutcome> => {
  const authorIssue = await checkOwnedSession(
    deps.db,
    developerId,
    body.authorSessionId,
    "authorSessionId",
  );
  if (authorIssue !== null) {
    return rejectedOutcome(authorIssue);
  }
  const endpointIds = [body.fromClaimId, body.toClaimId];
  const found = await deps.db
    .select({ id: claims.id, ownerId: agentSessions.developerId })
    .from(claims)
    .innerJoin(agentSessions, eq(claims.authorSessionId, agentSessions.id))
    .where(inArray(claims.id, endpointIds));
  const foundIds = new Set(found.map((row) => row.id));
  const missing = endpointIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    return rejectedOutcome(`claim(s) not found: ${missing.join(", ")}`);
  }
  // supersedes is same-author revision semantics (DESIGN.md §5); cross-author
  // disagreement uses contradicts/deeper_cause_of, which stay cross-author by
  // design (extend_diagnosis).
  if (body.kind === "supersedes") {
    const hasForeignEndpoint = found.some((row) => row.ownerId !== developerId);
    if (hasForeignEndpoint) {
      return rejectedOutcome(
        "kind: supersedes requires ownership of both claims",
      );
    }
  }

  const inserted = await deps.db
    .insert(claimEdges)
    .values({
      id: body.id,
      fromClaimId: body.fromClaimId,
      toClaimId: body.toClaimId,
      kind: body.kind,
      authorSessionId: body.authorSessionId,
      note: body.note ?? null,
      createdAt: new Date(body.createdAt),
    })
    .onConflictDoNothing()
    .returning({ id: claimEdges.id });
  if (inserted[0] === undefined) {
    return classifyEdgeConflict(deps.db, body);
  }
  await appendEvent(deps, EVENT_KINDS.CLAIM_EDGE_ADDED, {
    edgeId: body.id,
    fromClaimId: body.fromClaimId,
    toClaimId: body.toClaimId,
    kind: body.kind,
    developerId,
  });
  return accepted(body.id);
};