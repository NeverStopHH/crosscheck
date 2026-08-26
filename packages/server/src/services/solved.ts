/**
 * Solved-tree identification (VISION.md §1 collective memory), deterministic
 * and derived fresh per read — no LLM, no stored flag, nothing to go stale.
 *
 * A work context is SOLVED when it holds at least one likely_root_cause claim
 * that (a) still stands — not revised away by a supersedes edge, the same
 * probe the hints path applies (services/hints.ts notSuperseded) — and
 * (b) carries evidence refs, the anchoring-asymmetry evidence rule: a root
 * cause without evidence is a theory, and a theory must never earn the solved
 * ranking floor or the solved label readers treat as settled — and
 * (c) carries DECLARED provenance, the gate every sibling trust surface
 * applies (contradictions on both sides, similarity-gate, the hint
 * selector's isDeclared): a machine-derived row is nobody's vouched answer,
 * and SOLVED is a trust label — the wire admits derived + likely_root_cause
 * + evidence at the confidence cap, so without this clause a row no shipped
 * writer produces (but a modified connector could mint) would stamp the tree
 * settled — and (d) is not DEADLOCKED: while a contradicts edge joins it to
 * another qualifying likely_root_cause in the same tree, the tree holds two
 * standing answers that cannot both be right. That is the referee-mode
 * dispute (DESIGN.md §4), and a dispute must not read settled on any
 * surface. A rival that is evidence-free, derived or superseded does not
 * count — a drive-by theory cannot unsolve a tree, and retracting one side
 * of a deadlock settles it again.
 *
 * SOLVED is a fact about the DIAGNOSIS (the tree says what the root cause
 * was); LANDED (work_contexts.landed_at, services/landed.ts) is a fact about
 * the CODE (git says the session's base commit reached the default branch).
 * They are independent and compose by not being conflated: a tree can be
 * solved with its fix still in review, or landed without any recorded root
 * cause. Ranking (the search decay floor) keys on SOLVED alone — the retained
 * knowledge is what the floor protects; presentation states each separately.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";

import { claimEdges, claims } from "../db/schema.ts";
import { DECLARED_PROVENANCE } from "./similarity-gate.ts";
import type { Db } from "../db/client.ts";

/** The one claim status that can mark a tree solved. */
export const SOLVED_CLAIM_STATUS = "likely_root_cause";

/**
 * Evidence floor for the solving claim — mirrors the connector's
 * HINT_MIN_EVIDENCE_REFS (packages/connector-core/src/constants.ts) and the
 * wire rule in @crosscheck/schema (likely_root_cause requires ≥1 evidence
 * ref); enforced here too so a row that bypassed ingest cannot count.
 */
export const SOLVED_MIN_EVIDENCE_REFS = 1;

/** Same-author revision edge; its TARGET is the retracted claim. */
const SUPERSEDES_EDGE_KIND = "supersedes";

/** Disagreement edge; between two qualifying root causes it is a deadlock. */
const CONTRADICTS_EDGE_KIND = "contradicts";

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
 * THE solved predicate, as one expression: every rule the header states,
 * over a caller-bounded id list. Extracted because two readers now need it —
 * "is this tree solved, and when" and "what does it say the cause was" — and
 * two spellings of a trust rule are two rules. A body served under the
 * solved label by a query that had drifted from this one would be substance
 * injected on a vouch nobody made.
 */
const solvedClaimCondition = (contextIds: readonly string[]): SQL =>
  and(
    inArray(claims.workContextId, [...contextIds]),
    eq(claims.status, SOLVED_CLAIM_STATUS),
    eq(claims.provenance, DECLARED_PROVENANCE),
    sql`jsonb_array_length(${claims.evidenceRefs}) >= ${SOLVED_MIN_EVIDENCE_REFS}`,
    sql`NOT EXISTS (SELECT 1 FROM ${claimEdges} WHERE ${claimEdges.toClaimId} = ${claims.id} AND ${claimEdges.kind} = ${SUPERSEDES_EDGE_KIND})`,
    // The deadlock probe: raw identifiers because the same two tables
    // appear twice (peer, se) and drizzle's table refs cannot alias
    // inside a sql fragment. Peer scope is THE SAME TREE — the
    // connector's mirror (mcp/render.ts solvedAtFromTree) only sees
    // local claims, and the two rules must answer identically.
    sql`NOT EXISTS (
      SELECT 1 FROM claim_edges dl
      JOIN claims peer ON peer.id = CASE
        WHEN dl.from_claim_id = ${claims.id} THEN dl.to_claim_id
        ELSE dl.from_claim_id
      END
      WHERE dl.kind = ${CONTRADICTS_EDGE_KIND}
        AND (dl.from_claim_id = ${claims.id} OR dl.to_claim_id = ${claims.id})
        AND peer.work_context_id = ${claims.workContextId}
        AND peer.status = ${SOLVED_CLAIM_STATUS}
        AND peer.provenance = ${DECLARED_PROVENANCE}
        AND jsonb_array_length(peer.evidence_refs) >= ${SOLVED_MIN_EVIDENCE_REFS}
        AND NOT EXISTS (
          SELECT 1 FROM claim_edges se
          WHERE se.to_claim_id = peer.id AND se.kind = ${SUPERSEDES_EDGE_KIND}
        )
    )`,
  ) as SQL;

/**
 * A NECESSARY condition for solvedness, as a correlated EXISTS over whichever
 * work-context column a listing already has in hand — the cheap half of the
 * predicate above (status + provenance + evidence), WITHOUT the supersedes
 * and deadlock probes.
 *
 * WHY A SECOND, WEAKER SPELLING EXISTS at all, when this file's whole point
 * is that the solved rule has one: because a listing that JOINS to find
 * candidates has to bound what it reads BEFORE it can ask a claims-side
 * question about each one, and "every context that ever shared this value"
 * is not a bounded set. The solved-match listing paid for that with a
 * measured 1.2 s and, worse, with the answer itself falling out of its own
 * LIMIT behind hundreds of unsolved contexts sharing one hot fingerprint
 * (test/solved-fanout.test.ts).
 *
 * THE DIRECTION IS THE CONTRACT: this may over-include, never under-include.
 * It admits a superseded or deadlocked tree; `listSolvedInfo` — still run by
 * every caller afterwards, on the ids this narrowed down to — then refuses
 * it. So the trust rule keeps exactly one spelling; this is a read bound
 * wearing its shape, and a tree it wrongly admits costs a row, never a claim.
 */
export const solvedCandidateCondition = (contextId: SQL | AnyColumn): SQL =>
  sql`EXISTS (
    SELECT 1 FROM claims sc
     WHERE sc.work_context_id = ${contextId}
       AND sc.status = ${SOLVED_CLAIM_STATUS}
       AND sc.provenance = ${DECLARED_PROVENANCE}
       AND jsonb_array_length(sc.evidence_refs) >= ${SOLVED_MIN_EVIDENCE_REFS}
  )`;

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
    .where(solvedClaimCondition(contextIds))
    .groupBy(claims.workContextId);
  return new Map(
    rows.flatMap((row) => {
      const solvedAt = toDate(row.solvedAt);
      return solvedAt === null ? [] : [[row.workContextId, solvedAt] as const];
    }),
  );
};

/**
 * Read bound on qualifying root-cause rows per lookup. The caller's id list
 * is already capped (SOLVED_MATCH_MAX_FINDINGS trees), and a tree holds a
 * handful of standing root causes at most, so this is the usual "bounded
 * like every other query" floor rather than a working limit.
 */
export const SOLVED_ROOT_CAUSE_MAX_ROWS = 50;

/** A solved tree's recorded cause, with the label the reader weighs it by. */
export interface SolvedRootCause {
  readonly body: string;
  /**
   * THE CLAIM'S OWN CONFIDENCE, carried because this body is injected into a
   * reader's context unasked and every other injected claim prints its
   * labels (DESIGN.md §4). Nothing in the solved predicate is a floor on it:
   * `publish_claim` takes the number from the model, and a 0.05 hedge with
   * one evidence ref is a legal, honest `likely_root_cause`. So the number
   * travels and the renderer states it, rather than the surface quietly
   * presenting a guess as a settled answer.
   */
  readonly confidence: number;
}

/**
 * What each solved tree of `contextIds` says the cause WAS — the newest
 * qualifying claim's body, which is by construction the same claim whose
 * createdAt `listSolvedInfo` reports as `solvedAt`: same predicate, same
 * ordering key, so the sentence a reader sees and the age printed beside it
 * always describe one claim. Its confidence rides along for the same reason:
 * one claim, one set of labels.
 *
 * Newest-first plus first-wins in JS rather than DISTINCT ON: the row cap
 * above keeps it small, and the two readers then share the predicate instead
 * of one of them growing a dialect-specific clause the other lacks.
 */
export const listSolvedRootCauses = async (
  db: Db,
  contextIds: readonly string[],
): Promise<ReadonlyMap<string, SolvedRootCause>> => {
  if (contextIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      workContextId: claims.workContextId,
      body: claims.body,
      confidence: claims.confidence,
    })
    .from(claims)
    .where(solvedClaimCondition(contextIds))
    .orderBy(desc(claims.createdAt))
    .limit(SOLVED_ROOT_CAUSE_MAX_ROWS);
  const newest = new Map<string, SolvedRootCause>();
  for (const row of rows) {
    if (!newest.has(row.workContextId)) {
      newest.set(row.workContextId, {
        body: row.body,
        confidence: row.confidence,
      });
    }
  }
  return newest;
};
