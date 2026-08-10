/**
 * Solved-tree identification (VISION.md §1 collective memory), deterministic
 * and derived fresh per read — no LLM, no stored flag, nothing to go stale.
 *
 * A work context is SOLVED when it holds at least one likely_root_cause claim
 * that (a) still stands — not revised away by a supersedes edge, the same
 * probe the hints path applies (services/hints.ts notSuperseded) — and
 * (b) carries evidence refs, the anchoring-asymmetry evidence rule: a root
 * cause without evidence is a theory, and a theory must never earn the solved
 * ranking floor or the solved label readers treat as settled.
 *
 * SOLVED is a fact about the DIAGNOSIS (the tree says what the root cause
 * was); LANDED (work_contexts.landed_at, services/landed.ts) is a fact about
 * the CODE (git says the session's base commit reached the default branch).
 * They are independent and compose by not being conflated: a tree can be
 * solved with its fix still in review, or landed without any recorded root
 * cause. Ranking (the search decay floor) keys on SOLVED alone — the retained
 * knowledge is what the floor protects; presentation states each separately.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { claimEdges, claims } from "../db/schema.ts";
import type { Db } from "../db/client.ts";

/** The one claim status that can mark a tree solved. */
export const SOLVED_CLAIM_STATUS = "likely_root_cause";

/**
 * Evidence floor for the solving claim — mirrors the connector's
 * HINT_MIN_EVIDENCE_REFS (packages/connector-claude/src/constants.ts) and the
 * wire rule in @crosscheck/schema (likely_root_cause requires ≥1 evidence
 * ref); enforced here too so a row that bypassed ingest cannot count.
 */
export const SOLVED_MIN_EVIDENCE_REFS = 1;

/** Same-author revision edge; its TARGET is the retracted claim. */
const SUPERSEDES_EDGE_KIND = "supersedes";

/** Driver-agnostic timestamp read: raw aggregates bypass drizzle's mapping. */
const toDate = (value: unknown): Date | null => {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  return null;
};

/**
 * Which of `contextIds` are solved, and when — `solvedAt` is the newest
 * qualifying claim's createdAt, the "diagnosed N days ago" every surface
 * states plainly (honest presentation). One bounded query: the id list is
 * caller-bounded (search tier candidates, hint candidates), and the
 * supersedes probe rides the claim_edges_to_kind_idx index the hints path
 * already created.
 */
export const listSolvedInfo = async (
  db: Db,
  contextIds: readonly string[],
): Promise<ReadonlyMap<string, Date>> => {
  if (contextIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      workContextId: claims.workContextId,
      solvedAt: sql`max(${claims.createdAt})`,
    })
    .from(claims)
    .where(
      and(
        inArray(claims.workContextId, [...contextIds]),
        eq(claims.status, SOLVED_CLAIM_STATUS),
        sql`jsonb_array_length(${claims.evidenceRefs}) >= ${SOLVED_MIN_EVIDENCE_REFS}`,
        sql`NOT EXISTS (SELECT 1 FROM ${claimEdges} WHERE ${claimEdges.toClaimId} = ${claims.id} AND ${claimEdges.kind} = ${SUPERSEDES_EDGE_KIND})`,
      ),
    )
    .groupBy(claims.workContextId);
  return new Map(
    rows.flatMap((row) => {
      const solvedAt = toDate(row.solvedAt);
      return solvedAt === null ? [] : [[row.workContextId, solvedAt] as const];
    }),
  );
};
