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
import { and, asc, desc, eq, gt, inArray, isNull, lte, ne, notExists, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { GHOST_ACTIVE_WINDOW_DAYS, GHOST_HOT_TARGET_MAX_CONTEXTS } from "../constants.ts";
import { listLargeChanges } from "./ghost-overlap.ts";

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
import { locationHiddenFrom, projectRow } from "./live-location.ts";
import type { HiddenLocations } from "./live-location.ts";
import { presenceCutoff } from "./presence.ts";
import { contextBaseCommit } from "./topic-base-commit.ts";
import {
  SEARCH_MAX_QUERY_CHARS,
  TIER_CANDIDATES,
  exactTargetTokenConditions,
  exactTokens,
  searchWorkContexts,
  targetMatchesToken,
} from "./search.ts";
import type { FtsTierRanker, RankedRow } from "./search.ts";
import { pushableClaimCondition } from "./pushable-claims.ts";
import { DECLARED_PROVENANCE } from "./similarity-gate.ts";
import { notMutedCondition, visiblePresenceCondition } from "./visibility.ts";
import { ordinaryTargetCondition } from "./generated-targets.ts";
import {
  WITHHELD_TITLE,
  isGeneratedPath,
  DOTTED_NAME_DOT_SQL,
  HINT_LONG_PROMPT_KNOWN_TERMS,
  HINT_MAX_EXAMINED_TERMS,
  HINT_MIN_SHARED_TERMS,
  compareTreeStrength,
  floorTermsOf,
  humanPromptText,
  isConventionalFileName,
  isStrongSubstanceMatch,
  promptTaskOf,
  promptTerms,
  qualifiesAsSubstance,
  sharedLexemes,
  shownSubstance,
  statementMatch,
  strongestTreeIndex,
  textLexemes,
} from "@crosscheck/schema";
import type { ClaimValidity, FloorTerms, PromptTerms, StatementMatch, TreeStrength } from "@crosscheck/schema";
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
 * text, so its words are counted apart from any one claim's: the title as
 * THIS READER may read it (below), the description and the intent's summary.
 */
const statementTextWith = (title: SQL): SQL<string> =>
  sql<string>`concat_ws(' ', ${title}, ${workContexts.description}, ${workContexts.intent}->>'summary')`;

/**
 * WITHOUT A TITLE WITHHELD FROM THIS READER: an opted-out owner's fallback
 * title is her branch (services/live-location.ts), kept off every page and
 * out of the search index. Counted, a colleague's guess at her branch moved
 * `matchedTerms` and could decide the content floor — the confirmation the
 * index rebuild took away; ranked, it pulled her work into the guess's pool.
 * Two spellings of the one rule, for the two moments it is read:
 *
 *   titleNotIn     after the search: the rows it already projected for this
 *                  reader (`titleWithheld`, their ids) lose their title;
 *   titleSeenBy    before any row is projected (the pool's own ranking and
 *                  the known-word prefilter): a title counts only when its
 *                  owner's location is visible to this reader, or when the
 *                  connector marked it the host's or a person's — never a
 *                  location title (isLocationTitle). An UNMARKED title of a
 *                  hidden owner is left out: the shape rule needs her
 *                  branches, and leaving it out is the side that cannot leak.
 */
const titleNotIn = (titleWithheld: readonly string[]): SQL =>
  titleWithheld.length === 0
    ? sql`${workContexts.title}`
    : sql`(CASE WHEN ${inArray(workContexts.id, [...titleWithheld])} THEN NULL ELSE ${workContexts.title} END)`;

const titleSeenBy = (readerDeveloperId: string | undefined): SQL =>
  readerDeveloperId === undefined
    ? sql`${workContexts.title}`
    : sql`(CASE WHEN ${visiblePresenceCondition(readerDeveloperId, agentSessions.developerId)} OR ${workContexts.titleSource} IN ('host', 'person') THEN ${workContexts.title} ELSE NULL END)`;

/**
 * A TEXT'S DOTTED NAMES IN THEIR PARTS, as the database reads them (hold-out
 * review round 5, L2): "products.name" says products and name here too, as
 * the shared rule (`@crosscheck/schema` textLexemes) and every prompt read it.
 */
const dottedNameParts = (text: SQL): SQL =>
  sql`to_tsvector('english', regexp_replace(${text}, ${sql.raw(`'${DOTTED_NAME_DOT_SQL}'`)}, ' ', 'g'))`;

/** What one claim says to the floor: its words, and its dotted names' parts — stored (L2; claims_words_tsv_idx). */
const claimWords = sql`${claims.wordsTsv}`;

/**
 * What a context's document says, to the known-word prefilter — stored (L2;
 * work_contexts_words_tsv_idx). Generated from normalized_doc, which already
 * keeps a withheld title out (services/live-location.ts isTitleWithheldFromIndex).
 */
const documentWords = sql`${workContexts.wordsTsv}`;

/** The same statement as a document, for the search's own ranking — its dotted names' parts too (L2). */
const statementDocument = (title: SQL): SQL => {
  const text = statementTextWith(title);
  return sql`(to_tsvector('english', ${text}) || ${dottedNameParts(text)})`;
};

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
  /**
   * Of those, how many NO OTHER candidate of the response says, on any of
   * its statements (round 4, C2): a finding is shown only on a word that
   * tells its tree from the runner-up — "invoice" and "pdf" were said by the
   * timeout tree and the labels tree alike.
   */
  readonly distinctTerms: number;
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

/** A claim of the window before the response is known: what tells it apart is counted against the other candidates (C2). */
type WindowClaim = Omit<HintClaimCandidate, "distinctTerms">;

/** One context's claim window, and whether visible rows stayed outside it. */
interface ClaimWindow {
  readonly claims: readonly WindowClaim[];
  readonly truncated: boolean;
  /** The topical lexemes each claim's SHOWN sentence shares with the query (C2). */
  readonly shown: ReadonlyMap<string, ReadonlySet<string>>;
}

const EMPTY_WINDOW: ClaimWindow = { claims: [], truncated: false, shown: new Map() };

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
    readerDeveloperId,
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
    matchedTerms: shownTerms.get(row.claim.id)?.size ?? 0,
    createdAt: row.claim.createdAt.toISOString(),
  }));
  return { claims: windowed, truncated: fetched.length > rows.length, shown: shownTerms };
};

/**
 * Which distinct query words each SHOWN sentence shares, by the floor's own
 * count (`@crosscheck/schema` content-floor.ts): english lexemes, the
 * database's algorithm — the words themselves, so the response can tell
 * which of them another candidate says too (C2).
 */
const shownSentenceTerms = (
  shown: readonly { readonly id: string; readonly sentence: string }[],
  tokens: readonly string[],
): ReadonlyMap<string, ReadonlySet<string>> =>
  new Map(shown.map((entry) => [entry.id, sharedLexemes(tokens, textLexemes(entry.sentence))]));

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
 * What some statements of one context share with the query: the best of
 * them by the one rule (`@crosscheck/schema` statementMatch), and every
 * TOPICAL query word any of them says — what tells this tree from the one
 * whose finding a hint would show (round 4, C2).
 */
interface ContextMatch extends StatementMatch {
  readonly saidTopical: ReadonlySet<string>;
}

const contextMatchOf = (floor: FloorTerms, statements: readonly string[]): ContextMatch => {
  const matches = statements.map((statement) => statementMatch(floor, statement));
  return {
    floor: Math.max(0, ...matches.map((match) => match.floor)),
    topical: Math.max(0, ...matches.map((match) => match.topical)),
    saidTopical: new Set(statements.flatMap((statement) => [...sharedLexemes(floor.topical, textLexemes(statement))])),
  };
};

/**
 * What each context's OWN statement shares with the query — the other half of
 * the content floor beside its claims' — by the one rule
 * (`@crosscheck/schema` statementMatch). One bounded read for every candidate
 * id: the statement is the title, the description and the intent's summary —
 * the title only where this reader may read it: `titleWithheld` names the ids
 * whose title the search already withheld (titleNotIn).
 */
const listStatementTerms = async (
  db: Db,
  workContextIds: readonly string[],
  floor: FloorTerms,
  titleWithheld: readonly string[],
): Promise<ReadonlyMap<string, ContextMatch>> => {
  if (workContextIds.length === 0 || floor.all.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({ id: workContexts.id, statement: statementTextWith(titleNotIn(titleWithheld)) })
    .from(workContexts)
    .where(inArray(workContexts.id, workContextIds))
    .limit(workContextIds.length);
  return new Map(rows.map((row) => [row.id, contextMatchOf(floor, [row.statement])]));
};

/**
 * The base commit each context's work stands on, for the drift label: a
 * topic's own, else its owning session's (services/topic-base-commit.ts).
 */
const listBaseCommits = async (
  db: Db,
  workContextIds: readonly string[],
): Promise<ReadonlyMap<string, string>> => {
  if (workContextIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({ id: workContexts.id, baseCommit: contextBaseCommit })
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
 *
 * NEVER A GENERATED TARGET (services/generated-targets.ts): the floor and the
 * strong-match test score on these, and a lockfile a prompt names is nobody's
 * plan — it would let any tree that touched one clear the floor on the name.
 * In the WHERE, before the bound, like every filter here.
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
        ordinaryTargetCondition(),
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
 * Topical words a tree must share when the prompt named only a CONVENTIONAL
 * FILE NAME it touched (hold-out review round 5, M4): "Dockerfile",
 * "package.json" and ".nvmrc" are in every repo, and "bump node to 22 in
 * .nvmrc and the Dockerfile" was pointed at the Docker tree on the name
 * alone, sharing no word with it.
 */
export const HINT_CONVENTIONAL_NAME_MIN_TOPICAL = 1;

/**
 * The prompt named this tree's targets only by conventional file names
 * (`@crosscheck/schema` isConventionalFileName): no target is matched by any
 * other word of it — "docker/postgres/Dockerfile" written whole is a fact,
 * "Dockerfile" alone is a name. A tree the exact tier did not match has no
 * matched target, and this rule leaves it to the floor.
 */
const isNameOnlyMatch = (targets: readonly MatchedTargetView[], words: readonly string[]): boolean => {
  const specific = words.filter((word) => !isConventionalFileName(word));
  return targets.length > 0 && !targets.some((target) => specific.some((word) => targetMatchesToken(target.value, word)));
};

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
): Promise<ReadonlyMap<string, ContextMatch>> => {
  if (workContextIds.length === 0 || floor.all.length === 0) {
    return new Map();
  }
  const anyToken = sql`websearch_to_tsquery('english', ${floor.all.join(" or ")})`;
  const ranked = db
    .select({
      workContextId: claims.workContextId,
      body: claims.body,
      position: sql<number>`row_number() over (partition by ${claims.workContextId} order by ts_rank(${claimWords}, ${anyToken}) desc, ${claims.id})`.as("position"),
    })
    .from(claims)
    .innerJoin(agentSessions, eq(claims.authorSessionId, agentSessions.id))
    .where(
      and(
        inArray(claims.workContextId, workContextIds),
        sql`${claimWords} @@ ${anyToken}`,
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
    [...Map.groupBy(rows, (row) => row.workContextId)].map(([id, group]): [string, ContextMatch] => [
      id,
      contextMatchOf(
        floor,
        group.map((row) => row.body),
      ),
    ]),
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
    // The statement as THIS reader may read it: a hidden owner's location
    // title neither ranks her work nor pulls it into the pool (titleSeenBy).
    const statement = statementDocument(titleSeenBy(readerDeveloperId));
    const [statements, pushable] = await Promise.all([
      db
        .select({
          id: workContexts.id,
          createdAt: workContexts.createdAt,
          updatedAt: workContexts.updatedAt,
          rank: sql<number>`ts_rank(${statement}, ${tsquery})`,
        })
        .from(workContexts)
        .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
        .where(and(scope, sql`${statement} @@ ${tsquery}`))
        .orderBy(sql`ts_rank(${statement}, ${tsquery}) DESC`)
        .limit(TIER_CANDIDATES),
      db
        .select({
          id: claims.workContextId,
          createdAt: workContexts.createdAt,
          updatedAt: workContexts.updatedAt,
          rank: sql<number>`max(ts_rank(${claimWords}, ${tsquery}))`,
        })
        .from(claims)
        .innerJoin(workContexts, eq(claims.workContextId, workContexts.id))
        .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
        .innerJoin(claimAuthors, eq(claims.authorSessionId, claimAuthors.id))
        .where(
          and(
            scope,
            sql`${claimWords} @@ ${tsquery}`,
            pushableClaimCondition(),
            notSuperseded(db),
            notMutedCondition(readerDeveloperId, claimAuthors.developerId),
          ),
        )
        .groupBy(claims.workContextId, workContexts.createdAt, workContexts.updatedAt)
        .orderBy(sql`max(ts_rank(${claimWords}, ${tsquery})) DESC`)
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
  /** Every topical query word one of its statements says, in lexemes: what another tree's finding must not lean on alone (C2). */
  readonly saidTopical: ReadonlySet<string>;
}

const NO_FLOOR: CandidateFloor = { sharedTerms: 0, topicalTerms: 0, ownTerms: 0, saidTopical: new Set() };

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
  // The ids whose title this reader may not read (titleNotIn): their
  // statement counts without it.
  titleWithheld: readonly string[] = [],
): Promise<ReadonlyMap<string, CandidateFloor>> => {
  const [statementTerms, claimTerms] = await Promise.all([
    listStatementTerms(db, workContextIds, floor, titleWithheld),
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
        saidTopical: new Set([...(statementTerms.get(id)?.saidTopical ?? []), ...(claimTerms.get(id)?.saidTopical ?? [])]),
      },
    ]),
  );
};

/**
 * A QUERY THAT FILLS THE ROUTE'S CAP IS A WINDOW (round 4, H1): of a prompt
 * longer than the wire carries — the head and tail an older connector sends,
 * or this connector's ranked terms cut at the cap — so its known words are a
 * keyhole onto the prompt's, and the long-prompt floor holds whatever they
 * count. A prompt a person types to within a tenth of the cap is long anyway.
 */
export const HINT_WINDOW_QUERY_MIN_CHARS = Math.floor(SEARCH_MAX_QUERY_CHARS * 0.9);

/**
 * A prompt's floor terms ON THIS HUB: its ranked terms that some work context
 * or claim of the repo says at all, by the database's own index (M7), under
 * the one rule (`@crosscheck/schema` floorTermsOf) — held to the long-prompt
 * floor when the query is a window (H1), and known only from what a
 * statement the reader may see says (L1).
 */
export const hubFloorTermsOf = async (
  db: Db,
  repo: string,
  terms: PromptTerms,
  isWindow = false,
  readerDeveloperId?: string,
): Promise<FloorTerms> => {
  const known = await listKnownTerms(db, repo, terms.ranked, readerDeveloperId);
  return floorTermsOf(terms, known, isWindow ? Math.max(known.length, HINT_LONG_PROMPT_KNOWN_TERMS + 1) : known.length);
};

/** A candidate's strength by the one rule (`@crosscheck/schema` TreeStrength): exact, best statement, own statement. */
const strengthOfCandidate = (candidate: { readonly row: { readonly tier: SearchTier } } & CandidateFloor): TreeStrength => ({
  isExact: candidate.row.tier === "exact",
  topical: candidate.topicalTerms,
  own: candidate.ownTerms,
  shared: candidate.sharedTerms,
});

/** One query's candidates, each of which clears the floor on its own. */
const matchCandidates = async (
  deps: Deps,
  callerDeveloperId: string,
  hidden: HiddenLocations,
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
      // The same rule for the search's own claim pass, which ranks in the
      // ranker's place on a search handed none: a pushed surface finds no
      // tree by an unreviewed draft's words (services/search.ts; review
      // round 4, M3).
      excludeDerivedClaims: true,
      repo: query.repo,
      // In the search's own WHERE, before its bounds — a busy caller's own
      // contexts must not crowd teammates out of the pool (SEARCH_POOL_LIMIT).
      excludeDeveloperId: callerDeveloperId,
      // Same WHERE-not-after-the-bound rule for the caller's mutes: this is
      // the UserPromptSubmit injection path, a muted developer's contexts
      // must neither surface nor crowd (services/visibility.ts).
      excludeMutedForDeveloperId: callerDeveloperId,
      // Nor by a generated file the prompt named: the exact tier clears the
      // floor on the name alone (services/generated-targets.ts).
      excludeGeneratedTargets: true,
      limit: SEARCH_POOL_LIMIT,
      viewerDeveloperId: callerDeveloperId,
      hidden,
    },
  );
  const pool = searched.results
    .filter((row) => HINT_ELIGIBLE_TIERS.includes(row.tier))
    // Defense in depth only — exclusion already happened inside the search.
    .filter((row) => row.developerId !== callerDeveloperId);
  // The targets the prompt named, read once for the whole pool: the floor
  // needs them (M4) and the pointer shows them (#19).
  const exactWords = exactTokens(query.text);
  // The titles the search withheld from this reader — an opted-out owner's
  // branch, already projected on the row: no statement is counted on them.
  const titleWithheld = pool
    .filter((row) => hidden.has(row.developerId) && row.title === WITHHELD_TITLE)
    .map((row) => row.id);
  const [floors, matchedTargets] = await Promise.all([
    contentFloorOf(deps.db, callerDeveloperId, query.floor, pool.map((row) => row.id), titleWithheld),
    listMatchedTargets(deps.db, pool.map((row) => row.id), exactWords),
  ]);
  // THE FLOOR, PER CANDIDATE: every tree a hint may name must itself share
  // HINT_MIN_SHARED_TERMS words on ONE of its statements — its own, or one
  // visible claim — one of them TOPICAL (C1), or hold a target the query
  // named. Decided over the whole pool, then cut to the bound — the
  // STRONGEST first (round 4, M1), the search's order among equals: since a
  // task's meta words count, more trees qualify, and the search's first three
  // left the one strongest out.
  const qualified = pool
    .map((row) => ({ row, ...(floors.get(row.id) ?? NO_FLOOR) }))
    // A MATCH ON A CONVENTIONAL FILE NAME ALONE is no fact about the work (round 5, M4).
    .filter(({ row, topicalTerms }) => !isNameOnlyMatch(matchedTargets.get(row.id) ?? [], exactWords) || topicalTerms >= HINT_CONVENTIONAL_NAME_MIN_TOPICAL)
    .filter(({ row, sharedTerms }) => clearsFloor(row.tier, sharedTerms))
    .toSorted((left, right) => compareTreeStrength(strengthOfCandidate(left), strengthOfCandidate(right)))
    .slice(0, HINT_MAX_CONTEXTS);
  const ids = qualified.map(({ row }) => row.id);
  const [claimsByContext, baseCommits] = await Promise.all([
    listContextClaims(
      { db: deps.db, now: deps.now(), readerDeveloperId: callerDeveloperId, repo: query.repo, tokens: query.floor.topical },
      ids,
    ),
    listBaseCommits(deps.db, ids),
  ]);
  // THE ONE STRONGEST CANDIDATE, or none on a tie (round 4, C2): only its
  // findings may ship a body, by the rule the selector applies too.
  const strongest = strongestTreeIndex(qualified.map(strengthOfCandidate));
  return qualified.map(({ row, ownTerms, sharedTerms, topicalTerms }, index) => ({
    workContext: {
      title: row.title,
      ...projectRow(
        hidden,
        // No title facts: the title above is the search row's, which the
        // search already projected for this viewer by its marker and branch;
        // judged again without them, a host title would be withheld too.
        { developerId: row.developerId, kind: "work_context" },
        {
          id: row.id,
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
        // "" is this field's own "unknown" on the wire (connector hub.ts: the
        // drift label skips it), so a hidden owner's HEAD reads exactly as a
        // context whose base commit the hub never knew.
        { baseCommit: "empty" },
      ),
    },
    // Each nested row by its OWN owner: a claim by its author, who may not
    // be the context's; a matched target by the context's owner, whose
    // session touched the file — and its `createdAt` is WHEN, so it is not
    // a creation time the allowlist shows (live-location.ts).
    claims: withheldUnlessStrong(claimsByContext.get(row.id) ?? EMPTY_WINDOW, {
      isStrongest: index === strongest,
      treeTerms: ownTerms,
      isContentIdentity: (matchedTargets.get(row.id) ?? []).some((target) => target.kind === CONTENT_IDENTITY_TARGET_KIND),
      // What every OTHER candidate says: a finding must say one word none of them does.
      saidElsewhere: new Set(qualified.filter((_, other) => other !== index).flatMap((other) => [...other.saidTopical])),
    }).map((claim) => projectRow(hidden, { developerId: claim.authorDeveloperId, kind: "claim" }, claim)),
    claimsTruncated: (claimsByContext.get(row.id) ?? EMPTY_WINDOW).truncated,
    matchedTargets: (matchedTargets.get(row.id) ?? []).map((target) =>
      projectRow(hidden, { developerId: row.developerId, kind: "target" }, target, { createdAt: "null" }),
    ),
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
 *
 * STRICT (round 4, C2): and only in the ONE strongest candidate of the
 * response (`@crosscheck/schema` strongestTreeIndex — none on a tie), on two
 * topical words of which one no other candidate says (`distinctTerms`,
 * shipped so the selector looks again), with its tree's own statement
 * sharing one.
 */
interface StrictScope {
  readonly isStrongest: boolean;
  readonly treeTerms: number;
  readonly isContentIdentity: boolean;
  /** The topical query lexemes every other candidate of the response says. */
  readonly saidElsewhere: ReadonlySet<string>;
}

const withheldUnlessStrong = (window: ClaimWindow, scope: StrictScope): readonly HintClaimCandidate[] =>
  window.claims.map((claim) => {
    const distinctTerms = [...(window.shown.get(claim.id) ?? [])].filter((lexeme) => !scope.saidElsewhere.has(lexeme)).length;
    const counted = { ...claim, distinctTerms };
    return scope.isStrongest &&
      isStrongSubstanceMatch({ claimTerms: claim.matchedTerms, distinctTerms, treeTerms: scope.treeTerms, isContentIdentity: scope.isContentIdentity })
      ? counted
      : { ...counted, body: "" };
  });

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
  // is matched to nothing, and one whose continuation only leads — "next: add
  // rate limiting to the upload endpoint" — on what follows it, for every
  // connector that still sends the whole prompt (round 4, C1; round 5, C1;
  // @crosscheck/schema prompt-task.ts, the connector's own rule).
  const task = promptTaskOf(humanText, terms);
  if (task === null) {
    return [];
  }
  // ONCE per request: the search projects its rows with it, and so does the
  // candidate list (review round 5, H3 — the hook's budget is 400 ms). Read
  // beside the floor's own known-word read, so it costs no wall clock of its own.
  const [hidden, floor] = await Promise.all([
    locationHiddenFrom(deps.db, callerDeveloperId),
    hubFloorTermsOf(deps.db, input.repo, task.terms, input.query.length >= HINT_WINDOW_QUERY_MIN_CHARS, callerDeveloperId),
  ]);
  return matchCandidates(deps, callerDeveloperId, hidden, {
    text: task.text,
    floor,
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
 *
 * ONLY WHAT A FLOOR STATEMENT SAYS (round 4, L1): a context's own statement —
 * title, description, intent — and its visible pushable claims, never the
 * reader's own work. The normalized document the GIN index covers also holds
 * a context's status, its claims' kinds, its target paths' parts and its
 * drafts: words no statement the floor counts on says, which a connector
 * recounting an old hub never sees, and which filled counted slots and made a
 * short prompt long. The index stays the prefilter; the statement decides.
 */
const listKnownTerms = async (
  db: Db,
  repo: string,
  ranked: readonly string[],
  readerDeveloperId?: string,
): Promise<readonly string[]> => {
  const examined = ranked.slice(0, HINT_MAX_EXAMINED_TERMS);
  if (examined.length === 0) {
    return [];
  }
  const lexeme = sql.raw("query.lexeme");
  const visibleOwner = readerDeveloperId === undefined ? [] : [ne(agentSessions.developerId, readerDeveloperId), notMutedCondition(readerDeveloperId, agentSessions.developerId)];
  const statementSays = db
    .select({ one: sql`1` })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    // The statement as the reader may read it (titleSeenBy): a hidden owner's
    // location title makes no word of a guess "known".
    .where(
      and(
        eq(agentSessions.repo, repo),
        sql`${documentWords} @@ ${lexeme}`,
        sql`${statementDocument(titleSeenBy(readerDeveloperId))} @@ ${lexeme}`,
        ...visibleOwner,
      ),
    );
  const claimSays = db
    .select({ one: sql`1` })
    .from(claims)
    .innerJoin(workContexts, eq(claims.workContextId, workContexts.id))
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .innerJoin(claimAuthors, eq(claims.authorSessionId, claimAuthors.id))
    .where(
      and(
        eq(agentSessions.repo, repo),
        sql`${claimWords} @@ ${lexeme}`,
        pushableClaimCondition(),
        notSuperseded(db),
        ...visibleOwner,
        ...(readerDeveloperId === undefined ? [] : [notMutedCondition(readerDeveloperId, claimAuthors.developerId)]),
      ),
    );
  const result = await db.execute<{ word: string }>(sql`
    SELECT term.word AS word
    FROM unnest(ARRAY[${sql.join(examined.map((word) => sql`${word}`), sql`, `)}]::text[]) WITH ORDINALITY AS term(word, position)
    CROSS JOIN LATERAL (SELECT plainto_tsquery('english', term.word) AS lexeme) AS query
    WHERE numnode(query.lexeme) > 0
      AND (EXISTS (${statementSays}) OR EXISTS (${claimSays}))
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
  /**
   * The files THEIR change touched in the window when it is a LARGE CHANGE
   * (over GHOST_MAX_CONTEXT_TARGETS), else null — the qualifier the ask
   * prints, and why the row ranks after the focused ones. Never a reason a
   * row is missing (services/ghost-overlap.ts states the rule).
   */
  readonly largeChangeFiles: number | null;
  /**
   * When the overlapping work context LANDED, or null while it is open — so
   * the person's collision line can say the teammate CHANGED the file and it
   * merged, rather than that they are working on it (connector-core
   * hints/collision-notice.ts). The row's matching rule is untouched.
   */
  readonly landedAt: string | null;
}

/**
 * Candidate sessions read before the ranking: the hot-value line. A file more
 * live contexts than this carry is a lockfile (GHOST_HOT_TARGET_MAX_CONTEXTS),
 * so ranking by size past it buys nothing — and below it, the ranking sees
 * every candidate, so the bound of five never cuts a focused session that a
 * fresher large change outranked by heartbeat alone.
 */
const TRIPWIRE_MAX_CANDIDATES = GHOST_HOT_TARGET_MAX_CONTEXTS;

const MS_PER_DAY = 86_400_000;

/**
 * The ask names the FIRST row (connector hooks/pre-tool-use.ts), so the order
 * is the decision. Focused before a LARGE CHANGE — a session renaming three
 * hundred files through this one is weaker evidence of a plan in the reader's
 * way than one whose plan is in it (services/ghost-overlap.ts byStrength) —
 * then the freshest heartbeat, then a stable id. The ghost check's first key,
 * a shared error fingerprint, has nothing to rank here: a tripwire row
 * matches ONE value, the file about to be edited, so no row shares a failure.
 */
const byTripwireStrength = (left: TargetSessionView, right: TargetSessionView): number =>
  Number(left.largeChangeFiles !== null) - Number(right.largeChangeFiles !== null) ||
  Date.parse(right.lastHeartbeatAt) - Date.parse(left.lastHeartbeatAt) ||
  left.sessionId.localeCompare(right.sessionId) ||
  left.workContextId.localeCompare(right.workContextId);

/**
 * Active teammate sessions whose work context targeted `value` on this repo —
 * the PreToolUse tripwire's one question. "Active" is the same presence rule
 * the presence endpoint applies (heartbeat inside the TTL, not ended), and the
 * caller's own sessions are excluded here rather than client-side so a
 * developer's parallel worktrees can never trip their own wire (DESIGN.md §4
 * self-session exclusion).
 *
 * A LARGE CHANGE IS RANKED AND QUALIFIED, NEVER DROPPED (release gate,
 * 2026-10-08): the ghost check's rule, on the surface that asks before an
 * edit. Its size is counted once per candidate in one grouped query
 * (listLargeChanges), in the ghost check's window, and an owner hidden from
 * the caller never reaches it — the presence condition keeps her sessions
 * off this answer entirely, so none of her times is read for it.
 */
export const listTargetSessions = async (
  deps: Deps,
  callerDeveloperId: string,
  repo: string,
  value: string,
  /**
   * The asking connector says the repo declared this generated file
   * authoritative (`authoritativeGenerated`): the name check below must not
   * answer for a repo whose config the hub cannot read. Stored labels still
   * filter — a teammate whose own connector labelled the file is the either-
   * side rule the ghost check applies too.
   */
  authoritative = false,
): Promise<readonly TargetSessionView[]> => {
  // A well-known mechanically generated name is nobody's plan, whoever asks:
  // an older connector's tripwire, which knows no generated-target rule, asks
  // about a nested lockfile all the same (services/generated-targets.ts).
  if (!authoritative && isGeneratedPath(value)) {
    return [];
  }
  const cutoff = presenceCutoff(deps.now());
  const rows = await deps.db
    .select({
      session: agentSessions,
      developerName: developers.name,
      workContextId: workContexts.id,
      workContextTitle: workContexts.title,
      workContextIntent: workContexts.intent,
      landedAt: workContexts.landedAt,
      // WHERE THE WORK ON THE FILE LIVES (release gate, 1b): a topic's own
      // branch, its session's only when the context has none — a long
      // detached session's branch is the checkout it started in. Never an
      // opted-out owner's: the presence condition below keeps her off.
      branch: sql<string>`coalesce(${workContexts.branch}, ${agentSessions.branch})`,
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
        // A teammate whose connector labelled this file generated is not
        // working on it in any sense a stop is for — in the WHERE, before the
        // LIMIT, like every filter here.
        ordinaryTargetCondition(),
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
    // Freshest first, then stable ids, so the bounded read keeps the
    // freshest candidates; the ranking below decides the order shown. The
    // work context's id breaks a tie inside one session (review M4): the
    // connector names every row and the person's notice lists them in this
    // order, so it is never the storage order.
    .orderBy(desc(agentSessions.lastHeartbeatAt), asc(agentSessions.id), asc(workContexts.id))
    .limit(TRIPWIRE_MAX_CANDIDATES);
  const large = await listLargeChanges(
    deps.db,
    callerDeveloperId,
    rows.map((row) => row.workContextId),
    new Date(deps.now().getTime() - GHOST_ACTIVE_WINDOW_DAYS * MS_PER_DAY),
  );
  return rows
    .map((row) => ({
      sessionId: row.session.id,
      developerId: row.session.developerId,
      developerName: row.developerName,
      branch: row.branch,
      status: row.session.status,
      lastHeartbeatAt: row.session.lastHeartbeatAt.toISOString(),
      workContextId: row.workContextId,
      workContextTitle: row.workContextTitle,
      workContextIntent: row.workContextIntent ?? null,
      largeChangeFiles: large.get(row.workContextId) ?? null,
      landedAt: row.landedAt === null ? null : row.landedAt.toISOString(),
    }))
    .sort(byTripwireStrength)
    .slice(0, TRIPWIRE_MAX_SESSIONS);
};
