/**
 * The hint selector — where the anchoring asymmetry is STRUCTURE, not wording
 * (DESIGN.md §4, normative).
 *
 * Proactively injectable substance is exactly (review 1006b, H4):
 *   (b) a ROOT CAUSE whose status is settled (likely_root_cause,
 *       partially_confirmed); and
 *   (c) a stated DECISION, still proposed (the 2026-10 pilot: 95 hints, 0
 *       opened — a decision can never reach a settled status, so it was
 *       pointer-only forever, behind a get_diagnosis no agent made) —
 * both EVIDENCE-BACKED in the hub's sense (a cited ref resolves to another
 * claim that is not a proposed or rejected hypothesis) and both ONLY ON A
 * STRONG MATCH: the claim itself shares HINT_MIN_SHARED_TERMS words with what
 * was matched, or the match is an error fingerprint. Trust and relevance are
 * both required to assert something unasked (§4 "Solved before" states the
 * same narrowing for the briefing). The old (a), a rejected approach, is a
 * pointer now — the owner's decision.
 * Everything else — rejected approaches, bare proposed hypotheses and
 * PROPOSED ROOT CAUSES above all (principle 5: an unverified cause pushed
 * unasked as "a teammate's recorded finding" anchors the wrong theory), any
 * other kind under a settled status, and any (b)/(c) claim on a weak match —
 * reaches the reader only as a POINTER: context id + title, no body. The pointer variant of the return type carries no claim at all, so a
 * body cannot leak through it by construction; test/hint-select.test.ts and
 * test/hint-substance-select.test.ts pin every branch and
 * scripts/mutation-check.ts re-breaks the load-bearing ones.
 *
 * ONE selection per call, never a list — that is MAX_HINTS_PER_PROMPT enforced
 * by the return type. Below the precision floor (no proven lexical tier), or
 * past the session cap, or with nothing unseen: SILENCE. No hint is strictly
 * better than a weak one (§10 risk 1).
 *
 * FROM THE BEST MATCH ONLY (hold-out review round 3, H3 + M6): the hub's
 * order is search rank, not relevance, and taking its first trusted claim
 * pushed a finding from the wrong tree for 12 of 119 hold-out tasks. The
 * substance comes only from a tree at least as STRONG as any a pointer could
 * name — an exact target first, then `topicalTerms`, the most topical words
 * one of its statements (its own, or a claim) shares — the hub's order among
 * equals, and the claim sharing most topical words within it; a pointer names
 * the strongest tree, never a weaker one in its place — or nothing, once it
 * was shown.
 *
 * STRICT (hold-out review round 4, C2): the round-4 hold-out still showed 9
 * of 182 tasks a finding from another tree. Now the strongest tree must be
 * the ONE strongest — a tie at the top says nothing, finding or pointer — and
 * a finding of it is shown only when it shares two topical words, one of
 * which no other candidate says, and the tree's own statement shares one
 * (`@crosscheck/schema` isStrongSubstanceMatch, strongestTreeIndex: the
 * hub's withholding calls the same two rules). Otherwise the pointer at it.
 */
import {
  HINT_MIN_EVIDENCE_REFS,
  HINT_MIN_SHARED_TERMS,
  MAX_HINTS_PER_SESSION,
  SUBSTANCE_MATCH_KIND,
} from "../constants.ts";
import {
  HINT_MAX_EXAMINED_TERMS,
  clearsFloorOn,
  floorTermsOf,
  isStrongSubstanceMatch,
  knownTermsIn,
  statementMatch,
  strongestTreeIndex,
  substanceSentence,
} from "@crosscheck/schema";
import type { FloorTerms, TreeStrength } from "@crosscheck/schema";

import { isAssertableValidity } from "../claim-validity.ts";
import type { HintClaimCandidate, HintContextCandidate } from "../http/hub.ts";

/**
 * Tiers where the prompt provably matched — recency/vector filler never hints.
 * The hub applies the same floor server-side (HINT_ELIGIBLE_TIERS in
 * packages/server/src/services/hints.ts), and search ranking draws the same
 * "match is a fact" line (SOLVED_FLOOR_TIERS in
 * packages/server/src/services/search.ts). This copy sits across an HTTP
 * boundary no import can reach and search.ts keeps its own unexported, so
 * the three literals' equality is pinned rather than assumed — silent drift
 * would move the floor to whichever copy is loosest:
 *
 * VERIFY: grep -c '\["exact", "fts"\]' packages/connector-core/src/hints/select.ts packages/server/src/services/hints.ts packages/server/src/services/search.ts
 * PRINTS: packages/connector-core/src/hints/select.ts:1
 * PRINTS: packages/server/src/services/hints.ts:1
 * PRINTS: packages/server/src/services/search.ts:1
 */
const HINT_ELIGIBLE_TIERS: ReadonlySet<string> = new Set(["exact", "fts"]);

/** Statuses that mark a claim settled enough to inject (with evidence). */
const INJECTABLE_STATUSES: ReadonlySet<string> = new Set([
  "likely_root_cause",
  "partially_confirmed",
]);

export type HintSelection =
  | { readonly kind: "silence" }
  | {
      readonly kind: "claim";
      readonly context: HintContextCandidate;
      readonly claim: HintClaimCandidate;
      /** The tree's other claims the substance leaves behind — the pointer to the rest. */
      readonly restCount: number;
      /** The hub's claim window left rows out, so restCount is a lower bound. */
      readonly isRestLowerBound: boolean;
      /**
       * What goes out instead when the finding cannot be shown whole beside
       * the lines appended after it (flows/hint.ts): the pointer at the same
       * tree, under the pointer pass's own unseen rule, or silence.
       */
      readonly ifUnfit: Extract<HintSelection, { readonly kind: "pointer" | "silence" }>;
    }
  | {
      readonly kind: "pointer";
      readonly context: HintContextCandidate;
      /** How many claims the pointer withholds — a count, never a body. */
      readonly claimCount: number;
      /**
       * Trial finding #19: the file the prompt lexically named that this
       * context touched — a TARGETS-ONLY pointer, claimCount 0, no body. Absent
       * for the claim-count pointer (a context with foreign claims). Same
       * anchoring asymmetry: an id, a title and a touched-file fact, pulled
       * deliberately with get_diagnosis, never a claim pushed unasked.
       */
      readonly matchedTarget?: {
        readonly value: string;
        readonly createdAt: string | null;
      };
    };

export interface SelectHintInput {
  /** Hub-ranked candidates from GET /api/hints/candidates. */
  readonly candidates: readonly HintContextCandidate[];
  /** Refs (claim and context ids) already delivered this session. */
  readonly seenRefIds: readonly string[];
  /** Hints already delivered this session — the 5/session cap counts this. */
  readonly deliveredCount: number;
  /** The reader; their own claims are knowledge, not hints. */
  readonly selfDeveloperId: string | null;
  /**
   * The RANKED terms of the query the hub was sent (@crosscheck/schema
   * promptTerms().ranked: task clauses only, topical words first) — what the
   * floor is RECOUNTED on, exactly as the hub counts them, when a hub too old
   * to send `sharedTerms` sends a candidate (hold-out review H4; round 3,
   * follow-up). Required, so no caller can skip the recount by forgetting it.
   */
  readonly promptTerms: readonly string[];
  /**
   * Those of the terms that can name a topic (promptTerms().topical: hold-out
   * review round 3, C1; every class but steering since round 4, M1): the
   * recount needs one of them on the same statement as the second shared
   * word. Required for the same reason.
   */
  readonly promptTopicalTerms: readonly string[];
}

const SILENCE = { kind: "silence" } as const satisfies HintSelection;

/**
 * EVIDENCE THAT RESOLVES (review 1006b, H4): the hub's verdict that a cited
 * ref is another existing claim and not a proposed or rejected hypothesis —
 * a count alone is satisfied by a ref to nothing, to the claim itself or to a
 * guess. The count stays beside it as the second lock; a hub too old to send
 * the verdict buys no substance.
 */
const hasEvidence = (claim: HintClaimCandidate): boolean =>
  claim.evidenceRefCount >= HINT_MIN_EVIDENCE_REFS && claim.evidenceBacked === true;

/**
 * (b) of the header: a ROOT CAUSE whose status is settled — never another
 * kind under a settled status (an observation "partially_confirmed" is still
 * an observation; review 1006b, H4).
 */
const isSettledRootCause = (claim: HintClaimCandidate): boolean =>
  claim.kind === "root_cause" && INJECTABLE_STATUSES.has(claim.status);

/**
 * (c) of the header: a DECISION its author stated and nobody has taken back.
 * Positive equality on `proposed`, the status a decision is born with and
 * keeps, so `rejected` — the decision itself turned down — and any status
 * this build does not know stay out (fail closed).
 *
 * A ROOT CAUSE IS NOT HERE, and that is principle 5, decided by Nick on the
 * batch-1006 review (finding 3): a cause still `proposed` is a theory nobody
 * confirmed, and pushing it unasked under "a teammate's recorded finding" is
 * the anchoring §4 exists to prevent. A root cause is substance only once its
 * status is settled — (b) — and stays a pointer before that.
 */
const isStatedDecision = (claim: HintClaimCandidate): boolean =>
  claim.kind === "decision" && claim.status === "proposed";

/**
 * THE RELEVANCE HALF OF THE GATE, counted by the hub against the query that
 * matched (the prompt, or the session's intent standing in for it). Strong
 * is one of three things:
 *
 *   - the CLAIM shares HINT_MIN_SHARED_TERMS words with the query — the
 *     finding is about it, wherever its tree ranked;
 *   - the TREE's own statement (title, description, intent) shares that many
 *     AND the claim shares at least one — the tree is clearly about the
 *     query, and this finding touches it. Never the tree alone: a tree the
 *     prompt matched can hold a dozen findings about something else;
 *   - the match is an error fingerprint — content identity needs no words,
 *     exactly as the briefing's solved line rules (SUBSTANCE_MATCH_KIND).
 *
 * A shared FILE is none of them: it says two pieces of work are near each
 * other (§4 Solved before). An older hub sends no counts, and a relevance
 * nobody measured fails closed to the pointer.
 *
 * ONE RULE ON BOTH SIDES (round 3, H3 + M6): `@crosscheck/schema`
 * isStrongSubstanceMatch, over the hub's TOPICAL counts — the hub withholds
 * every body it refuses, so a connector older than this one has nothing
 * weakly matched to inline.
 */
const isStrongMatch = (
  claim: HintClaimCandidate,
  context: HintContextCandidate,
): boolean =>
  isStrongSubstanceMatch({
    claimTerms: claim.matchedTerms ?? 0,
    // STRICT (round 4, C2): one of its words no other candidate says; a hub
    // that never counted it buys no substance.
    distinctTerms: claim.distinctTerms ?? 0,
    treeTerms: context.workContext.matchedTerms ?? 0,
    isContentIdentity: context.matchedTargets.some((target) => target.kind === SUBSTANCE_MATCH_KIND),
  });

/**
 * A TREE'S STRENGTH (round 3, H3 + M6; `@crosscheck/schema` TreeStrength):
 * an exact target first — the prompt named something the tree touched, a
 * fact — then the most TOPICAL query words one of its statements shares (the
 * hub's `topicalTerms`). A hub too old to send the number is measured here by
 * the rule the recount floors it with (round 3, follow-up): the most topical
 * words one of its statements on the wire shares, so an old hub's order no
 * longer picks the weaker of two trees that both clear the floor.
 */
const strengthOf = (context: HintContextCandidate, selfDeveloperId: string | null, recount: FloorTerms): TreeStrength => ({
  isExact: context.workContext.tier === "exact",
  topical:
    context.topicalTerms ??
    Math.max(0, ...[wireStatementOf(context), ...recountBodies(context, selfDeveloperId)].map((statement) => statementMatch(recount, statement).topical)),
  // The tree's own statement breaks a tie on the count (round 4, M1).
  own: context.workContext.matchedTerms ?? statementMatch(recount, wireStatementOf(context)).topical,
  // And last, every shared word, a weak one among them (round 4, decision 3).
  shared:
    context.sharedTerms ??
    Math.max(0, ...[wireStatementOf(context), ...recountBodies(context, selfDeveloperId)].map((statement) => statementMatch(recount, statement).floor)),
});

/**
 * The order a tree's claims are offered in: most relevant first, more shared
 * words before fewer, the hub's order on a tie (a stable sort over a copy).
 */
const offeringOrder = (
  claims: readonly HintClaimCandidate[],
): readonly HintClaimCandidate[] =>
  [...claims].sort((left, right) => (right.matchedTerms ?? 0) - (left.matchedTerms ?? 0));

/** Whether this claim may be pushed as substance from this tree: trust and relevance, both. */
const isDeliverable = (claim: HintClaimCandidate, context: HintContextCandidate): boolean =>
  isInjectable(claim) && isStrongMatch(claim, context);

/**
 * Machine-derived claims are never substance (DESIGN.md §3: Tier-1 drafts
 * "appear only as pull-able pointers") — a summarizer's guess must not be
 * proactively injected into a teammate's context under trust labels, whatever
 * status or evidence count it carries.
 *
 * Positive equality, not `!== "derived"`: the boundary schema admits any
 * non-empty provenance string (http/hub.ts z.string().min(1)), and an unknown
 * value is one nobody vouched for — it stays out (fail closed), the same
 * direction as DECLARED_PROVENANCE on the hub's contradiction surfaces
 * (packages/server/src/services/similarity-gate.ts).
 */
const isDeclared = (claim: HintClaimCandidate): boolean =>
  claim.provenance === "declared";

/**
 * A body the hub did not send is not substance to inject (audit row V2-X4).
 * The hub withholds the body of every claim nobody vouched for
 * (packages/server/src/services/hints.ts), so an empty body normally arrives
 * beside a provenance the rule above already refuses — this check is about the
 * OTHER hub: one that withholds more, or differently, or ships an empty body
 * under a declared label. Without it the reader is handed a fully
 * trust-labelled sentence with empty quotes where the finding should be, which
 * reads as "Nick looked and found nothing".
 */
const hasBody = (claim: HintClaimCandidate): boolean =>
  claim.body.trim().length > 0;

/**
 * A body is not yet substance: it must hold a SENTENCE WORTH SHOWING (the
 * shared cut, @crosscheck/schema substanceSentence — content words, not "1.",
 * "Yes." or a full stop behind invisible characters). Without one the claim
 * stays a pointer, so a substance hint never frames nothing and
 * `prompt_substance` is only ever booked for a finding that was shown
 * (review of batch 1006, finding 7).
 */
const hasSubstanceSentence = (claim: HintClaimCandidate): boolean =>
  substanceSentence(claim.body).length > 0;

/**
 * THE CODE AXIS OF THE SUBSTANCE GATE (1.0 spec 02 §5, CCB-1/CCB-7).
 *
 * The predicate itself lives in src/claim-validity.ts, because the briefing's
 * solved root-cause line asserts a claim body on exactly the same terms and
 * two renderers each deciding "still current" for themselves is the
 * two-silent-definitions defect spec 02 exists to prevent. Its header carries
 * the reasoning for both terms and for why `unknown` is let through.
 */
const isCodeCurrent = (claim: HintClaimCandidate): boolean =>
  isAssertableValidity(claim.validity);

/**
 * The asymmetry, in one predicate: provenance and evidence first, then kind or
 * status, then whether the code it is about has moved.
 *
 * `status !== "superseded"` STAYS beside the edge-derived term above, and §5
 * is wrong to call the latter its replacement. §3.5's "the edge is
 * authoritative" settles which definition DECIDES when the two disagree — the
 * hub derives `validity.state` from the edge and the status never enters that
 * derivation. But the hub ALREADY drops superseded rows from the candidate
 * list by edge (notSuperseded, packages/server/src/services/hints.ts), so
 * deleting this line changes nothing against an honest hub while removing a
 * defence against a forging one, which is the reason it was written. A hub
 * reporting `status: "superseded"` beside a `current` validity asserts two
 * contradictory things; the connector believes neither.
 */
const isInjectable = (claim: HintClaimCandidate): boolean =>
  isDeclared(claim) &&
  hasBody(claim) &&
  hasSubstanceSentence(claim) &&
  hasEvidence(claim) &&
  claim.status !== "superseded" &&
  isCodeCurrent(claim) &&
  (isSettledRootCause(claim) || isStatedDecision(claim));

/**
 * THE CONTENT FLOOR, LOOKED AT AGAIN. The hub keeps only candidates that
 * share HINT_MIN_SHARED_TERMS words on one of their statements, or hold a
 * target the query named (server/src/services/hints.ts); this is the second
 * lock, the shape every rule in this file has. A tree that shares one stray
 * word is never pointed at — not even after the strong tree beside it was
 * delivered (the batch-1006 review's probe F).
 *
 * A HUB TOO OLD TO REPORT THE NUMBER IS RECOUNTED HERE, BY THE HUB'S OWN RULE
 * (hold-out review H4; round 3, follow-up): it ranked on its normalized
 * document, drafts included, and floored nothing. The recount calls the very
 * function the hub counts with (`@crosscheck/schema` content-floor.ts) —
 * english lexemes, a closed word's inflection no topic (L1), three topical
 * words for a long prompt (M7) — on what the wire shows: each context's own
 * statement (the title and the intent's summary; an old hub sends no
 * description) and its pushable foreign claim bodies. A tree whose wire
 * carries no such body earns no hint at all.
 */
const clearsContentFloor = (context: HintContextCandidate, input: SelectHintInput, recount: FloorTerms): boolean =>
  context.workContext.tier === "exact" ||
  (context.sharedTerms === undefined
    ? recountsContentFloor(context, input.selfDeveloperId, recount)
    : context.sharedTerms >= HINT_MIN_SHARED_TERMS);

/** A context's own statement as the wire carries it: its title and its intent's summary. */
const wireStatementOf = (context: HintContextCandidate): string =>
  [context.workContext.title, context.workContext.intent?.summary ?? ""].filter((part) => part.length > 0).join(" ");

/**
 * The claim bodies the recount counts on: PUSHABLE, not merely declared
 * (round 3, M5: a refuted hypothesis is a declared claim, and its words
 * qualified a tree a pointer then named on an unrelated observation), and
 * foreign.
 */
const recountBodies = (context: HintContextCandidate, selfDeveloperId: string | null): readonly string[] =>
  context.claims
    .filter((claim) => isPushableClaim(claim) && claim.authorDeveloperId !== selfDeveloperId && claim.body.trim().length > 0)
    .map((claim) => claim.body);

/**
 * The floor terms against an old hub, under the one rule (`@crosscheck/schema`
 * floorTermsOf): counted on the prompt's ranked terms that some statement ON
 * THE WIRE says — a word no wire statement says cannot match one, so that
 * count is exact — while the long-prompt test takes every ranked word as one
 * the team may know. An old hub puts three trees on the wire, a fraction of
 * the repo the tip hub counts known words in; a 120-word status report
 * looked short through that keyhole and cleared on "usage", "shows" and
 * "wrong". Failing closed costs a long task its hint against an old hub when
 * it shares only two topical words with its tree.
 */
export const recountFloorTermsOf = (input: SelectHintInput): FloorTerms =>
  floorTermsOf(
    { topical: input.promptTopicalTerms },
    knownTermsIn(
      input.promptTerms,
      input.candidates.flatMap((context) => [wireStatementOf(context), ...recountBodies(context, input.selfDeveloperId)]),
    ),
    Math.min(input.promptTerms.length, HINT_MAX_EXAMINED_TERMS),
  );

/** THE RECOUNT'S FLOOR: one of the context's statements on the wire clears it, by the hub's own rule. */
export const clearsRecountedFloor = (context: HintContextCandidate, selfDeveloperId: string | null, floor: FloorTerms): boolean =>
  [wireStatementOf(context), ...recountBodies(context, selfDeveloperId)].some((statement) => clearsFloorOn(floor, statement));

const recountsContentFloor = (context: HintContextCandidate, selfDeveloperId: string | null, floor: FloorTerms): boolean =>
  recountBodies(context, selfDeveloperId).length > 0 && clearsRecountedFloor(context, selfDeveloperId, floor);

const isEligibleContext =
  (input: SelectHintInput, recount: FloorTerms) =>
  (context: HintContextCandidate): boolean =>
    context.workContext.tier !== undefined &&
    HINT_ELIGIBLE_TIERS.has(context.workContext.tier) &&
    clearsContentFloor(context, input, recount);

/**
 * A claim that may drive a PUSHED hint — the hub's own rule, applied again
 * for a hub that still ships the rows (server services/pushable-claims.ts):
 * declared, and not refuted — a `rejected_approach` is "rejected" by
 * definition and stays. A draft, discarded or not, is neither one of the
 * tree's claims here nor a reason to point at it (draft-nudge review).
 */
const isPushableClaim = (claim: HintClaimCandidate): boolean =>
  isDeclared(claim) && (claim.status !== "rejected" || claim.kind === "rejected_approach");

/** The context with only the claims the push path may see. */
const withPushableClaims = (context: HintContextCandidate): HintContextCandidate => ({
  ...context,
  claims: context.claims.filter(isPushableClaim),
});

/** Not the reader's own words, however the context they sit in matched. */
const isForeignClaim = (
  claim: HintClaimCandidate,
  selfDeveloperId: string,
): boolean => claim.authorDeveloperId !== selfDeveloperId;

/**
 * A context whose owner STATED what they are doing (trial finding #16): with
 * an intent, a context with no claims yet is still worth a pointer — the
 * "same topic, different files" case nothing else detects. The pointer
 * carries title + intent + id, no body, so the asymmetry is untouched.
 *
 * FOREIGN is part of the rule, not an accident of the data. Before intents
 * the pointer pass could only fire on a context with a foreign CLAIM
 * (isForeignClaim), which meant a candidate list that leaked the reader's own
 * context could not produce a pointer whatever the hub did. An intent-only
 * context has no claim to carry that check, so it is stated here: the hub
 * excludes the caller in the query (server/src/services/hints.ts) and this is
 * the second lock, the shape self-exclusion has everywhere else in this file.
 */
const isForeignIntentOnly = (
  context: HintContextCandidate,
  selfDeveloperId: string,
): boolean => {
  const intent = context.workContext.intent;
  if (intent === null || intent === undefined || intent.summary.length === 0) {
    return false;
  }
  return context.workContext.developerId !== selfDeveloperId;
};

/**
 * A context a pointer may still name: neither it nor any of its claims was
 * already shown. The pointer pass below and the flow's fallback for a
 * finding too long to show (flows/hint.ts) apply this one rule.
 */
export const isUnpointed = (
  context: HintContextCandidate,
  seen: ReadonlySet<string>,
): boolean =>
  !seen.has(context.workContext.id) &&
  !context.claims.some((claim) => seen.has(claim.id));

export const selectHint = (input: SelectHintInput): HintSelection => {
  if (input.deliveredCount >= MAX_HINTS_PER_SESSION) {
    return SILENCE;
  }
  // No identity, no hints — fail closed (§4 self-exclusion). With a null
  // selfDeveloperId every claim would count as foreign, INCLUDING one the
  // reader authored into a teammate's tree via extend_diagnosis before the
  // config lost its developerId; being hinted your own words is self-noise
  // (§10 risk 1), and silence is the direction every doubt resolves to.
  const selfDeveloperId = input.selfDeveloperId;
  if (selfDeveloperId === null) {
    return SILENCE;
  }
  const seen = new Set(input.seenRefIds);
  const recount = recountFloorTermsOf(input);
  const eligible = input.candidates.filter(isEligibleContext(input, recount)).map(withPushableClaims);
  // THE ONE STRONGEST TREE A POINTER COULD NAME, shown already or not (round
  // 3, H3 + M6; round 4, C2): substance comes only from it, a weaker tree is
  // never pointed at in its place — and a TIE at the top says nothing at all,
  // since the hub's order between equals is search rank, not relevance.
  const pointable = eligible.filter((context) => pointerAt(context, selfDeveloperId) !== null);
  const strongestIndex = strongestTreeIndex(pointable.map((context) => strengthOf(context, selfDeveloperId, recount)));
  const context = strongestIndex === null ? undefined : pointable[strongestIndex];
  if (context === undefined) {
    return SILENCE;
  }

  // Substance from that tree first: an evidence-backed claim beats a pointer
  // at its own tree — within it the claim sharing most topical words, each
  // strictly matched (C2).
  const claim = offeringOrder(context.claims.filter((member) => isForeignClaim(member, selfDeveloperId))).find(
    (member) => isDeliverable(member, context) && !seen.has(member.id),
  );
  if (claim !== undefined) {
    const foreign = context.claims.filter((member) => isForeignClaim(member, selfDeveloperId));
    // The rest are the tree's OTHER claims — the reader's own among them,
    // since get_diagnosis reads those too — what the hint's pointer line
    // says is one call away.
    return {
      kind: "claim",
      context,
      claim,
      restCount: context.claims.length - 1,
      isRestLowerBound: context.claimsTruncated === true,
      ifUnfit: isUnpointed(context, seen)
        ? { kind: "pointer", context, claimCount: foreign.length }
        : SILENCE,
    };
  }

  // Otherwise a pointer at the STRONGEST tree (H3 + M6), only if it is
  // unseen — never a weaker tree in its place. "Unseen" covers the context id
  // AND its claims: once substance from a context was delivered, re-surfacing
  // the same context as a pointer is noise, not news.
  return isUnpointed(context, seen) ? (pointerAt(context, selfDeveloperId) ?? SILENCE) : SILENCE;
};

type PointerSelection = Extract<HintSelection, { readonly kind: "pointer" }>;

/**
 * The pointer one context can carry, seen or not: one with foreign claims,
 * one the prompt named a file of (#19), or one whose owner stated an intent
 * (#16, the claimless "same topic, different files" case) — or none.
 */
const pointerAt = (context: HintContextCandidate, selfDeveloperId: string): PointerSelection | null => {
  const foreignCount = context.claims.filter((claim) => isForeignClaim(claim, selfDeveloperId)).length;
  if (foreignCount > 0) {
    return { kind: "pointer", context, claimCount: foreignCount };
  }
  // #19 targets-only pointer: the EXACT tier is a fact — the prompt named a
  // file this context targeted — so a body-less pointer at zero claims is
  // precise, not a guess. FTS-only stays silent: a lexical body match is too
  // loose to point on without a claim behind it (keep precision, §4).
  //
  // Self-exclusion is checked HERE too, not left to the hub. The claim
  // pointer above gets it free (own claims are never foreign, so
  // foreignCount stays 0); a targets-only pointer has no claim to derive it
  // from, and the reader's OWN earlier session is exactly what an exact path
  // match finds. The hub excludes the caller today, but §4 makes the
  // selector the second line of defence, and one self-pointer costs a
  // teammate's slot out of the five a session gets (§10 risk 1).
  if (context.workContext.tier === "exact" && context.workContext.developerId !== selfDeveloperId) {
    const target = context.matchedTargets.find((matched) => matched.kind === "file");
    if (target !== undefined) {
      return {
        kind: "pointer",
        context,
        claimCount: 0,
        matchedTarget: { value: target.value, createdAt: target.createdAt ?? null },
      };
    }
  }
  // #16 intent-only pointer, AFTER #19: a context can carry both an intent
  // and a file the prompt named, and the touched-file fact is the more
  // precise of the two — so the targets tail wins the tail slot and the
  // intent still rides along on its own line (hints/render.ts intentLines).
  // This fires where main was silent: any tier, no file target, but an owner
  // who said what they are doing.
  return isForeignIntentOnly(context, selfDeveloperId) ? { kind: "pointer", context, claimCount: 0 } : null;
};
