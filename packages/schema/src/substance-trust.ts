/**
 * WHAT A HINT MAY SHOW AS A TEAMMATE'S FINDING — the trust half of the
 * substance gate (DESIGN.md §4), here so the hub can WITHHOLD every other
 * body on the hint wire (hold-out review, M1). A connector older than the
 * substance rules — 0.10.0 inlines a rejected approach or a proposed root
 * cause — then has nothing to inline; the current connector's selector
 * applies the same rule again (connector-core hints/select.ts, pinned to
 * this one by hint-substance-trust-parity.test.ts) beside what only it can
 * judge: the match, and whether the code moved.
 *
 * Substance is a DECLARED claim, not superseded, of a substance shape — a
 * root cause whose status is settled, or a decision its author stated and
 * nobody took back — whose evidence RESOLVES (evidence-resolution.ts) and
 * whose body holds a sentence worth showing (substance-sentence.ts).
 */
import { substanceSentence } from "./substance-sentence.ts";

/** The statuses that settle a root cause enough to show it. */
export const SUBSTANCE_ROOT_CAUSE_STATUSES: ReadonlySet<string> = new Set(["likely_root_cause", "partially_confirmed"]);
export const SUBSTANCE_MIN_EVIDENCE_REFS = 1;

export interface SubstanceCandidate {
  readonly provenance: string;
  readonly kind: string;
  readonly status: string;
  readonly body: string;
  /** Refs that resolve to evidence — never the stored count. */
  readonly resolvedEvidenceRefs: number;
}

/** A settled root cause, or a decision still as its author stated it. */
export const isSubstanceShape = (kind: string, status: string): boolean =>
  (kind === "root_cause" && SUBSTANCE_ROOT_CAUSE_STATUSES.has(status)) || (kind === "decision" && status === "proposed");

/**
 * THE RELEVANCE HALF (hold-out review round 3, H3 + M6): how many words a
 * shown finding must share to be pushed unasked — the content floor's own
 * number, HINT_MIN_SHARED_TERMS on both sides of the wire.
 */
export const SUBSTANCE_MIN_MATCHED_TERMS = 2;

/**
 * Of those, how many no other candidate tree says (round 4, C2): a finding
 * whose every shared word the runner-up says too is about what both trees
 * share, not about this one.
 */
export const SUBSTANCE_MIN_DISTINCT_TERMS = 1;

/** Topical words the finding's tree's OWN statement must share: the tree is about the prompt (C2). */
export const SUBSTANCE_MIN_TREE_TERMS = 1;

/** What a claim's relevance is judged on, all counted in TOPICAL words. */
export interface SubstanceMatch {
  /** Topical query words the claim's SHOWN sentence shares. */
  readonly claimTerms: number;
  /** Of them, the words no other candidate tree says, on any of its statements (C2). */
  readonly distinctTerms: number;
  /** Topical query words its tree's own statement — title, description, intent — shares. */
  readonly treeTerms: number;
  /** The match is content identity: an error fingerprint the prompt carried. */
  readonly isContentIdentity: boolean;
}

/**
 * A STRONG MATCH, one rule for the hub's withholding and the connector's
 * selector: the claim shares SUBSTANCE_MIN_MATCHED_TERMS topical words,
 * SUBSTANCE_MIN_DISTINCT_TERMS of which no other candidate tree says, and
 * its tree's own statement shares SUBSTANCE_MIN_TREE_TERMS — or the match is
 * an error fingerprint, content identity, which needs no words. Closed-class
 * words never count (round 3, C1): "token", "minute" and "rate" beside one
 * "key" made a rate-limit decision a strong match for "token refresh fails
 * after key rotation" — wrong-tree substance in 12 of 119 hold-out tasks.
 *
 * STRICT (round 4, C2): the round-4 hold-out still showed 9 of 182 tasks a
 * finding from another tree — "invoice pdf timeout" the PDF-labels tree's
 * cause, on the two words the timeout tree's title says too. One shared word
 * beside a strong tree no longer makes a finding strong, and a word every
 * candidate says tells the trees apart no better than none. The tree must
 * also be the ONE strongest candidate (hints/select.ts and the hub's
 * withholding judge that across candidates).
 */
export const isStrongSubstanceMatch = (match: SubstanceMatch): boolean =>
  (match.claimTerms >= SUBSTANCE_MIN_MATCHED_TERMS &&
    match.distinctTerms >= SUBSTANCE_MIN_DISTINCT_TERMS &&
    match.treeTerms >= SUBSTANCE_MIN_TREE_TERMS) ||
  match.isContentIdentity;

/**
 * A TREE'S STRENGTH (round 3, H3 + M6): an exact target first — the prompt
 * named something the tree touched, a fact — then the most topical query
 * words one of its statements shares, then (round 4, M1) the topical words
 * its OWN statement shares: of two trees a claim each ties on, the one whose
 * title and intent say the prompt is the one about it. Since M1 counts a
 * task's meta words, "Retry-Limit im Checkout erhöhen" shares two words with
 * four trees, and only the checkout-retries tree's title says both. Last
 * (round 4, decision 3) the most query words one statement shares, a weak
 * word among them: a weak word is never the topical one, but of two trees
 * equal on every topical count, the one that also says "times" in "invoice
 * rendering times out" says more of the prompt.
 */
export interface TreeStrength {
  readonly isExact: boolean;
  readonly topical: number;
  readonly own: number;
  readonly shared: number;
}

/** Stronger first: negative when `left` is the stronger tree, zero on a tie. */
export const compareTreeStrength = (left: TreeStrength, right: TreeStrength): number =>
  Number(right.isExact) - Number(left.isExact) || right.topical - left.topical || right.own - left.own || right.shared - left.shared;

export const isAtLeastAsStrongTree = (strength: TreeStrength, than: TreeStrength): boolean =>
  compareTreeStrength(strength, than) <= 0;

/**
 * THE ONE STRONGEST TREE, or none (round 4, C2): the index of the tree no
 * other is as strong as, or null for no trees or a TIE at the top. A tie says
 * nothing — no finding and no pointer: "invoice pdf timeout" shares invoice
 * and pdf with the timeout tree's title and with the labels tree's title
 * alike, and the hub's order between them is search rank, not relevance.
 * The hub's withholding and the connector's selector call this one rule.
 */
export const strongestTreeIndex = (strengths: readonly TreeStrength[]): number | null => {
  const best = strengths.reduce<number | null>(
    (bestIndex, strength, index) =>
      bestIndex === null || !isAtLeastAsStrongTree(strengths[bestIndex] ?? strength, strength) ? index : bestIndex,
    null,
  );
  const top = best === null ? undefined : strengths[best];
  return top !== undefined && strengths.filter((strength) => isAtLeastAsStrongTree(strength, top)).length === 1 ? best : null;
};

export const qualifiesAsSubstance = (claim: SubstanceCandidate): boolean =>
  claim.provenance === "declared" &&
  claim.status !== "superseded" &&
  isSubstanceShape(claim.kind, claim.status) &&
  claim.resolvedEvidenceRefs >= SUBSTANCE_MIN_EVIDENCE_REFS &&
  substanceSentence(claim.body).length > 0;
