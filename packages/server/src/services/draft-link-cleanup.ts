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
 * WHAT HAPPENS TO THEM (review round 4, H3), in one transaction per page:
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
 *
 * BOUNDED (batch-2 integration review, H6). The older row's "no wire record"
 * test was a NOT EXISTS inside an OR, which the planner cannot make an
 * anti-join: it scanned all of `events` once per legacy edge, twice per pass,
 * and every request waited 9–86 s on a pilot-scale hub at every start. Now
 * the legacy rows are found by an anti-join of their own, which reads
 * events_claim_edge_added_edge_idx, and the work goes a page of
 * DRAFT_LINK_CLEANUP_BATCH edges at a time — one transaction each, a turn of
 * the event loop between pages — so a request waits out one page at most.
 */
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { DRAFT_LINK_CLEANUP_BATCH, EVENT_KINDS } from "../constants.ts";
import type { Db, DbExecutor } from "../db/client.ts";
import { yieldToRequests } from "../db/yield-to-requests.ts";
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

/**
 * The edge ids one page covers: after `after`, and up to `last` once the page
 * is known (null while it is being selected).
 */
interface PageBounds {
  readonly after: string;
  readonly last: string | null;
}

const inPage = (id: SQL, bounds: PageBounds): SQL =>
  bounds.last === null ? sql`${id} > ${bounds.after}` : sql`${id} > ${bounds.after} AND ${id} <= ${bounds.last}`;

/**
 * The wire record's kind as a LITERAL, not a parameter: the planner may read
 * events_claim_edge_added_edge_idx (partial, `WHERE kind = 'claim_edge_added'`)
 * only when it can prove the query's kind is that one at plan time.
 */
const WIRE_RECORD_KIND = sql.raw(`'${EVENT_KINDS.CLAIM_EDGE_ADDED}'`);

/**
 * The gate's: by origin from round 4 on; an older row by note, authorship and
 * no wire record. Two selections joined by UNION ALL, not one OR: the older
 * rows' NOT EXISTS then stands on its own and is planned as an anti-join over
 * the wire-record index, where inside an OR it was a scan of `events` per row
 * (H6).
 */
const writtenByGate = (bounds: PageBounds): SQL => sql`e.id IN (
      SELECT g.id FROM claim_edges g
      WHERE g.origin = ${SIMILARITY_GATE_ORIGIN} AND ${inPage(sql`g.id`, bounds)}
      UNION ALL
      SELECT g.id FROM claim_edges g JOIN claims gc ON gc.id = g.from_claim_id
      WHERE g.origin IS NULL
        AND g.note = ${AUTO_SIMILARITY_NOTE}
        AND g.author_session_id = gc.author_session_id
        AND ${inPage(sql`g.id`, bounds)}
        AND NOT EXISTS (
          SELECT 1 FROM events ev
          WHERE ev.kind = ${WIRE_RECORD_KIND} AND ev.payload->>'edgeId' = g.id))`;

/** A gate link between two developers with a non-declared end, within the page. */
const draftLinkIntoTeammatesTree = (bounds: PageBounds): SQL => sql`
    e.kind = ${RELATES_TO}
    AND ${inPage(sql`e.id`, bounds)}
    AND ${writtenByGate(bounds)}
    AND fs.developer_id <> ts.developer_id
    AND (fc.provenance <> ${DECLARED_PROVENANCE} OR tc.provenance <> ${DECLARED_PROVENANCE})`;

/** The next page: the first `batch` offending edges after `after`, by id. */
export const draftLinkPageQuery = (after: string, batch: number): SQL =>
  sql`SELECT e.id ${EDGE_ENDS} WHERE ${draftLinkIntoTeammatesTree({ after, last: null })} ORDER BY e.id LIMIT ${batch}`;

const idsOf = (result: { readonly rows: readonly unknown[] }): readonly string[] =>
  result.rows.map((row) => (row as { readonly id: string }).id);

/**
 * Moves each offending edge whose every derived end has a DECLARED head of
 * its revision chain (the newest unsuperseded claim reached through
 * supersedes edges) onto those heads — and onto the head's session as author,
 * as the gate would have written it. An edge whose moved pair is already
 * linked, either way round, stays offending and is archived next.
 */
const repointConfirmedDrafts = async (tx: DbExecutor, bounds: PageBounds): Promise<readonly string[]> =>
  idsOf(
    await tx.execute(sql`
      WITH RECURSIVE offending AS (
        SELECT e.id, e.from_claim_id, e.to_claim_id, e.author_session_id,
               fc.provenance = ${DECLARED_PROVENANCE} AS from_vouched,
               tc.provenance = ${DECLARED_PROVENANCE} AS to_vouched
        ${EDGE_ENDS}
        WHERE ${draftLinkIntoTeammatesTree(bounds)}
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
const archiveAndRemove = async (tx: DbExecutor, passId: string, bounds: PageBounds): Promise<readonly string[]> =>
  idsOf(
    await tx.execute(sql`
      WITH gone AS (
        DELETE FROM claim_edges
        WHERE id IN (SELECT e.id ${EDGE_ENDS} WHERE ${draftLinkIntoTeammatesTree(bounds)})
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

/** No edge id sorts before this, so the first page starts at the beginning. */
const BEFORE_EVERY_EDGE = "";

interface Done {
  readonly repointed: readonly string[];
  readonly removed: readonly string[];
}

/**
 * One page at a time from `after`: its edges are found, then re-pointed and
 * archived in one transaction, then the event loop takes a turn. Every edge
 * of a page leaves the offending set (moved onto vouched ends, or archived),
 * and the next page starts after the last id of this one, so the pass ends.
 */
const cleanFrom = async (db: Db, passId: string, batch: number, after: string, done: Done): Promise<DraftLinkCleanupReport> => {
  const last = idsOf(await db.execute(draftLinkPageQuery(after, batch))).at(-1);
  if (last === undefined) {
    return { passId, ...done };
  }
  const bounds: PageBounds = { after, last };
  const page = await db.transaction(async (tx) => ({
    repointed: await repointConfirmedDrafts(tx, bounds),
    removed: await archiveAndRemove(tx, passId, bounds),
  }));
  await yieldToRequests();
  return cleanFrom(db, passId, batch, last, {
    repointed: [...done.repointed, ...page.repointed],
    removed: [...done.removed, ...page.removed],
  });
};

/** Re-points the confirmed drafts' links, archives and removes the rest, a page at a time. */
export const removeCrossDeveloperDraftLinks = (
  db: Db,
  options: { readonly batch?: number } = {},
): Promise<DraftLinkCleanupReport> =>
  cleanFrom(db, `dlc_${crypto.randomUUID()}`, options.batch ?? DRAFT_LINK_CLEANUP_BATCH, BEFORE_EVERY_EDGE, {
    repointed: [],
    removed: [],
  });
