/**
 * Own unreviewed Tier-1 drafts (DESIGN.md §3 Tier 1) — the promotion loop's
 * read model. A draft is a claim with provenance='derived' that is still in
 * play: status 'proposed', and no supersedes edge pointing at it (promotion
 * and discard both retire a draft by APPENDING a revision plus that edge —
 * the row itself is never mutated, so "reviewed" is a graph fact).
 *
 * OWN ONLY, structurally: the author join filters on the caller's developer
 * id inside the WHERE. There is no flag to widen this — a teammate's drafts
 * are machine guesses that were never vouched for, and surfacing them to
 * anyone else would be the anchoring §4 exists to prevent.
 *
 * `repo` is the usual relevance filter, never a boundary (DESIGN.md §2.1):
 * drafts surface where the developer is working on the same repo again.
 */
import { and, desc, eq } from "drizzle-orm";

import { MAX_DRAFTS_LISTED } from "../constants.ts";
import { agentSessions, claims } from "../db/schema.ts";
import { notSuperseded } from "./hints.ts";
import type { Db } from "../db/client.ts";

const DRAFT_PROVENANCE = "derived";
const DRAFT_STATUS = "proposed";

export interface DraftView {
  readonly id: string;
  readonly workContextId: string;
  readonly kind: string;
  readonly body: string;
  readonly status: string;
  readonly confidence: number;
  readonly captureMode: string;
  readonly dedupCount: number;
  readonly createdAt: string;
}

export const listOwnDrafts = async (
  db: Db,
  developerId: string,
  repo: string,
): Promise<readonly DraftView[]> => {
  const rows = await db
    .select({ claim: claims })
    .from(claims)
    .innerJoin(agentSessions, eq(claims.authorSessionId, agentSessions.id))
    .where(
      and(
        eq(agentSessions.developerId, developerId),
        eq(agentSessions.repo, repo),
        eq(claims.provenance, DRAFT_PROVENANCE),
        eq(claims.status, DRAFT_STATUS),
        notSuperseded(db),
      ),
    )
    .orderBy(desc(claims.createdAt))
    .limit(MAX_DRAFTS_LISTED);
  return rows.map((row) => ({
    id: row.claim.id,
    workContextId: row.claim.workContextId,
    kind: row.claim.kind,
    body: row.claim.body,
    status: row.claim.status,
    confidence: row.claim.confidence,
    captureMode: row.claim.captureMode,
    dedupCount: row.claim.dedupCount,
    createdAt: row.claim.createdAt.toISOString(),
  }));
};
