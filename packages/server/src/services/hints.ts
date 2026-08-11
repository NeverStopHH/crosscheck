/**
 * Hint candidates + tripwire — the hub side of the injection pipeline's
 * UserPromptSubmit fast path and the PreToolUse tripwire (DESIGN.md §4).
 *
 * CANDIDATES answers one bounded question inside the connector's 800 ms hook
 * budget: "which teammate work contexts does this prompt lexically touch, and
 * what claims do they carry". Selection — the anchoring asymmetry, the seen-set,
 * the per-session cap — stays in the connector, because only the connector
 * knows the session's delivery history; this service's job is to hand it
 * everything a trust label needs (author, age, status, confidence, provenance,
 * the context session's base commit for drift) in ONE round trip.
 *
 * THE VECTOR TIER NEVER RUNS HERE. Its embed deadline alone (2 s,
 * SEARCH_EMBED_DEADLINE_MS) is wider than the whole hook budget this endpoint
 * serves, so the search below is forced lexical by passing `embedder: null`
 * whatever the hub has configured. Pinned by "never embeds the query" in
 * test/hints.test.ts.
 *
 * ASYNC SECOND CHANCE — DELIBERATE DEFERRAL (DESIGN.md §4 names it as an
 * option). Delivering late vector results on the NEXT prompt needs per-session
 * pending-hint state on the hub — a new table, expiry, and a second read path —
 * for a tier the default keyless install does not even have. That does not fit
 * cleanly into "one bounded call against existing search", so it is deferred
 * with this note rather than half-built. The lexical fast path (exact targets +
 * FTS) is the one the design names normative for the sync budget.
 */
import { and, desc, eq, gt, inArray, isNull, ne, notExists, sql } from "drizzle-orm";

import {
  agentSessions,
  claimEdges,
  claims,
  developers,
  workContexts,
  workContextTargets,
} from "../db/schema.ts";
import { presenceCutoff } from "./presence.ts";
import { searchWorkContexts } from "./search.ts";
import { notMutedCondition, visiblePresenceCondition } from "./visibility.ts";
import type { SearchResultKind, SearchTier } from "./search.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

/**
 * Precision floor, structural: only tiers where the prompt actually matched
 * something count. "recency" is what a blank query gets and "vector" cannot
 * occur here (the embedder is forced null) — naming them out keeps a future
 * search change from quietly widening this endpoint into a filler feed.
 */
export const HINT_ELIGIBLE_TIERS: readonly SearchTier[] = ["exact", "fts"];

/** Most matched contexts one candidates response carries. */
export const HINT_MAX_CONTEXTS = 3;

/**
 * Most claims per candidate context — the selector needs enough to find one
 * settled or negative claim, not the whole tree. Applied PER CONTEXT, newest
 * first: claims are append-only and revision means a NEW claim (DESIGN.md
 * §5), so the settled findings are the latest rows, and a shared
 * oldest-first window would regress every long context to its day-one
 * observations while a claim-heavy sibling starved the others entirely.
 */
export const HINT_MAX_CLAIMS_PER_CONTEXT = 30;

/**
 * How many search rows are fetched before the tier floor runs. The CALLER's
 * own contexts are excluded inside the search itself (excludeDeveloperId) —
 * filtered after this bound, a busy reader's own fresh contexts would fill
 * the pool and crowd out the teammate rows it exists to find.
 */
const SEARCH_POOL_LIMIT = 10;

/** Same-author revision edge (DESIGN.md §5); its TARGET is the retracted claim. */
const SUPERSEDES_EDGE_KIND = "supersedes";

/** Most sessions one tripwire response names — one is enough to ask. */
export const TRIPWIRE_MAX_SESSIONS = 5;

export interface HintClaimCandidate {
  readonly id: string;
  readonly workContextId: string;
  readonly kind: string;
  readonly status: string;
  readonly confidence: number;
  readonly provenance: string;
  readonly captureMode: string;
  readonly evidenceRefCount: number;
  readonly authorDeveloperId: string;
  readonly authorDeveloperName: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface HintContextCandidate {
  readonly workContext: {
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly tier: SearchTier;
    readonly developerId: string;
    readonly developerName: string;
    readonly baseCommit: string;
    /**
     * Solved trees are presented differently (VISION.md §1) — the fact rides
     * the search row (services/solved.ts computes it there) so this endpoint
     * stays one bounded call.
     */
    readonly resultKind: SearchResultKind;
    readonly solvedAt: string | null;
    readonly createdAt: string;
    readonly updatedAt: string | null;
  };
  readonly claims: readonly HintClaimCandidate[];
}

/**
 * A claim revised away by its author is not knowledge to inject: the hub
 * never mutates the row (claims are append-only), so "retracted" is a
 * supersedes edge POINTING AT the claim, and serving the target row verbatim
 * would hand the reader the old theory under full trust labels — precisely
 * the anchoring §4 exists to prevent. The selector's own `superseded` status
 * guard stays as defense in depth against a forging hub; THIS filter is the
 * one real revision data exercises.
 *
 * Exported for services/drafts.ts, which asks the identical graph question
 * ("has a revision retired this row?") about the caller's own drafts.
 */
export const notSuperseded = (db: Db) =>
  notExists(
    db
      .select({ one: sql`1` })
      .from(claimEdges)
      .where(
        and(
          eq(claimEdges.toClaimId, claims.id),
          eq(claimEdges.kind, SUPERSEDES_EDGE_KIND),
        ),
      ),
  );

const listClaimsForContext = async (
  db: Db,
  readerDeveloperId: string,
  workContextId: string,
): Promise<readonly HintClaimCandidate[]> => {
  const rows = await db
    .select({
      claim: claims,
      authorDeveloperId: agentSessions.developerId,
      authorDeveloperName: developers.name,
    })
    .from(claims)
    .innerJoin(agentSessions, eq(claims.authorSessionId, agentSessions.id))
    .innerJoin(developers, eq(agentSessions.developerId, developers.id))
    .where(
      and(
        eq(claims.workContextId, workContextId),
        notSuperseded(db),
        // In the WHERE, before the claim window: extend_diagnosis puts a
        // muted author's claims inside an unmuted teammate's tree, and a
        // hint must not carry them to this reader (services/visibility.ts).
        notMutedCondition(readerDeveloperId, agentSessions.developerId),
      ),
    )
    .orderBy(desc(claims.createdAt))
    .limit(HINT_MAX_CLAIMS_PER_CONTEXT);
  return rows.map((row) => ({
    id: row.claim.id,
    workContextId: row.claim.workContextId,
    kind: row.claim.kind,
    status: row.claim.status,
    confidence: row.claim.confidence,
    provenance: row.claim.provenance,
    captureMode: row.claim.captureMode,
    evidenceRefCount: row.claim.evidenceRefs.length,
    authorDeveloperId: row.authorDeveloperId,
    authorDeveloperName: row.authorDeveloperName,
    body: row.claim.body,
    createdAt: row.claim.createdAt.toISOString(),
  }));
};

/**
 * One bounded query PER CONTEXT — at most HINT_MAX_CONTEXTS of them — so a
 * claim-heavy context can never consume a sibling's window (a single global
 * LIMIT did exactly that; test/hints.test.ts "cannot starve a sibling
 * context's claim window").
 */
const listContextClaims = async (
  db: Db,
  readerDeveloperId: string,
  workContextIds: readonly string[],
): Promise<ReadonlyMap<string, readonly HintClaimCandidate[]>> => {
  const lists = await Promise.all(
    workContextIds.map((id) =>
      listClaimsForContext(db, readerDeveloperId, id),
    ),
  );
  return new Map(workContextIds.map((id, index) => [id, lists[index] ?? []]));
};

/** The base commit of each context's owning session, for the drift label. */
const listBaseCommits = async (
  db: Db,
  workContextIds: readonly string[],
): Promise<ReadonlyMap<string, string>> => {
  if (workContextIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({ id: workContexts.id, baseCommit: agentSessions.baseCommit })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(inArray(workContexts.id, workContextIds))
    .limit(workContextIds.length);
  return new Map(rows.map((row) => [row.id, row.baseCommit]));
};

export interface HintCandidatesQuery {
  readonly query: string;
  readonly repo: string;
}

export const listHintCandidates = async (
  deps: Deps,
  callerDeveloperId: string,
  input: HintCandidatesQuery,
): Promise<readonly HintContextCandidate[]> => {
  const searched = await searchWorkContexts(
    // Lexical by construction — see the header. The hub's real embedder must
    // not be reachable from this path.
    { db: deps.db, now: deps.now, embedder: null },
    {
      query: input.query,
      repo: input.repo,
      // In the search's own WHERE, before its bounds — a busy caller's own
      // contexts must not crowd teammates out of the pool (SEARCH_POOL_LIMIT).
      excludeDeveloperId: callerDeveloperId,
      // Same WHERE-not-after-the-bound rule for the caller's mutes: this is
      // the UserPromptSubmit injection path, a muted developer's contexts
      // must neither surface nor crowd (services/visibility.ts).
      excludeMutedForDeveloperId: callerDeveloperId,
      limit: SEARCH_POOL_LIMIT,
    },
  );
  const eligible = searched.results
    .filter((row) => HINT_ELIGIBLE_TIERS.includes(row.tier))
    // Defense in depth only — exclusion already happened inside the search.
    .filter((row) => row.developerId !== callerDeveloperId)
    .slice(0, HINT_MAX_CONTEXTS);
  const ids = eligible.map((row) => row.id);
  const [claimsByContext, baseCommits] = await Promise.all([
    listContextClaims(deps.db, callerDeveloperId, ids),
    listBaseCommits(deps.db, ids),
  ]);
  return eligible.map((row) => ({
    workContext: {
      id: row.id,
      title: row.title,
      status: row.status,
      tier: row.tier,
      developerId: row.developerId,
      developerName: row.developerName,
      baseCommit: baseCommits.get(row.id) ?? "",
      resultKind: row.resultKind,
      solvedAt: row.solvedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    claims: claimsByContext.get(row.id) ?? [],
  }));
};

export interface TargetSessionView {
  readonly sessionId: string;
  readonly developerId: string;
  readonly developerName: string;
  readonly branch: string;
  readonly status: string;
  readonly lastHeartbeatAt: string;
  readonly workContextId: string;
  readonly workContextTitle: string;
}

/**
 * Active teammate sessions whose work context targeted `value` on this repo —
 * the PreToolUse tripwire's one question. "Active" is the same presence rule
 * the presence endpoint applies (heartbeat inside the TTL, not ended), and the
 * caller's own sessions are excluded here rather than client-side so a
 * developer's parallel worktrees can never trip their own wire (DESIGN.md §4
 * self-session exclusion).
 */
export const listTargetSessions = async (
  deps: Deps,
  callerDeveloperId: string,
  repo: string,
  value: string,
): Promise<readonly TargetSessionView[]> => {
  const cutoff = presenceCutoff(deps.now());
  const rows = await deps.db
    .select({
      session: agentSessions,
      developerName: developers.name,
      workContextId: workContexts.id,
      workContextTitle: workContexts.title,
    })
    .from(workContextTargets)
    .innerJoin(
      workContexts,
      eq(workContextTargets.workContextId, workContexts.id),
    )
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .innerJoin(developers, eq(agentSessions.developerId, developers.id))
    .where(
      and(
        eq(workContextTargets.value, value),
        eq(agentSessions.repo, repo),
        // In the WHERE, not filtered after the LIMIT: a caller with many own
        // sessions on this file must not crowd teammates out of the bound.
        ne(agentSessions.developerId, callerDeveloperId),
        isNull(agentSessions.endedAt),
        gt(agentSessions.lastHeartbeatAt, cutoff),
        // Privacy filters (services/visibility.ts): an opted-out developer's
        // sessions must never trigger asks on teammates, and a developer the
        // CALLER muted must not interrupt this caller.
        visiblePresenceCondition(callerDeveloperId, agentSessions.developerId),
        notMutedCondition(callerDeveloperId, agentSessions.developerId),
      ),
    )
    .limit(TRIPWIRE_MAX_SESSIONS);
  return rows.map((row) => ({
    sessionId: row.session.id,
    developerId: row.session.developerId,
    developerName: row.developerName,
    branch: row.session.branch,
    status: row.session.status,
    lastHeartbeatAt: row.session.lastHeartbeatAt.toISOString(),
    workContextId: row.workContextId,
    workContextTitle: row.workContextTitle,
  }));
};
