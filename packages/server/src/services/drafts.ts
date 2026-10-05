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
import { and, asc, desc, eq, sql } from "drizzle-orm";

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

/** The one definition of "the caller's own unreviewed drafts on this repo". */
const ownUnreviewed = (db: Db, developerId: string, repo: string) =>
  and(
    eq(agentSessions.developerId, developerId),
    eq(agentSessions.repo, repo),
    eq(claims.provenance, DRAFT_PROVENANCE),
    eq(claims.status, DRAFT_STATUS),
    notSuperseded(db),
  );

/**
 * THE BACKLOG BEHIND THE CAPPED LISTING: how many own unreviewed drafts there
 * are in all and when the oldest was captured. The listing stops at
 * MAX_DRAFTS_LISTED, newest first, so without these a developer with 35 drafts
 * was told "at least 20" and never how stale the oldest is. Same WHERE as the
 * listing, by construction — one aggregate over the identical filter.
 */
export interface DraftBacklogView {
  readonly total: number;
  readonly oldestCreatedAt: string | null;
}

export const summarizeOwnDrafts = async (
  db: Db,
  developerId: string,
  repo: string,
): Promise<DraftBacklogView> => {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      oldest: sql<Date | string | null>`min(${claims.createdAt})`,
    })
    .from(claims)
    .innerJoin(agentSessions, eq(claims.authorSessionId, agentSessions.id))
    .where(ownUnreviewed(db, developerId, repo));
  const oldest = row?.oldest ?? null;
  return {
    total: row?.total ?? 0,
    oldestCreatedAt: oldest === null ? null : new Date(oldest).toISOString(),
  };
};

/**
 * Which end of the backlog a listing starts from. NEWEST is the default and
 * what the briefing reads; OLDEST exists for the review nudge, which must
 * name — and let review_draft reach — the drafts that have waited longest,
 * and those are exactly the ones a newest-first page past the cap leaves out.
 */
export const DRAFT_ORDERS = ["newest", "oldest"] as const;
export type DraftOrder = (typeof DRAFT_ORDERS)[number];

export const listOwnDrafts = async (
  db: Db,
  developerId: string,
  repo: string,
  order: DraftOrder = "newest",
): Promise<readonly DraftView[]> => {
  const rows = await db
    .select({ claim: claims })
    .from(claims)
    .innerJoin(agentSessions, eq(claims.authorSessionId, agentSessions.id))
    .where(ownUnreviewed(db, developerId, repo))
    .orderBy(order === "oldest" ? asc(claims.createdAt) : desc(claims.createdAt))
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
