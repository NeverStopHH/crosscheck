/**
 * The embedding half of the ingest gate (DESIGN.md §3) — only alive while an
 * embedder is configured. Keyless installs keep the deterministic gate in
 * record-handlers.ts and nothing here runs.
 *
 * WHAT COUNTS AS "SAME ENTITIES" for dedup: same work context, same claim
 * kind, same author developer — the exact shape of the deterministic gate,
 * with cosine similarity replacing normalized-body equality. NEVER across
 * authors: provenance is the product, and a teammate's near-duplicate is a
 * relates_to edge, not a merged row.
 *
 * APPEND-ONLY IS PRESERVED: this module never updates a claim body. Its only
 * writes are the dedup_count/last_seen_at bump (a counter, not knowledge),
 * new claim_edges rows, and new contradiction_candidates rows.
 */
import { and, cosineDistance, eq, isNotNull, ne, sql } from "drizzle-orm";
import type { Claim, ClaimStatus } from "@crosscheck/schema";

import {
  agentSessions,
  claimEdges,
  claims,
  contradictionCandidates,
} from "../db/schema.ts";
import type { DbExecutor } from "../db/client.ts";
import type { Embedder } from "./embedder.ts";
import type { Clock } from "../types.ts";

/** DESIGN.md §3: "same context, same entities, cosine > ~0.93 → no new row". */
export const SIMILARITY_DEDUP_THRESHOLD = 0.93;

/** Note on every gate-authored edge, so a reader can tell it from a declared one. */
export const AUTO_SIMILARITY_NOTE = "auto: similarity";

/** Statuses that keep a theory in play; "rejected" is their opposite. */
export const OPEN_THEORY_STATUSES = [
  "proposed",
  "partially_confirmed",
  "likely_root_cause",
] as const satisfies readonly ClaimStatus[];

/**
 * The provenance a claim needs before it may hold a SIDE of a contradiction.
 * A derived claim is a machine draft nobody vouched for (DESIGN.md §3 Tier 1:
 * "never proactively injected"), and contradiction candidates feed the
 * briefing — a proactive surface that names its authors as holding positions.
 * Positive equality, not `!= 'derived'`: an unknown provenance value stays
 * out — the same fail-closed `=== "declared"` equality the hint selector's
 * isDeclared uses (packages/connector-core/src/hints/select.ts).
 */
export const DECLARED_PROVENANCE = "declared";

/** Widened view so membership checks accept any string. */
const OPEN_STATUS_STRINGS: readonly string[] = OPEN_THEORY_STATUSES;

export const isOppositeStatus = (left: string, right: string): boolean =>
  (left === "rejected" && OPEN_STATUS_STRINGS.includes(right)) ||
  (right === "rejected" && OPEN_STATUS_STRINGS.includes(left));

/**
 * Embeds one claim body, degrading to null on any failure — a claim must
 * never be refused because an embedding API was down.
 */
export const embedClaimBody = async (
  embedder: Embedder,
  body: string,
): Promise<readonly number[] | null> => {
  try {
    const [vector] = await embedder.embed([body]);
    return vector ?? null;
  } catch (error) {
    console.error(
      "[crosscheck] claim embedding failed; similarity gate skipped for this claim",
      error,
    );
    return null;
  }
};

interface SimilarClaim {
  readonly id: string;
  readonly similarity: number;
}

/**
 * Nearest same-developer claim of the same kind in the same work context —
 * the dedup candidate. One row, by distance, above the threshold or nothing.
 *
 * Scoped to same provenance and status like the deterministic gate
 * (record-handlers.ts findDedupMatch): a promotion or discard revision
 * restates the draft's body verbatim (cosine 1.0) and must not be collapsed
 * into the row it exists to supersede.
 */
export const findSimilarOwnClaim = async (
  db: DbExecutor,
  developerId: string,
  body: Claim,
  vector: readonly number[],
  model: string,
): Promise<SimilarClaim | undefined> => {
  const distance = cosineDistance(claims.embedding, [...vector]);
  const rows = await db
    .select({
      id: claims.id,
      similarity: sql<number>`1 - (${distance})`,
    })
    .from(claims)
    .innerJoin(agentSessions, eq(claims.authorSessionId, agentSessions.id))
    .where(
      and(
        eq(claims.workContextId, body.workContextId),
        eq(claims.kind, body.kind),
        eq(agentSessions.developerId, developerId),
        eq(claims.provenance, body.provenance),
        eq(claims.status, body.status),
        isNotNull(claims.embedding),
        eq(claims.embeddingModel, model),
      ),
    )
    .orderBy(distance)
    .limit(1);
  const nearest = rows[0];
  return nearest !== undefined &&
    nearest.similarity > SIMILARITY_DEDUP_THRESHOLD
    ? nearest
    : undefined;
};

/**
 * After the new claim is inserted: its nearest neighbor OUTSIDE the dedup
 * scope (another work context, another developer, or another claim kind in
 * the same context).
 *
 *   opposite status → contradiction candidate row — the §1 "two open,
 *   contradictory theories" signal, similarity-detected;
 *   otherwise → relates_to edge, authored by the INGESTING session. Not
 *   "system": edges need an author, and the ingest that surfaced the
 *   similarity is the one that vouches for it.
 *
 * Top-1 only, deliberately: one near-duplicate produces one link, not a fan
 * of edges to every phrasing of the same observation.
 */
export const applyCrossSimilarity = async (
  db: DbExecutor,
  now: Clock,
  developerId: string,
  body: Claim,
  vector: readonly number[],
  model: string,
): Promise<void> => {
  const distance = cosineDistance(claims.embedding, [...vector]);
  const rows = await db
    .select({
      id: claims.id,
      status: claims.status,
      provenance: claims.provenance,
      similarity: sql<number>`1 - (${distance})`,
    })
    .from(claims)
    .innerJoin(agentSessions, eq(claims.authorSessionId, agentSessions.id))
    .where(
      and(
        ne(claims.id, body.id),
        isNotNull(claims.embedding),
        eq(claims.embeddingModel, model),
        // Exactly the dedup scope of findSimilarOwnClaim is excluded — same
        // context AND same developer AND same KIND. A different-kind
        // near-duplicate by the same developer in the same context is
        // cross-similarity territory: a rejected root_cause and a fresh
        // near-identical hypothesis must still meet as a contradiction
        // (DESIGN.md §3 restricts only MERGING across authors, not flagging
        // a developer against their own history).
        sql`NOT (${claims.workContextId} = ${body.workContextId} AND ${agentSessions.developerId} = ${developerId} AND ${claims.kind} = ${body.kind})`,
      ),
    )
    .orderBy(distance)
    .limit(1);
  const nearest = rows[0];
  if (
    nearest === undefined ||
    nearest.similarity <= SIMILARITY_DEDUP_THRESHOLD
  ) {
    return;
  }

  // A deadlock needs two VOUCHED positions: a derived draft on either side
  // (this claim or its neighbor) relates, it never contradicts — a machine
  // guess must not put "X holds a conflicting theory" into a briefing
  // (DESIGN.md §3 Tier 1). The similarity itself is still real, so such a
  // pair falls through to the pull-only relates_to edge below.
  const bothDeclared =
    body.provenance === DECLARED_PROVENANCE &&
    nearest.provenance === DECLARED_PROVENANCE;
  if (bothDeclared && isOppositeStatus(body.status, nearest.status)) {
    // Canonical pair order makes the unique index direction-agnostic.
    const [claimAId, claimBId] = [body.id, nearest.id].sort() as [
      string,
      string,
    ];
    await db
      .insert(contradictionCandidates)
      .values({
        id: `ccd_${crypto.randomUUID()}`,
        claimAId,
        claimBId,
        similarity: nearest.similarity,
        createdAt: now(),
      })
      .onConflictDoNothing();
    return;
  }

  await db
    .insert(claimEdges)
    .values({
      id: `edge_${crypto.randomUUID()}`,
      fromClaimId: body.id,
      toClaimId: nearest.id,
      kind: "relates_to",
      authorSessionId: body.authorSessionId,
      note: AUTO_SIMILARITY_NOTE,
      createdAt: now(),
    })
    .onConflictDoNothing();
};
