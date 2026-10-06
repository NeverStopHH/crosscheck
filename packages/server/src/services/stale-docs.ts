/**
 * WHICH SEARCH DOCS STILL FOLD DRAFTS IN (review round 3 HIGH-1; round 4 M2).
 *
 * A work context's normalized doc built before NORMALIZED_DOC_VERSION folded
 * every claim in, drafts and discards included — and its vector was minted
 * from that doc. A context with declared claims only built the same doc
 * under both rules, so only a STALE doc whose context holds a non-declared
 * claim is wrong. Three readers share this one spelling of "wrong":
 *   - the doc upgrade (doc-upgrade.ts), which rebuilds exactly these;
 *   - search (search.ts), whose doc pass and vector tier do not answer for
 *     one until it is rebuilt, so the window before the pass reaches a
 *     context never pushes a teammate's tree on a draft's word;
 *   - GET /api/hub-status, which counts them for `crosscheck doctor`.
 */
import { and, count, eq, exists, gt, lt, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { DbExecutor } from "../db/client.ts";
import { claims, workContexts } from "../db/schema.ts";
import { NORMALIZED_DOC_VERSION } from "./normalized-doc.ts";
import { DECLARED_PROVENANCE } from "./similarity-gate.ts";

/** No id sorts before this: the whole table. */
export const BEFORE_EVERY_ID = "";

/**
 * A non-declared claim of the work context in hand — what makes its old doc
 * wrong. `after` bounds the claims to the doc upgrade's page cursor.
 */
export const holdsNonDeclaredClaim = (db: DbExecutor, after: string = BEFORE_EVERY_ID) =>
  exists(
    db
      .select({ one: sql`1` })
      .from(claims)
      .where(
        and(
          eq(claims.workContextId, workContexts.id),
          // BOUNDED BY THE CURSOR TOO (review round 4, L2): redundant with the
          // join, but it hands the planner the same range on claims that the
          // page has on work contexts, so each page's semi-join starts at the
          // cursor instead of re-reading every claim before it.
          gt(claims.workContextId, after),
          ne(claims.provenance, DECLARED_PROVENANCE),
        ),
      ),
  );

/** The work context in hand has a doc built under an older rule that folds a draft in. */
export const staleDraftDoc = (db: DbExecutor): SQL =>
  sql`(${lt(workContexts.docVersion, NORMALIZED_DOC_VERSION)} AND ${holdsNonDeclaredClaim(db)})`;

/** How many docs the doc upgrade has yet to rebuild. */
export const countPendingDocs = async (db: DbExecutor): Promise<number> => {
  const [row] = await db.select({ pending: count() }).from(workContexts).where(staleDraftDoc(db));
  return row?.pending ?? 0;
};
