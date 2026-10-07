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
 * AND THE ONE THING IT DOES DECIDE: whether the query carried a task at all
 * (HINT_MIN_SHARED_TERMS, the content floor). It is decided here because only
 * the hub holds the team's words to count against, and when the prompt
 * carried nothing the session's intent is searched in its place inside the
 * same call — a second round trip would not fit the hook budget.
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
import { and, desc, eq, gt, inArray, isNull, lte, ne, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
  agentSessions,
  claimEdges,
  claims,
  developers,
  workContexts,
  workContextTargets,
} from "../db/schema.ts";
import { UNRESOLVED_AXES, readEvidenceAxes } from "./evidence-axes.ts";
import { resolvedEvidenceCounts } from "./evidence-resolution.ts";
import { claimValidity, loadRevalidations } from "./claim-validity.ts";
import { presenceCutoff } from "./presence.ts";
import {
  TIER_CANDIDATES,
  exactTargetTokenConditions,
  exactTokens,
  searchWorkContexts,
} from "./search.ts";
import type { FtsTierRanker, RankedRow } from "./search.ts";
import { pushableClaimCondition } from "./pushable-claims.ts";
import { DECLARED_PROVENANCE } from "./similarity-gate.ts";
import { notMutedCondition, visiblePresenceCondition } from "./visibility.ts";
import {
  HINT_MAX_EXAMINED_TERMS,
  HINT_MIN_SHARED_TERMS,
  floorTermsOf,
  humanPromptText,
  isStrongSubstanceMatch,
  promptTerms,
  qualifiesAsSubstance,
  sharedTermCount,
  shownSubstance,
  statementMatch,
  textLexemes,
} from "@crosscheck/schema";
import type { ClaimValidity, FloorTerms, PromptTerms, StatementMatch } from "@crosscheck/schema";
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

/**
 * THE CONTENT FLOOR (DESIGN.md §4): how many distinct words of a query must
 * agree on ONE statement of a teammate's work — the context's own title,
 * description and intent, or one claim — before the query counts as carrying
 * a task at all. A prompt naming a target that work touched (the exact tier)
 * carries one without this count: a path is a fact.
 *
 * Derived from the team's own work rather than from a word list, so no
 * language needs one: a word that matches nothing — a typo, chatter in a
 * language nobody here writes — and a word that matches only by itself is
 * filler. One shared word is how "macxhe weiter, limit ist zurukgsetz" found a
 * rate-limit tree in the pilot, and how the golden corpus's
 * pr_limits_oneword_debatable found a header bug; two agreeing on the same
 * statement is a topic.
 *
 * COUNTED BY ONE RULE, THE CONNECTOR'S TOO (round 3, follow-up):
 * `@crosscheck/schema` content-floor.ts — words matched on their english
 * lexemes, the database's own algorithm, so "limit limits limiting" is one
 * word, and the prompt's content terms are counted, so "the", "das" and
 * "nicht" are none. The hub reads the statements and the known terms from
 * its database; a connector recounting an old hub reads them off the wire;
 * the count is the same function on both sides, and the two can no longer
 * drift (connector-core/test/content-floor-parity.test.ts).
 */
export {
  HINT_LONG_PROMPT_KNOWN_TERMS,
  HINT_LONG_PROMPT_MIN_TOPICAL,
  HINT_MAX_COUNTED_TERMS,
  HINT_MAX_EXAMINED_TERMS,
  HINT_MIN_SHARED_TERMS,
} from "@crosscheck/schema";

/** What a candidate was matched on: the prompt, or the session's intent in its place. */
export type HintMatchedOn = "prompt" | "intent";

/**
 * How many of a context's visible claims the floor reads, those sharing most
 * of the prompt's words first: the floor needs the claim that shares most,
 * which ranks first, and a bound keeps the read bounded like every other.
 */
export const HINT_FLOOR_MAX_CLAIMS_PER_CONTEXT = 32;

/** Same-author revision edge (DESIGN.md §5); its TARGET is the retracted claim. */
const SUPERSEDES_EDGE_KIND = "supersedes";

/**
 * The context's own statement — what its owner said the work is — as one
 * text, so its words are counted apart from any one claim's.
 */
const contextStatementText = sql<string>`concat_ws(' ', ${workContexts.title}, ${workContexts.description}, ${workContexts.intent}->>'summary')`;

/** The same statement as a document, for the search's own ranking. */
const contextStatement = sql`to_tsvector('english', ${contextStatementText})`;

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
  /**
   * At least one evidence ref RESOLVES — to an existing claim that is not
   * this one and not a hypothesis still proposed or rejected (review 1006b,
   * H4). The count above is satisfied by a ref to nothing, to the claim's
   * own id or to a guess; substance is gated on this.
   */
  readonly evidenceBacked: boolean;
  readonly authorDeveloperId: string;
  readonly authorDeveloperName: string;
  readonly body: string;
  /**
   * How much this claim is still worth about the CODE (1.0 spec 02). Shipped
   * on the row so the selector's substance gate reads ONE authority instead of
   * re-deriving a state from three fields across an HTTP boundary.
   *
   * `notSuperseded` above already keeps retracted rows OUT of this list, so
   * `state === "superseded"` is unreachable here through an honest hub — which
   * is exactly why the selector keeps its own check as defence in depth.
   */
  readonly validity: ClaimValidity;
  /**
   * How many distinct words of the matched query THIS claim's SHOWN SENTENCE
   * shares (in lexemes, HINT_MIN_SHARED_TERMS's unit) — what lets the
   * connector tell a finding the prompt is about from one that merely sits in
   * a tree the prompt brushed (DESIGN.md §4: substance needs a strong match).
   * Counted on exactly the text a hint would show (@crosscheck/schema
   * shownSubstance: the sentence, NFKC, redaction and the cut), never on the
   * rest of the body, and against the prompt's TOPICAL terms — closed-class
   * words excluded from the strong-match count (round 3, H3 + M6).
   */
  readonly matchedTerms: number;
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
    /**
     * How many distinct TOPICAL words of the matched query the context's OWN
     * statement — title, description, intent — shares: the tree is clearly
     * about the query when this reaches HINT_MIN_SHARED_TERMS, which lets a
     * claim of it that shares a single word count as a strong match
     * (`@crosscheck/schema` isStrongSubstanceMatch).
     */
    readonly matchedTerms: number;
  };
  readonly claims: readonly HintClaimCandidate[];
  /**
   * True when the context holds more visible claims than the window of
   * HINT_MAX_CLAIMS_PER_CONTEXT carries, so "N more claims" read off
   * `claims` is a lower bound and the hint says "at least".
   */
  readonly claimsTruncated: boolean;
  /**
   * The targets this context carries that the PROMPT lexically named (trial
   * finding #19): the exact-tier predicate's own matches, so a targets-only
   * pointer says "touched <path> <age> ago" for a file the reader's prompt
   * actually mentioned — no body, the same anchoring asymmetry. Empty when the
   * context matched on FTS alone.
   */
  readonly matchedTargets: readonly MatchedTargetView[];
  /**
   * What the candidate was matched on — the prompt, or the session's intent
   * standing in for a prompt that carried nothing task-bearing — so the hint
   * says which of the two it relates to.
   */
  readonly matchedOn: HintMatchedOn;
  /**
   * The most distinct query words ONE of its statements shares — its own, or
   * one visible claim: the number this candidate cleared the content floor
   * on, shipped so the connector can look again (hints/select.ts).
   */
  readonly sharedTerms: number;
  /**
   * The most distinct TOPICAL query words ONE of its statements shares — its
   * own, or one visible claim: the tree's STRENGTH (round 3, H3 + M6). The
   * selector pushes substance only from a tree at least as strong as the best
   * pointer, and points at the strongest tree, never at the hub's first.
   */
  readonly topicalTerms: number;
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

/** The claim window's inputs that are the same for every context of one call. */
interface ClaimWindowScope {
  readonly db: Db;
  readonly now: Date;
  readonly readerDeveloperId: string;
  readonly repo: string;
  /** The matched query's TOPICAL terms — what `matchedTerms` counts against (H3 + M6). */
  readonly tokens: readonly string[];
}

/** One context's claim window, and whether visible rows stayed outside it. */
interface ClaimWindow {
  readonly claims: readonly HintClaimCandidate[];
  readonly truncated: boolean;
}

const EMPTY_WINDOW: ClaimWindow = { claims: [], truncated: false };

const listClaimsForContext = async (
  scope: ClaimWindowScope,
  workContextId: string,
): Promise<ClaimWindow> => {
  const { db, now, readerDeveloperId, repo } = scope;
  const fetched = await db
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
        // Only what somebody vouched for (services/pushable-claims.ts): a
        // draft or a refuted claim is neither one of the tree's claims on
        // this path nor a row a flood of could evict declared substance.
        pushableClaimCondition(),
      ),
    )
    .orderBy(desc(claims.createdAt))
    // One row past the window, read only to learn that rows stayed behind.
    .limit(HINT_MAX_CLAIMS_PER_CONTEXT + 1);
  const rows = fetched.slice(0, HINT_MAX_CLAIMS_PER_CONTEXT);
  // ONE batched read for the whole page, not one per row. `notSuperseded`
  // above has already filtered retracted claims out of this list, so no edge
  // lookup is needed here — the selector's own superseded guard stays as
  // defence in depth against a hub that filters differently.
  const revalidations = await loadRevalidations(
    db,
    now,
    rows.map((row) => row.claim.id),
  );
  // WHICH REFS RESOLVE, by the one rule the solved label and the connector's
  // mirror apply too (services/evidence-resolution.ts; hold-out review H5).
  const resolvedRefs = await resolvedEvidenceCounts(
    db,
    rows.map((row) => row.claim.id),
  );
  // WAS ANYTHING ACTUALLY RUN behind each of these (1.0 spec 08 §3.1), in
  // ONE read for the context rather than one per claim. A hint is unsolicited
  // and carries a confidence, and 08 §3.6 names a bare confidence as the
  // failure mode — so the labels have to travel with the number, on the
  // surface where a reader never asked for either.
  const axes = await readEvidenceAxes({
    db,
    repo,
    claims: rows.map((row) => row.claim),
  });
  // THE TEXT A HINT WOULD SHOW is what relevance is scored on — the shared
  // shown text, the very one the connector frames: NFKC, redaction and cut
  // included (review 1006b, M4) — so a keyword-stuffed tail, a redacted span
  // or a word past the ellipsis can never make a claim a strong match for a
  // prompt its shown sentence says nothing about (review of batch 1006,
  // finding 6). A body that never crosses the wire scores nothing.
  const shownTerms = shownSentenceTerms(
    rows.map((row) => ({
      id: row.claim.id,
      sentence:
        row.claim.provenance === DECLARED_PROVENANCE
          ? shownSubstance(row.claim.body)
          : "",
    })),
    scope.tokens,
  );
  const windowed = [...rows]
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
    // THE RESOLVED COUNT, never the stored one (hold-out review, M1): an older
    // connector's count gate then reads the same verdict as evidenceBacked.
    evidenceRefCount: resolvedRefs.get(row.claim.id) ?? 0,
    evidenceBacked: (resolvedRefs.get(row.claim.id) ?? 0) > 0,
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
    // Redundant since the window holds only declared rows (the WHERE above):
    // kept as the second lock, so a widened window can never put a draft's
    // bytes on the wire.
    //
    // Positive equality on the declared value, the same rule the selector
    // applies, so the wire cannot drift into allowing what the renderer
    // refuses: an unknown provenance is one nobody vouched for, and it fails
    // closed.
    //
    // AND WITHHELD UNLESS IT CAN BE SUBSTANCE (hold-out review, M1): a body a
    // hint may not show is a body a connector older than the substance rules
    // can still inline — 0.10.0 pushed rejected approaches and proposed root
    // causes — so only a claim that qualifies (`@crosscheck/schema`
    // substance-trust.ts) carries its body; every other claim of the tree
    // travels as a pointer's claim.
    body:
      row.claim.provenance === DECLARED_PROVENANCE &&
      qualifiesAsSubstance({ ...row.claim, resolvedEvidenceRefs: resolvedRefs.get(row.claim.id) ?? 0 })
        ? row.claim.body
        : "",
    validity: claimValidity(row.claim, revalidations.get(row.claim.id), null),
    // A claim the derivation did not answer for is shipped at the WEAKEST
    // rung, never omitted: an absent field reads as "this hub does not report
    // one", which would send the reader to the wrong remedy.
    axes: axes.get(row.claim.id) ?? UNRESOLVED_AXES,
    matchedTerms: shownTerms.get(row.claim.id) ?? 0,
    createdAt: row.claim.createdAt.toISOString(),
  }));
  return { claims: windowed, truncated: fetched.length > rows.length };
};

/**
 * How many distinct query words each SHOWN sentence shares, by the floor's
 * own count (`@crosscheck/schema` content-floor.ts): english lexemes, the
 * database's algorithm.
 */
const shownSentenceTerms = (
  shown: readonly { readonly id: string; readonly sentence: string }[],
  tokens: readonly string[],
): ReadonlyMap<string, number> =>
  new Map(shown.map((entry) => [entry.id, sharedTermCount(tokens, textLexemes(entry.sentence))]));

/**
 * One bounded query PER CONTEXT — at most HINT_MAX_CONTEXTS of them — so a
 * claim-heavy context can never consume a sibling's window (a single global
 * LIMIT did exactly that; test/hints.test.ts "cannot starve a sibling
 * context's claim window").
 */
const listContextClaims = async (
  scope: ClaimWindowScope,
  workContextIds: readonly string[],
): Promise<ReadonlyMap<string, ClaimWindow>> => {
  const lists = await Promise.all(
    workContextIds.map((id) => listClaimsForContext(scope, id)),
  );
  return new Map(workContextIds.map((id, index) => [id, lists[index] ?? EMPTY_WINDOW]));
};

/**
 * What each context's OWN statement shares with the query — the other half of
 * the content floor beside its claims' — by the one rule
 * (`@crosscheck/schema` statementMatch). One bounded read for every candidate
 * id: the statement is the title, the description and the intent's summary.
 */
const listStatementTerms = async (
  db: Db,
  workContextIds: readonly string[],
  floor: FloorTerms,
): Promise<ReadonlyMap<string, StatementMatch>> => {
  if (workContextIds.length === 0 || floor.all.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({ id: workContexts.id, statement: contextStatementText })
    .from(workContexts)
    .where(inArray(workContexts.id, workContextIds))
    .limit(workContextIds.length);
  return new Map(rows.map((row) => [row.id, statementMatch(floor, row.statement)]));
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

/**
 * A candidate is backed by a fact or by agreement: an exact target, or
 * HINT_MIN_SHARED_TERMS words on one of its statements. Anything less is a
 * stray word, however high the search ranked it.
 */
const clearsFloor = (tier: SearchTier, sharedTerms: number): boolean =>
  tier === "exact" || sharedTerms >= HINT_MIN_SHARED_TERMS;

/**
 * The best match of any one VISIBLE claim per context — under the claim
 * window's own two conditions, retraction and the reader's mutes, so a hidden
 * author's words can never qualify a tree — by the one rule
 * (`@crosscheck/schema` statementMatch): the best floor count (C1) and the
 * most topical words, the tree's strength beside its own statement's (H3 +
 * M6). Over the whole pool, the GIN prefilter first: the floor is decided
 * BEFORE the pool is cut to HINT_MAX_CONTEXTS, so three weak trees cannot
 * crowd out a fourth that qualifies. Each context's claims are read most
 * matching first, at most HINT_FLOOR_MAX_CLAIMS_PER_CONTEXT of them.
 */
const listClaimTermMaxima = async (
  db: Db,
  readerDeveloperId: string,
  workContextIds: readonly string[],
  floor: FloorTerms,
): Promise<ReadonlyMap<string, StatementMatch>> => {
  if (workContextIds.length === 0 || floor.all.length === 0) {
    return new Map();
  }
  const anyToken = sql`websearch_to_tsquery('english', ${floor.all.join(" or ")})`;
  const ranked = db
    .select({
      workContextId: claims.workContextId,
      body: claims.body,
      position: sql<number>`row_number() over (partition by ${claims.workContextId} order by ts_rank(${claims.tsv}, ${anyToken}) desc, ${claims.id})`.as("position"),
    })
    .from(claims)
    .innerJoin(agentSessions, eq(claims.authorSessionId, agentSessions.id))
    .where(
      and(
        inArray(claims.workContextId, workContextIds),
        sql`${claims.tsv} @@ ${anyToken}`,
        notSuperseded(db),
        notMutedCondition(readerDeveloperId, agentSessions.developerId),
        // A draft's words never qualify its tree (review 1006b, L6).
        pushableClaimCondition(),
      ),
    )
    .as("floor_claims");
  const rows = await db
    .select({ workContextId: ranked.workContextId, body: ranked.body })
    .from(ranked)
    .where(lte(ranked.position, HINT_FLOOR_MAX_CLAIMS_PER_CONTEXT))
    .limit(workContextIds.length * HINT_FLOOR_MAX_CLAIMS_PER_CONTEXT);
  return new Map(
    [...Map.groupBy(rows, (row) => row.workContextId)].map(([id, group]): [string, StatementMatch] => {
      const matches = group.map((row) => statementMatch(floor, row.body));
      return [id, { floor: Math.max(...matches.map((match) => match.floor)), topical: Math.max(...matches.map((match) => match.topical)) }];
    }),
  );
};

/** The claim author's session, beside the context owner's the scope reads. */
const claimAuthors = alias(agentSessions, "hint_claim_authors");

/**
 * THE POOL IS RANKED ON PUSHABLE TEXT ONLY (hold-out review, M3): a
 * context's own statement — title, description, intent — and its pushable
 * claims: declared, not refuted, not revised away, by an author the reader
 * has not muted. Never the normalized document, which still summarises every
 * claim, and never a claim body the hint would not show — so twelve trees
 * flooded with drafts, refuted or retracted claims on the prompt's words no
 * longer push the one tree whose declared claim answers it out of the
 * ten-row pool. The search's own scope (repo, the reader excluded, mutes)
 * rides in every WHERE.
 */
const rankOnPushableText =
  (db: Db, readerDeveloperId: string): FtsTierRanker =>
  async (tokens, scope): Promise<readonly RankedRow[]> => {
    const tsquery = sql`websearch_to_tsquery('english', ${tokens.join(" or ")})`;
    const [statements, pushable] = await Promise.all([
      db
        .select({
          id: workContexts.id,
          createdAt: workContexts.createdAt,
          updatedAt: workContexts.updatedAt,
          rank: sql<number>`ts_rank(${contextStatement}, ${tsquery})`,
        })
        .from(workContexts)
        .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
        .where(and(scope, sql`${contextStatement} @@ ${tsquery}`))
        .orderBy(sql`ts_rank(${contextStatement}, ${tsquery}) DESC`)
        .limit(TIER_CANDIDATES),
      db
        .select({
          id: claims.workContextId,
          createdAt: workContexts.createdAt,
          updatedAt: workContexts.updatedAt,
          rank: sql<number>`max(ts_rank(${claims.tsv}, ${tsquery}))`,
        })
        .from(claims)
        .innerJoin(workContexts, eq(claims.workContextId, workContexts.id))
        .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
        .innerJoin(claimAuthors, eq(claims.authorSessionId, claimAuthors.id))
        .where(
          and(
            scope,
            sql`${claims.tsv} @@ ${tsquery}`,
            pushableClaimCondition(),
            notSuperseded(db),
            notMutedCondition(readerDeveloperId, claimAuthors.developerId),
          ),
        )
        .groupBy(claims.workContextId, workContexts.createdAt, workContexts.updatedAt)
        .orderBy(sql`max(ts_rank(${claims.tsv}, ${tsquery})) DESC`)
        .limit(TIER_CANDIDATES),
    ]);
    const best = [...statements, ...pushable].reduce<ReadonlyMap<string, RankedRow>>(
      (byId, row) => ((byId.get(row.id)?.rank ?? -1) >= row.rank ? byId : new Map([...byId, [row.id, row]])),
      new Map(),
    );
    return [...best.values()];
  };

/** What one search is made of: the text, for its exact tier, and the words the floor counts. */
interface CandidateQuery {
  readonly text: string;
  readonly floor: FloorTerms;
  readonly repo: string;
  readonly on: HintMatchedOn;
}

/** What one candidate shares with the query on its best statement. */
export interface CandidateFloor {
  /** The floor count of its best statement — its own, or one visible claim (C1, M7). */
  readonly sharedTerms: number;
  /** The most topical words one of its statements shares: the tree's strength (H3 + M6). */
  readonly topicalTerms: number;
  /** The topical words its OWN statement shares — what lets one of its claims match strongly. */
  readonly ownTerms: number;
}

const NO_FLOOR: CandidateFloor = { sharedTerms: 0, topicalTerms: 0, ownTerms: 0 };

/**
 * THE HUB'S CONTENT FLOOR over some contexts: each one's own statement and
 * its visible claims, counted by the one rule (`@crosscheck/schema`
 * statementMatch). Exported so the connector's recount of an old hub's
 * candidates is pinned to it, row for row
 * (connector-core/test/content-floor-parity.test.ts).
 */
export const contentFloorOf = async (
  db: Db,
  readerDeveloperId: string,
  floor: FloorTerms,
  workContextIds: readonly string[],
): Promise<ReadonlyMap<string, CandidateFloor>> => {
  const [statementTerms, claimTerms] = await Promise.all([
    listStatementTerms(db, workContextIds, floor),
    listClaimTermMaxima(db, readerDeveloperId, workContextIds, floor),
  ]);
  return new Map(
    workContextIds.map((id): [string, CandidateFloor] => [
      id,
      {
        sharedTerms: Math.max(statementTerms.get(id)?.floor ?? 0, claimTerms.get(id)?.floor ?? 0),
        topicalTerms: Math.max(statementTerms.get(id)?.topical ?? 0, claimTerms.get(id)?.topical ?? 0),
        // TOPICAL, like every relevance count the selector reads (H3 + M6).
        ownTerms: statementTerms.get(id)?.topical ?? 0,
      },
    ]),
  );
};

/**
 * A prompt's floor terms ON THIS HUB: its ranked terms that some work context
 * or claim of the repo says at all, by the database's own index (M7), under
 * the one rule (`@crosscheck/schema` floorTermsOf).
 */
export const hubFloorTermsOf = async (db: Db, repo: string, terms: PromptTerms): Promise<FloorTerms> =>
  floorTermsOf(terms, await listKnownTerms(db, repo, terms.ranked));

/** One query's candidates, each of which clears the floor on its own. */
const matchCandidates = async (
  deps: Deps,
  callerDeveloperId: string,
  query: CandidateQuery,
): Promise<readonly HintContextCandidate[]> => {
  const searched = await searchWorkContexts(
    // Lexical by construction — see the header. The hub's real embedder must
    // not be reachable from this path.
    { db: deps.db, now: deps.now, embedder: null },
    {
      query: query.text,
      // RANKED ON CONTENT TERMS (review 1006b, M8): the raw tokens let a
      // German prompt's "das ist nicht die" fill the pool with every tree
      // that says them, before the floor below ever ran.
      ftsTokens: query.floor.all,
      // AND RANKED ON PUSHABLE TEXT ONLY (hold-out review, M3): what a hint
      // would never show cannot rank a tree into the pool either.
      rankFtsTier: rankOnPushableText(deps.db, callerDeveloperId),
      repo: query.repo,
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
  const pool = searched.results
    .filter((row) => HINT_ELIGIBLE_TIERS.includes(row.tier))
    // Defense in depth only — exclusion already happened inside the search.
    .filter((row) => row.developerId !== callerDeveloperId);
  const floors = await contentFloorOf(deps.db, callerDeveloperId, query.floor, pool.map((row) => row.id));
  // THE FLOOR, PER CANDIDATE: every tree a hint may name must itself share
  // HINT_MIN_SHARED_TERMS words on ONE of its statements — its own, or one
  // visible claim — one of them TOPICAL (C1), or hold a target the query
  // named. Decided over the whole pool, then cut to the bound.
  const qualified = pool
    .map((row) => ({ row, ...(floors.get(row.id) ?? NO_FLOOR) }))
    .filter(({ row, sharedTerms }) => clearsFloor(row.tier, sharedTerms))
    .slice(0, HINT_MAX_CONTEXTS);
  const ids = qualified.map(({ row }) => row.id);
  const [claimsByContext, baseCommits, matchedTargets] = await Promise.all([
    listContextClaims(
      { db: deps.db, now: deps.now(), readerDeveloperId: callerDeveloperId, repo: query.repo, tokens: query.floor.topical },
      ids,
    ),
    listBaseCommits(deps.db, ids),
    listMatchedTargets(deps.db, ids, exactTokens(query.text)),
  ]);
  return qualified.map(({ row, ownTerms, sharedTerms, topicalTerms }) => ({
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
      matchedTerms: ownTerms,
    },
    claims: withheldUnlessStrong(
      (claimsByContext.get(row.id) ?? EMPTY_WINDOW).claims,
      ownTerms,
      (matchedTargets.get(row.id) ?? []).some((target) => target.kind === CONTENT_IDENTITY_TARGET_KIND),
    ),
    claimsTruncated: (claimsByContext.get(row.id) ?? EMPTY_WINDOW).truncated,
    matchedTargets: matchedTargets.get(row.id) ?? [],
    matchedOn: query.on,
    sharedTerms,
    topicalTerms,
  }));
};

/** The target kind that is content identity: the prompt carried the error itself. */
const CONTENT_IDENTITY_TARGET_KIND = "error_fingerprint";

/**
 * THE HUB'S OWN STRONG-MATCH TEST ON THE BODY (hold-out review round 3, H3 +
 * M6): a body ships only when the claim qualifies as substance (the window
 * already withheld every other) AND is strongly matched by the one rule the
 * selector applies (`@crosscheck/schema` isStrongSubstanceMatch, topical
 * counts). A connector older than the selector's best-match rule — 0.10.0
 * pushes the first trusted claim it is handed — then has no weakly matched,
 * wrong-tree finding to inline.
 */
const withheldUnlessStrong = (
  window: readonly HintClaimCandidate[],
  treeTerms: number,
  isContentIdentity: boolean,
): readonly HintClaimCandidate[] =>
  window.map((claim) =>
    isStrongSubstanceMatch({ claimTerms: claim.matchedTerms, treeTerms, isContentIdentity }) ? claim : { ...claim, body: "" },
  );

/**
 * The prompt's candidates, or silence. NOTHING STANDS IN for a prompt that
 * carried no task — not the session's intent either (owner decision, review
 * 1006b M6): a hint on "mache weiter" is noise whatever it is matched on. An
 * `intent` a connector built before that decision still sends is ignored.
 */
export const listHintCandidates = async (
  deps: Deps,
  callerDeveloperId: string,
  input: HintCandidatesQuery,
): Promise<readonly HintContextCandidate[]> => {
  // A TURN THE HARNESS WROTE is nobody's prompt: a background task's
  // notification or another agent's message, which an installed connector
  // still sends as the query. Only the human text outside the wrappers is
  // scored — and a turn that is all harness has none, so the content-free
  // verdict below refuses it (a separate harness check here was an exact
  // equivalent of that line, removed as the hold-out review's L2 found).
  const humanText = humanPromptText(input.query);
  // NOTHING TASK-BEARING, nothing to match: what is left is a command to the
  // session — steering, a trigger beside meta words, conversation control or
  // an agent operation (@crosscheck/schema prompt-terms.ts, hold-out review
  // H1). The content terms are all the pool is ranked and counted on, so a
  // steering word never counts beside a real one either (review 1006b, H1).
  const terms = promptTerms(humanText);
  // And a prompt that carries the session on — "cache fix is merged, next" —
  // is matched to nothing, whatever else it says, for every connector that
  // still sends it (round 4, C1).
  if (terms.isContentFree || terms.hasContinuation) {
    return [];
  }
  return matchCandidates(deps, callerDeveloperId, {
    text: humanText,
    floor: await hubFloorTermsOf(deps.db, input.repo, terms),
    repo: input.repo,
    on: "prompt",
  });
};

/**
 * THE TERMS WORTH COUNTING (round 3, M7): of the prompt's ranked terms — task
 * clauses only, topical words first — those that some work context of this
 * repo, or one of its claims, says at all, in the ranked order. A word nobody
 * on the team wrote cannot match on any statement, so leaving it out changes
 * no count; it only stops taking a slot. One query, one GIN probe per term,
 * at most HINT_MAX_EXAMINED_TERMS of them.
 */
const listKnownTerms = async (db: Db, repo: string, ranked: readonly string[]): Promise<readonly string[]> => {
  const examined = ranked.slice(0, HINT_MAX_EXAMINED_TERMS);
  if (examined.length === 0) {
    return [];
  }
  const result = await db.execute<{ word: string }>(sql`
    SELECT term.word AS word
    FROM unnest(ARRAY[${sql.join(examined.map((word) => sql`${word}`), sql`, `)}]::text[]) WITH ORDINALITY AS term(word, position)
    CROSS JOIN LATERAL (SELECT plainto_tsquery('english', term.word) AS lexeme) AS query
    WHERE numnode(query.lexeme) > 0
      AND (
        EXISTS (
          SELECT 1 FROM work_contexts AS context
          JOIN agent_sessions AS owner ON owner.id = context.session_id
          WHERE owner.repo = ${repo} AND context.tsv @@ query.lexeme
        )
        OR EXISTS (
          SELECT 1 FROM claims AS claim
          JOIN work_contexts AS context ON context.id = claim.work_context_id
          JOIN agent_sessions AS owner ON owner.id = context.session_id
          WHERE owner.repo = ${repo} AND claim.tsv @@ query.lexeme
        )
      )
    ORDER BY term.position`);
  return result.rows.map((row) => row.word);
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
