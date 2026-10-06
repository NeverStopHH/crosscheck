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
import { and, desc, eq, gt, inArray, isNull, ne, notExists, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

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
  SEARCH_MAX_QUERY_TOKENS,
  exactTargetTokenConditions,
  exactTokens,
  searchWorkContexts,
} from "./search.ts";
import { pushableClaimCondition } from "./pushable-claims.ts";
import { DECLARED_PROVENANCE } from "./similarity-gate.ts";
import { notMutedCondition, visiblePresenceCondition } from "./visibility.ts";
import {
  humanPromptText,
  isHarnessTurn,
  promptTerms,
  shownSubstance,
} from "@crosscheck/schema";
import type { ClaimValidity } from "@crosscheck/schema";
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
 * COUNTED IN LEXEMES, after the english configuration's own stemming, and
 * without the stop words of English AND German (the database's own lists —
 * sharedTermsSql below), so "limit limits limiting" is one word and "the",
 * "das" and "nicht" are none.
 */
export const HINT_MIN_SHARED_TERMS = 2;

/** What a candidate was matched on: the prompt, or the session's intent in its place. */
export type HintMatchedOn = "prompt" | "intent";

/** Same-author revision edge (DESIGN.md §5); its TARGET is the retracted claim. */
const SUPERSEDES_EDGE_KIND = "supersedes";


/**
 * How many distinct LEXEMES of `terms` the document matches — the count
 * HINT_MIN_SHARED_TERMS is stated in. One subquery over at most
 * SEARCH_MAX_QUERY_TOKENS terms.
 *
 * A FUNCTION WORD IS NEVER A TERM: `terms` are the prompt's CONTENT terms
 * (@crosscheck/schema prompt-terms.ts) — PostgreSQL's English stop list
 * always out, its German one out of a German prompt (review 1006b, L1; the
 * english configuration alone kept "das", "ist", "nicht" as terms, finding
 * 2 of the review before). The lexeme that is MATCHED stays the english one,
 * because that is the configuration every tsv in this database is built with.
 */
const sharedTermsSql = (document: SQL, terms: readonly string[]): SQL<number> =>
  terms.length === 0
    ? sql<number>`0`
    : sql<number>`(SELECT count(DISTINCT term.lexeme::text)::int
        FROM (SELECT plainto_tsquery('english', word) AS lexeme
              FROM unnest(ARRAY[${sql.join(
                terms.map((term) => sql`${term}`),
                sql`, `,
              )}]::text[]) AS words(word)) AS term
        WHERE numnode(term.lexeme) > 0
          AND ${document} @@ term.lexeme)`;


/**
 * The context's own statement — what its owner said the work is — as one
 * document, so its words are counted apart from any one claim's.
 */
const contextStatement = sql`to_tsvector('english', concat_ws(' ', ${workContexts.title}, ${workContexts.description}, ${workContexts.intent}->>'summary'))`;

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
   * rest of the body, and against the prompt's content terms.
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
     * How many distinct words of the matched query the context's OWN
     * statement — title, description, intent — shares: the tree is clearly
     * about the query when this reaches HINT_MIN_SHARED_TERMS, which lets a
     * claim of it that shares a single word count as a strong match
     * (connector hints/select.ts).
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
  /** The matched query's FTS tokens — what `matchedTerms` counts against. */
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
  const shownTerms = await listShownSentenceTerms(
    db,
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
    evidenceRefCount: row.claim.evidenceRefs.length,
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
    body: row.claim.provenance === DECLARED_PROVENANCE ? row.claim.body : "",
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
 * How many distinct query words each SHOWN sentence shares, in one bounded
 * query for the whole claim window: the sentences travel as a parameter
 * array and are tokenized with the same english configuration every tsv on
 * this hub uses.
 */
const listShownSentenceTerms = async (
  db: Db,
  shown: readonly { readonly id: string; readonly sentence: string }[],
  tokens: readonly string[],
): Promise<ReadonlyMap<string, number>> => {
  const counted = shown.filter((entry) => entry.sentence.length > 0);
  if (counted.length === 0 || tokens.length === 0) {
    return new Map();
  }
  const result = await db.execute<{ id: string; terms: number }>(sql`
    SELECT shown.id AS id,
           ${sharedTermsSql(sql`to_tsvector('english', shown.sentence)`, tokens)} AS terms
    FROM unnest(
      ARRAY[${sql.join(counted.map((entry) => sql`${entry.id}`), sql`, `)}]::text[],
      ARRAY[${sql.join(counted.map((entry) => sql`${entry.sentence}`), sql`, `)}]::text[]
    ) AS shown(id, sentence)`);
  return new Map(result.rows.map((row) => [row.id, Number(row.terms)]));
};

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
 * How many distinct query words each context's OWN statement shares — the
 * other half of the content floor beside its claims' counts. One bounded
 * query for every candidate id.
 */
const listStatementTerms = async (
  db: Db,
  workContextIds: readonly string[],
  tokens: readonly string[],
): Promise<ReadonlyMap<string, number>> => {
  if (workContextIds.length === 0 || tokens.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({ id: workContexts.id, terms: sharedTermsSql(contextStatement, tokens) })
    .from(workContexts)
    .where(inArray(workContexts.id, workContextIds))
    .limit(workContextIds.length);
  return new Map(rows.map((row) => [row.id, Number(row.terms)]));
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
 * The best shared-word count of any one VISIBLE claim per context — under the
 * claim window's own two conditions, retraction and the reader's mutes, so a
 * hidden author's words can never qualify a tree. One bounded aggregate, the
 * GIN prefilter first, over the whole pool: the floor is decided BEFORE the
 * pool is cut to HINT_MAX_CONTEXTS, so three weak trees cannot crowd out a
 * fourth that qualifies.
 */
const listClaimTermMaxima = async (
  db: Db,
  readerDeveloperId: string,
  workContextIds: readonly string[],
  tokens: readonly string[],
): Promise<ReadonlyMap<string, number>> => {
  if (workContextIds.length === 0 || tokens.length === 0) {
    return new Map();
  }
  const anyToken = sql`websearch_to_tsquery('english', ${tokens.join(" or ")})`;
  const rows = await db
    .select({
      id: claims.workContextId,
      terms: sql<number>`max(${sharedTermsSql(sql`${claims.tsv}`, tokens)})`,
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
    .groupBy(claims.workContextId);
  return new Map(rows.map((row) => [row.id, Number(row.terms)]));
};

/** What one search is made of: the text, for its exact tier, and the content terms. */
interface CandidateQuery {
  readonly text: string;
  /** The prompt's content terms, bounded — what the pool is ranked and counted on. */
  readonly terms: readonly string[];
  readonly repo: string;
  readonly on: HintMatchedOn;
}

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
      ftsTokens: query.terms,
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
  const tokens = query.terms;
  const poolIds = pool.map((row) => row.id);
  const [statementTerms, claimTerms] = await Promise.all([
    listStatementTerms(deps.db, poolIds, tokens),
    listClaimTermMaxima(deps.db, callerDeveloperId, poolIds, tokens),
  ]);
  // THE FLOOR, PER CANDIDATE: every tree a hint may name must itself share
  // HINT_MIN_SHARED_TERMS words on ONE of its statements — its own, or one
  // visible claim — or hold a target the query named. Decided over the whole
  // pool, then cut to the bound.
  const qualified = pool
    .map((row) => ({
      row,
      ownTerms: statementTerms.get(row.id) ?? 0,
      sharedTerms: Math.max(statementTerms.get(row.id) ?? 0, claimTerms.get(row.id) ?? 0),
    }))
    .filter(({ row, sharedTerms }) => clearsFloor(row.tier, sharedTerms))
    .slice(0, HINT_MAX_CONTEXTS);
  const ids = qualified.map(({ row }) => row.id);
  const [claimsByContext, baseCommits, matchedTargets] = await Promise.all([
    listContextClaims(
      { db: deps.db, now: deps.now(), readerDeveloperId: callerDeveloperId, repo: query.repo, tokens },
      ids,
    ),
    listBaseCommits(deps.db, ids),
    listMatchedTargets(deps.db, ids, exactTokens(query.text)),
  ]);
  return qualified.map(({ row, ownTerms, sharedTerms }) => ({
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
    claims: (claimsByContext.get(row.id) ?? EMPTY_WINDOW).claims,
    claimsTruncated: (claimsByContext.get(row.id) ?? EMPTY_WINDOW).truncated,
    matchedTargets: matchedTargets.get(row.id) ?? [],
    matchedOn: query.on,
    sharedTerms,
  }));
};

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
  // scored, and a turn that is all harness gets nothing.
  if (isHarnessTurn(input.query)) {
    return [];
  }
  const humanText = humanPromptText(input.query);
  // NOTHING TASK-BEARING, nothing to match: what is left is a command to the
  // session — steering, a trigger beside meta words, conversation control or
  // an agent operation (@crosscheck/schema prompt-terms.ts, hold-out review
  // H1). The content terms are all the pool is ranked and counted on, so a
  // steering word never counts beside a real one either (review 1006b, H1).
  const terms = promptTerms(humanText);
  if (terms.isContentFree) {
    return [];
  }
  return matchCandidates(deps, callerDeveloperId, {
    text: humanText,
    terms: terms.content.slice(0, SEARCH_MAX_QUERY_TOKENS),
    repo: input.repo,
    on: "prompt",
  });
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
