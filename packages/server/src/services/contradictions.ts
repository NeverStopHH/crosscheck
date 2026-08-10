/**
 * Diagnostic conflicts for briefings (DESIGN.md §1 point 4, §3 ingest gate).
 *
 * TWO SOURCES, ONE ANSWER — and the storage split is deliberate:
 *
 *   DERIVED (deterministic, keyless): claims of theory kinds whose work
 *   contexts share a target and whose statuses sit on opposite sides of
 *   open-vs-rejected. Recomputed fresh per read rather than stored, because
 *   the signal has no ingest-order: the target that completes the overlap may
 *   arrive long after both claims, and a stored row written at claim-ingest
 *   time would simply never exist. The (kind, value) self-join is served by
 *   work_context_targets_kind_value_idx (bootstrap.sql; the targets PK leads
 *   with work_context_id and cannot serve it), and nothing can go stale.
 *
 *   STORED (similarity-detected): rows the ingest gate wrote while an
 *   embedder was configured (similarity-gate.ts). Stored because recomputing
 *   pairwise cosine at read time would be O(n²) over the claim store; the
 *   gate meets each new claim once, at ingest, where the probe is a single
 *   nearest-neighbor lookup backed by claims_embedding_hnsw_idx.
 *
 * A pair found by both sources is reported once, as "similarity" — the
 * stronger signal, since it carries a measured score.
 *
 * BOTH SIDES SHIP RAW CLAIM BODIES, hub-convention (the hub returns raw, the
 * connector frames). No connector consumes this endpoint yet; the consumer
 * that DESIGN.md §4 plans — "open contradictions in this area" in the
 * SessionStart briefing — puts two author-written bodies side by side in an
 * agent's context, so it MUST route every body through the renderer's PROSE
 * class (« » framing, sanitized) like every other teammate text. Do not
 * interpolate these fields into agent-visible text directly.
 */
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { ClaimKind } from "@crosscheck/schema";

import {
  claims,
  contradictionCandidates,
  workContextTargets,
} from "../db/schema.ts";
import { OPEN_THEORY_STATUSES } from "./similarity-gate.ts";
import type { Db } from "../db/client.ts";

export const CONTRADICTIONS_DEFAULT_LIMIT = 50;
export const CONTRADICTIONS_MAX_LIMIT = 200;

/** Kinds that carry a theory; observations and evidence cannot contradict. */
const THEORY_KINDS = [
  "hypothesis",
  "root_cause",
] as const satisfies readonly ClaimKind[];

export interface CandidateSide {
  readonly id: string;
  readonly workContextId: string;
  readonly kind: string;
  readonly status: string;
  readonly body: string;
}

export interface ContradictionView {
  readonly claimA: CandidateSide;
  readonly claimB: CandidateSide;
  readonly reason: "similarity" | "shared_target";
  readonly similarity: number | null;
}

/** "Touches the repo": either side's work context reports from it. */
const repoTouchCondition = (
  repo: string | undefined,
  sideA: { readonly workContextId: unknown },
  sideB: { readonly workContextId: unknown },
) =>
  repo === undefined
    ? undefined
    : sql`(
        EXISTS (SELECT 1 FROM work_contexts wc JOIN agent_sessions s ON s.id = wc.session_id
                WHERE wc.id = ${sideA.workContextId} AND s.repo = ${repo})
        OR EXISTS (SELECT 1 FROM work_contexts wc JOIN agent_sessions s ON s.id = wc.session_id
                WHERE wc.id = ${sideB.workContextId} AND s.repo = ${repo})
      )`;

const listStoredCandidates = async (
  db: Db,
  repo: string | undefined,
  limit: number,
): Promise<readonly ContradictionView[]> => {
  const claimsA = alias(claims, "stored_a");
  const claimsB = alias(claims, "stored_b");
  const rows = await db
    .select({
      similarity: contradictionCandidates.similarity,
      aId: claimsA.id,
      aWorkContextId: claimsA.workContextId,
      aKind: claimsA.kind,
      aStatus: claimsA.status,
      aBody: claimsA.body,
      bId: claimsB.id,
      bWorkContextId: claimsB.workContextId,
      bKind: claimsB.kind,
      bStatus: claimsB.status,
      bBody: claimsB.body,
    })
    .from(contradictionCandidates)
    .innerJoin(claimsA, eq(contradictionCandidates.claimAId, claimsA.id))
    .innerJoin(claimsB, eq(contradictionCandidates.claimBId, claimsB.id))
    .where(repoTouchCondition(repo, claimsA, claimsB))
    .orderBy(sql`${contradictionCandidates.createdAt} DESC`)
    .limit(limit);
  return rows.map((row) => ({
    claimA: {
      id: row.aId,
      workContextId: row.aWorkContextId,
      kind: row.aKind,
      status: row.aStatus,
      body: row.aBody,
    },
    claimB: {
      id: row.bId,
      workContextId: row.bWorkContextId,
      kind: row.bKind,
      status: row.bStatus,
      body: row.bBody,
    },
    reason: "similarity" as const,
    similarity: row.similarity,
  }));
};

const listDerivedCandidates = async (
  db: Db,
  repo: string | undefined,
  limit: number,
): Promise<readonly ContradictionView[]> => {
  const openSide = alias(claims, "open_side");
  const rejectedSide = alias(claims, "rejected_side");
  const targetsOpen = alias(workContextTargets, "targets_open");
  const targetsRejected = alias(workContextTargets, "targets_rejected");

  const rows = await db
    .selectDistinct({
      aId: openSide.id,
      aWorkContextId: openSide.workContextId,
      aKind: openSide.kind,
      aStatus: openSide.status,
      aBody: openSide.body,
      bId: rejectedSide.id,
      bWorkContextId: rejectedSide.workContextId,
      bKind: rejectedSide.kind,
      bStatus: rejectedSide.status,
      bBody: rejectedSide.body,
    })
    .from(openSide)
    .innerJoin(
      targetsOpen,
      eq(targetsOpen.workContextId, openSide.workContextId),
    )
    .innerJoin(
      targetsRejected,
      and(
        eq(targetsRejected.kind, targetsOpen.kind),
        eq(targetsRejected.value, targetsOpen.value),
        ne(targetsRejected.workContextId, targetsOpen.workContextId),
      ),
    )
    .innerJoin(
      rejectedSide,
      eq(rejectedSide.workContextId, targetsRejected.workContextId),
    )
    .where(
      and(
        inArray(openSide.kind, [...THEORY_KINDS]),
        inArray(rejectedSide.kind, [...THEORY_KINDS]),
        inArray(openSide.status, [...OPEN_THEORY_STATUSES]),
        eq(rejectedSide.status, "rejected"),
        repoTouchCondition(repo, openSide, rejectedSide),
      ),
    )
    .limit(limit);
  return rows.map((row) => ({
    claimA: {
      id: row.aId,
      workContextId: row.aWorkContextId,
      kind: row.aKind,
      status: row.aStatus,
      body: row.aBody,
    },
    claimB: {
      id: row.bId,
      workContextId: row.bWorkContextId,
      kind: row.bKind,
      status: row.bStatus,
      body: row.bBody,
    },
    reason: "shared_target" as const,
    similarity: null,
  }));
};

const pairKey = (view: ContradictionView): string =>
  [view.claimA.id, view.claimB.id].sort().join(":");

export const listContradictions = async (
  db: Db,
  input: { readonly repo?: string | undefined; readonly limit: number },
): Promise<readonly ContradictionView[]> => {
  const limit = Math.min(Math.max(1, input.limit), CONTRADICTIONS_MAX_LIMIT);
  const [stored, derived] = await Promise.all([
    listStoredCandidates(db, input.repo, limit),
    listDerivedCandidates(db, input.repo, limit),
  ]);
  const seen = new Set<string>();
  const merged: ContradictionView[] = [];
  // Stored first: a pair found both ways reports as "similarity", which
  // carries a measured score.
  for (const candidate of [...stored, ...derived]) {
    const key = pairKey(candidate);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(candidate);
    }
  }
  return merged.slice(0, limit);
};
