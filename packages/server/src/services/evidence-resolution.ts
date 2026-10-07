/**
 * THE HUB'S HALF OF THE EVIDENCE RULE (hold-out review, H5 + M2): which of a
 * claim's evidence refs RESOLVE, by the one rule in `@crosscheck/schema`
 * evidence-resolution.ts that the hint's `evidenceBacked`, the solved label
 * and the connector's solved mirror all apply.
 *
 * The database does what only it can: each ref followed through supersedes
 * edges to the HEAD of its revision chain (bounded by REVISION_MAX_DEPTH, so
 * a cycle ends), that head required to be unrevised and in the citing
 * claim's repo. The shared rule then judges the head's kind, status,
 * provenance and content, so the content count is the one the shown
 * sentence uses, not an SQL approximation of it. One query for the whole id
 * list, recomputed on every read: a cited claim refuted or retracted later
 * flips every claim that leaned on it.
 */
import { REVISION_MAX_DEPTH, isEvidenceFor } from "@crosscheck/schema";
import { sql } from "drizzle-orm";

import type { Db } from "../db/client.ts";

/** Same-author revision edge; its TARGET is the claim revised away. */
const SUPERSEDES_EDGE_KIND = "supersedes";

/** Disagreement edge; on a cited claim or its head it un-backs (round 3, M2). */
const CONTRADICTS_EDGE_KIND = "contradicts";

type ResolvedHeadRow = {
  readonly citing_id: string;
  readonly citing_created_at: string;
  readonly cited_id: string;
  readonly head_id: string;
  readonly kind: string;
  readonly status: string;
  readonly provenance: string;
  readonly body: string;
  readonly head_created_at: string;
  readonly is_contradicted: boolean;
};

const headsOfRefs = (db: Db, claimIds: readonly string[]) =>
  db.execute<ResolvedHeadRow>(sql`
    WITH RECURSIVE refs AS (
      SELECT citing.id AS citing_id, ref.target AS cited_id
      FROM claims AS citing
      CROSS JOIN LATERAL jsonb_array_elements_text(citing.evidence_refs) AS ref(target)
      WHERE citing.id IN (${sql.join(claimIds.map((id) => sql`${id}`), sql`, `)})
    ),
    chain AS (
      SELECT citing_id, cited_id, cited_id AS node_id, 0 AS depth FROM refs
      UNION
      SELECT chain.citing_id, chain.cited_id, revision.from_claim_id, chain.depth + 1
      FROM chain
      JOIN claim_edges AS revision ON revision.to_claim_id = chain.node_id AND revision.kind = ${SUPERSEDES_EDGE_KIND}
      WHERE chain.depth < ${REVISION_MAX_DEPTH}
    )
    SELECT DISTINCT chain.citing_id, to_json(citing.created_at) #>> '{}' AS citing_created_at,
      chain.cited_id, head.id AS head_id, head.kind, head.status, head.provenance, head.body,
      to_json(head.created_at) #>> '{}' AS head_created_at,
      EXISTS (
        SELECT 1 FROM claim_edges AS contra
        WHERE contra.kind = ${CONTRADICTS_EDGE_KIND} AND contra.to_claim_id IN (chain.cited_id, head.id)
      ) AS is_contradicted
    FROM chain
    JOIN claims AS head ON head.id = chain.node_id
    JOIN claims AS citing ON citing.id = chain.citing_id
    JOIN work_contexts AS head_context ON head_context.id = head.work_context_id
    JOIN agent_sessions AS head_session ON head_session.id = head_context.session_id
    JOIN work_contexts AS citing_context ON citing_context.id = citing.work_context_id
    JOIN agent_sessions AS citing_session ON citing_session.id = citing_context.session_id
    WHERE head_session.repo = citing_session.repo
      AND NOT EXISTS (
        SELECT 1 FROM claim_edges AS later
        WHERE later.to_claim_id = head.id AND later.kind = ${SUPERSEDES_EDGE_KIND}
      )`);

/** How many of each claim's evidence refs resolve to evidence; a claim with none is absent. */
export const resolvedEvidenceCounts = async (
  db: Db,
  claimIds: readonly string[],
): Promise<ReadonlyMap<string, number>> => {
  if (claimIds.length === 0) {
    return new Map();
  }
  const result = await headsOfRefs(db, claimIds);
  const resolved = result.rows.filter((row) =>
    isEvidenceFor({ id: row.citing_id, createdAt: row.citing_created_at }, row.cited_id, {
      id: row.head_id,
      kind: row.kind,
      status: row.status,
      provenance: row.provenance,
      body: row.body,
      createdAt: row.head_created_at,
      isContradicted: row.is_contradicted,
    }),
  );
  // DISTINCT HEADS, not distinct refs (round 3, L2): an observation cited by
  // its old id, its revision and its old id again is one piece of evidence.
  const headsByClaim = resolved.reduce<ReadonlyMap<string, ReadonlySet<string>>>(
    (byClaim, row) => new Map([...byClaim, [row.citing_id, new Set([...(byClaim.get(row.citing_id) ?? []), row.head_id])]]),
    new Map(),
  );
  return new Map([...headsByClaim].map(([claimId, heads]) => [claimId, heads.size]));
};
