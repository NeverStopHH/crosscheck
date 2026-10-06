/**
 * THE LINKS AN OLDER GATE MADE INTO TEAMMATES' TREES ON A DRAFT'S STRENGTH
 * (review round 3, MEDIUM-4).
 *
 * The similarity gate no longer links a derived claim (an unreviewed draft,
 * or the rejected copy a discard appends) to another developer's claim, nor
 * a declared claim to a teammate's derived one (similarity-gate.ts
 * reachableNeighbour). A hub that ran the older gate kept every such edge,
 * so a teammate's get_diagnosis still lists a machine guess as related —
 * the push the draft promise forbids.
 *
 * WHICH EDGES: relates_to edges THE GATE wrote, between claims of two
 * different developers, with a non-declared end. A link between one
 * developer's own claims stays, as the gate still makes it; so does every
 * edge a person made. "The gate wrote it" is structural from round 4 on
 * (claim_edges.origin, review round 4 H3); an older row is the gate's only
 * when it carries the gate's note AND the gate's authorship (the from end's
 * author, true of every edge the gate wrote) AND no wire record — every edge
 * that came over the wire left a claim_edge_added event in the append-only
 * outbox, and the gate never wrote one. So a person who typed the gate's note
 * by hand keeps their edge.
 *
 * WHAT HAPPENS TO THEM (review round 4, H3), in one transaction:
 *   - a derived end since CONFIRMED (review_draft: a declared revision
 *     supersedes the draft) has a vouched claim to point at: the edge moves
 *     to the head of the draft's revision chain, so the teammate's tree keeps
 *     the reference, now to a vouched finding — unless that pair is already
 *     linked (the gate linked the revision itself when it was ingested);
 *   - the rest are DELETED AND ARCHIVED by one statement into
 *     claim_edges_removed under this run's pass id, so nothing is lost:
 *     docs/OPERATIONS.md restores a pass with one INSERT … SELECT.
 * Idempotent — a second run finds nothing — and run in the background after
 * the hub is serving (index.ts), beside the doc upgrade.
 */
import { sql } from "drizzle-orm";

import { EVENT_KINDS } from "../constants.ts";
import type { Db, DbExecutor } from "../db/client.ts";
import { AUTO_SIMILARITY_NOTE, DECLARED_PROVENANCE, SIMILARITY_GATE_ORIGIN } from "./similarity-gate.ts";

const RELATES_TO = "relates_to";
const SUPERSEDES = "supersedes";

export interface DraftLinkCleanupReport {
  /** This run's id: removed_by_pass of every row it archived. */
  readonly passId: string;
  /** Edges moved from a confirmed draft to the head of its revision chain. */
  readonly repointed: readonly string[];
  /** Edges archived in claim_edges_removed, then deleted. */
  readonly removed: readonly string[];
}

/** An edge `e` with its two claims (fc, tc) and their sessions (fs, ts). */
const EDGE_ENDS = sql`
  FROM claim_edges e
  JOIN claims fc ON fc.id = e.from_claim_id
  JOIN claims tc ON tc.id = e.to_claim_id
  JOIN agent_sessions fs ON fs.id = fc.author_session_id
  JOIN agent_sessions ts ON ts.id = tc.author_session_id`;

/** The gate's: by origin from round 4 on; an older row by note, authorship and no wire record. */
const WRITTEN_BY_GATE = sql`(
    e.origin = ${SIMILARITY_GATE_ORIGIN}
    OR (e.origin IS NULL
      AND e.note = ${AUTO_SIMILARITY_NOTE}
      AND e.author_session_id = fc.author_session_id
      AND NOT EXISTS (
        SELECT 1 FROM events ev
        WHERE ev.kind = ${EVENT_KINDS.CLAIM_EDGE_ADDED} AND ev.payload->>'edgeId' = e.id)))`;

/** A gate link between two developers with a non-declared end. */
const DRAFT_LINK_INTO_TEAMMATES_TREE = sql`
    e.kind = ${RELATES_TO}
    AND ${WRITTEN_BY_GATE}
    AND fs.developer_id <> ts.developer_id
    AND (fc.provenance <> ${DECLARED_PROVENANCE} OR tc.provenance <> ${DECLARED_PROVENANCE})`;

const idsOf = (result: { readonly rows: readonly unknown[] }): readonly string[] =>
  result.rows.map((row) => (row as { readonly id: string }).id);

/**
 * Moves each offending edge whose every derived end has a DECLARED head of
 * its revision chain (the newest unsuperseded claim reached through
 * supersedes edges) onto those heads — and onto the head's session as author,
 * as the gate would have written it. An edge whose moved pair is already
 * linked, either way round, stays offending and is archived next.
 */
const repointConfirmedDrafts = async (tx: DbExecutor): Promise<readonly string[]> =>
  idsOf(
    await tx.execute(sql`
      WITH RECURSIVE offending AS (
        SELECT e.id, e.from_claim_id, e.to_claim_id, e.author_session_id,
               fc.provenance = ${DECLARED_PROVENANCE} AS from_vouched,
               tc.provenance = ${DECLARED_PROVENANCE} AS to_vouched
        ${EDGE_ENDS}
        WHERE ${DRAFT_LINK_INTO_TEAMMATES_TREE}
      ),
      derived_ends AS (
        SELECT from_claim_id AS claim_id FROM offending WHERE NOT from_vouched
        UNION
        SELECT to_claim_id FROM offending WHERE NOT to_vouched
      ),
      chain (start_id, claim_id) AS (
        SELECT claim_id, claim_id FROM derived_ends
        UNION
        SELECT chain.start_id, s.from_claim_id
        FROM chain JOIN claim_edges s ON s.to_claim_id = chain.claim_id AND s.kind = ${SUPERSEDES}
      ),
      heads AS (
        SELECT DISTINCT ON (chain.start_id) chain.start_id, c.id AS head_id, c.author_session_id AS head_author
        FROM chain JOIN claims c ON c.id = chain.claim_id
        WHERE c.provenance = ${DECLARED_PROVENANCE}
          AND NOT EXISTS (SELECT 1 FROM claim_edges s WHERE s.to_claim_id = c.id AND s.kind = ${SUPERSEDES})
        ORDER BY chain.start_id, c.created_at DESC, c.id DESC
      ),
      moves AS (
        SELECT o.id,
               CASE WHEN o.from_vouched THEN o.from_claim_id ELSE hf.head_id END AS new_from,
               CASE WHEN o.to_vouched THEN o.to_claim_id ELSE ht.head_id END AS new_to,
               CASE WHEN o.from_vouched THEN o.author_session_id ELSE hf.head_author END AS new_author
        FROM offending o
        LEFT JOIN heads hf ON hf.start_id = o.from_claim_id
        LEFT JOIN heads ht ON ht.start_id = o.to_claim_id
      ),
      free_moves AS (
        SELECT DISTINCT ON (m.new_from, m.new_to) m.id, m.new_from, m.new_to, m.new_author
        FROM moves m
        WHERE m.new_from IS NOT NULL AND m.new_to IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM claim_edges x
            WHERE x.kind = ${RELATES_TO}
              AND ((x.from_claim_id = m.new_from AND x.to_claim_id = m.new_to)
                OR (x.from_claim_id = m.new_to AND x.to_claim_id = m.new_from)))
        ORDER BY m.new_from, m.new_to, m.id
      )
      UPDATE claim_edges moved
      SET from_claim_id = f.new_from, to_claim_id = f.new_to, author_session_id = f.new_author,
          origin = ${SIMILARITY_GATE_ORIGIN}
      FROM free_moves f
      WHERE moved.id = f.id
      RETURNING moved.id`),
  );

/**
 * Deletes every remaining offending edge and archives it, in ONE statement:
 * no row can be deleted without its archive copy. The columns are named, not
 * `gone.*`, so a column claim_edges gains later cannot shift the archive's.
 */
const archiveAndRemove = async (tx: DbExecutor, passId: string): Promise<readonly string[]> =>
  idsOf(
    await tx.execute(sql`
      WITH gone AS (
        DELETE FROM claim_edges
        WHERE id IN (SELECT e.id ${EDGE_ENDS} WHERE ${DRAFT_LINK_INTO_TEAMMATES_TREE})
        RETURNING *
      )
      INSERT INTO claim_edges_removed
        (id, from_claim_id, to_claim_id, kind, author_session_id, note, origin, created_at, removed_at, removed_by_pass)
      SELECT id, from_claim_id, to_claim_id, kind, author_session_id, note, origin, created_at, now(), ${passId}
      FROM gone
      RETURNING id`),
  );

/** How many edge ids one log line names; the archive holds every one. */
const LOGGED_IDS_MAX = 200;

const listIds = (ids: readonly string[]): string =>
  ids.length <= LOGGED_IDS_MAX
    ? ids.join(", ")
    : `${ids.slice(0, LOGGED_IDS_MAX).join(", ")} … and ${String(ids.length - LOGGED_IDS_MAX)} more`;

/** The start-up log line: counts, the pass id to restore by, and the edge ids. */
export const describeDraftLinkCleanup = (report: DraftLinkCleanupReport): string =>
  `${String(report.removed.length)} cross-developer draft link(s) archived in claim_edges_removed and removed ` +
  `(pass ${report.passId}${report.removed.length === 0 ? "" : `: ${listIds(report.removed)}`}), ` +
  `${String(report.repointed.length)} moved to the confirmed revision` +
  (report.repointed.length === 0 ? "" : ` (${listIds(report.repointed)})`);

/** Re-points the confirmed drafts' links, archives and removes the rest. */
export const removeCrossDeveloperDraftLinks = (db: Db): Promise<DraftLinkCleanupReport> => {
  const passId = `dlc_${crypto.randomUUID()}`;
  return db.transaction(async (tx) => {
    const repointed = await repointConfirmedDrafts(tx);
    const removed = await archiveAndRemove(tx, passId);
    return { passId, repointed, removed };
  });
};
