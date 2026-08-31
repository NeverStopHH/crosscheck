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
import { and, desc, eq, gt, inArray, isNull, ne, notExists, or, sql } from "drizzle-orm";

import {
  agentSessions,
  claimEdges,
  claims,
  developers,
  workContexts,
  workContextTargets,
} from "../db/schema.ts";
import { presenceCutoff } from "./presence.ts";
import {
  exactTargetTokenConditions,
  exactTokens,
  searchWorkContexts,
} from "./search.ts";
import { DECLARED_PROVENANCE } from "./similarity-gate.ts";
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
 * Most matched targets one candidate carries for the #19 pointer. The pointer
 * names ONE ("touched <path> <age> ago"), so this is generous headroom that
 * keeps the query bounded like every other query on the hub, not a working
 * limit.
 */
export const HINT_MAX_MATCHED_TARGETS_PER_CONTEXT = 5;

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

export interface MatchedTargetView {
  readonly kind: string;
  readonly value: string;
  /** First-seen ingest time, or null for a row that predates the column (#19). */
  readonly createdAt: string | null;
}

export interface HintContextCandidate {
  readonly workContext: {
    readonly id: string;
    readonly title: string;
    readonly status: string;
    /**
     * The session's intent (trial finding #16): what makes "same topic,
     * different files" surface — the pointer hint shows it, and a context
     * with an intent and no claims still earns a pointer (connector selector).
     */
    readonly intent: Record<string, unknown> | null;
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
  /**
   * The targets this context carries that the PROMPT lexically named (trial
   * finding #19): the exact-tier predicate's own matches, so a targets-only
   * pointer says "touched <path> <age> ago" for a file the reader's prompt
   * actually mentioned — no body, the same anchoring asymmetry. Empty when the
   * context matched on FTS alone.
   */
  readonly matchedTargets: readonly MatchedTargetView[];
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
    // Window MEMBERSHIP prefers declared rows: the conclusion summarizer's
    // whole purpose is more derived drafts per context, and the declared-only
    // injection gate runs client side AFTER this bound — a flood of newer
    // drafts must not evict the declared substance a reader could have been
    // handed, or hints degrade to pointers where evidence existed. Membership
    // only: the returned list is re-sorted newest-first below, so consumers
    // still see the hub's claim order, and the pointer claimCount still
    // counts every row in the window whatever its provenance.
    .orderBy(
      sql`(${claims.provenance} = ${DECLARED_PROVENANCE}) desc`,
      desc(claims.createdAt),
    )
    .limit(HINT_MAX_CLAIMS_PER_CONTEXT);
  return [...rows]
    .sort(
      (a, b) => b.claim.createdAt.getTime() - a.claim.createdAt.getTime(),
    )
    .map((row) => ({
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
    // WITHHELD unless somebody vouched for it (audit row V2-X4). A derived,
    // unreviewed draft is nobody's answer — `hints/select.ts` has always
    // refused to render one as substance, but a CLIENT that declines to print
    // a body is a different guarantee from the body never crossing the wire,
    // and only the second one holds against a modified connector, a shared
    // machine, or the next surface somebody adds to this response. It matters
    // more since ghost checks shipped: a ghost draft is text a THIRD party
    // influenced through a model, and it rides this wire like any other claim
    // body of its context (DESIGN.md §3).
    //
    // The ROW still travels: a pointer states how many claims it withholds,
    // and dropping the row would make that count lie.
    //
    // Positive equality on the declared value, the same rule the selector
    // applies, so the wire cannot drift into allowing what the renderer
    // refuses: an unknown provenance is one nobody vouched for, and it fails
    // closed.
    body: row.claim.provenance === DECLARED_PROVENANCE ? row.claim.body : "",
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

/**
 * The targets each candidate carries that the query's exact tokens matched
 * (trial finding #19) — ONE bounded query over `work_context_targets` for all
 * candidate ids, using the SAME predicate the exact tier ranked them on
 * (search.ts `exactTargetTokenConditions`). Grouped by context and capped per
 * context so a target-heavy tree cannot unbound the response.
 */
const listMatchedTargets = async (
  db: Db,
  workContextIds: readonly string[],
  tokens: readonly string[],
): Promise<ReadonlyMap<string, readonly MatchedTargetView[]>> => {
  if (workContextIds.length === 0 || tokens.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      workContextId: workContextTargets.workContextId,
      kind: workContextTargets.kind,
      value: workContextTargets.value,
      createdAt: workContextTargets.createdAt,
    })
    .from(workContextTargets)
    .where(
      and(
        inArray(workContextTargets.workContextId, workContextIds),
        or(...exactTargetTokenConditions(tokens)),
      ),
    )
    .limit(workContextIds.length * HINT_MAX_MATCHED_TARGETS_PER_CONTEXT);
  const byContext = new Map<string, MatchedTargetView[]>();
  for (const row of rows) {
    const list = byContext.get(row.workContextId) ?? [];
    if (list.length >= HINT_MAX_MATCHED_TARGETS_PER_CONTEXT) {
      continue;
    }
    list.push({
      kind: row.kind,
      value: row.value,
      createdAt: row.createdAt === null ? null : row.createdAt.toISOString(),
    });
    byContext.set(row.workContextId, list);
  }
  return byContext;
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
  const [claimsByContext, baseCommits, matchedTargets] = await Promise.all([
    listContextClaims(deps.db, callerDeveloperId, ids),
    listBaseCommits(deps.db, ids),
    listMatchedTargets(deps.db, ids, exactTokens(input.query)),
  ]);
  return eligible.map((row) => ({
    workContext: {
      id: row.id,
      title: row.title,
      status: row.status,
      intent: row.intent,
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
    matchedTargets: matchedTargets.get(row.id) ?? [],
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
  /** The overlapping session's stated intent; the ask reason shows it. */
  readonly workContextIntent: Record<string, unknown> | null;
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
      workContextIntent: workContexts.intent,
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
    workContextIntent: row.workContextIntent ?? null,
  }));
};
