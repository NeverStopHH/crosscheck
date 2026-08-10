/**
 * The hint selector — where the anchoring asymmetry is STRUCTURE, not wording
 * (DESIGN.md §4, normative).
 *
 * Proactively injectable substance is exactly:
 *   (a) a rejected_approach claim WITH evidence — negative knowledge cannot
 *       anchor a wrong theory, only save a dead end; and
 *   (b) a likely_root_cause / partially_confirmed claim WITH evidence.
 * Everything else — bare proposed hypotheses above all — reaches the reader
 * only as a POINTER: context id + title, no body. The pointer variant of the
 * return type carries no claim at all, so a body cannot leak through it by
 * construction; test/hint-select.test.ts pins every branch and
 * scripts/mutation-check.ts re-breaks the load-bearing ones.
 *
 * ONE selection per call, never a list — that is MAX_HINTS_PER_PROMPT enforced
 * by the return type. Below the precision floor (no proven lexical tier), or
 * past the session cap, or with nothing unseen: SILENCE. No hint is strictly
 * better than a weak one (§10 risk 1).
 */
import {
  HINT_MIN_EVIDENCE_REFS,
  MAX_HINTS_PER_SESSION,
} from "../constants.ts";
import type { HintClaimCandidate, HintContextCandidate } from "../http/hub.ts";

/**
 * Tiers where the prompt provably matched — recency/vector filler never hints.
 * The hub applies the same floor server-side (HINT_ELIGIBLE_TIERS in
 * packages/server/src/services/hints.ts); the two literals sit on opposite
 * sides of an HTTP boundary where an import cannot reach, so their equality
 * is pinned rather than assumed — silent drift would move the floor to
 * whichever side is looser:
 *
 * VERIFY: grep -c '\["exact", "fts"\]' packages/connector-claude/src/hints/select.ts packages/server/src/services/hints.ts
 * PRINTS: packages/connector-claude/src/hints/select.ts:1
 * PRINTS: packages/server/src/services/hints.ts:1
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
    }
  | {
      readonly kind: "pointer";
      readonly context: HintContextCandidate;
      /** How many claims the pointer withholds — a count, never a body. */
      readonly claimCount: number;
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
}

const SILENCE: HintSelection = { kind: "silence" };

const hasEvidence = (claim: HintClaimCandidate): boolean =>
  claim.evidenceRefCount >= HINT_MIN_EVIDENCE_REFS;

const isNegativeKnowledge = (claim: HintClaimCandidate): boolean =>
  claim.kind === "rejected_approach";

const isSettled = (claim: HintClaimCandidate): boolean =>
  INJECTABLE_STATUSES.has(claim.status);

/** The asymmetry, in one predicate: evidence first, then kind or status. */
const isInjectable = (claim: HintClaimCandidate): boolean =>
  hasEvidence(claim) &&
  claim.status !== "superseded" &&
  (isNegativeKnowledge(claim) || isSettled(claim));

const isEligibleContext = (context: HintContextCandidate): boolean =>
  context.workContext.tier !== undefined &&
  HINT_ELIGIBLE_TIERS.has(context.workContext.tier);

/** Not the reader's own words, however the context they sit in matched. */
const isForeignClaim = (
  claim: HintClaimCandidate,
  selfDeveloperId: string,
): boolean => claim.authorDeveloperId !== selfDeveloperId;

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
  const eligible = input.candidates.filter(isEligibleContext);

  // Substance pass over ALL eligible contexts first: an evidence-backed claim
  // in the second-ranked context beats a pointer at the first-ranked one.
  for (const context of eligible) {
    // Negatives are privileged (§4): scan rejected approaches before settled
    // positives within a context, in the hub's claim order otherwise.
    const foreign = context.claims.filter((claim) =>
      isForeignClaim(claim, selfDeveloperId),
    );
    const injectable = [
      ...foreign.filter(isNegativeKnowledge),
      ...foreign.filter((claim) => !isNegativeKnowledge(claim)),
    ].find((claim) => isInjectable(claim) && !seen.has(claim.id));
    if (injectable !== undefined) {
      return { kind: "claim", context, claim: injectable };
    }
  }

  // Pointer pass: the best-ranked unseen context that has any foreign claims.
  // "Unseen" covers the context id AND its claims: once substance from a
  // context was delivered, re-surfacing the same context as a pointer is
  // noise, not news.
  for (const context of eligible) {
    const foreignCount = context.claims.filter((claim) =>
      isForeignClaim(claim, selfDeveloperId),
    ).length;
    const anyClaimSeen = context.claims.some((claim) => seen.has(claim.id));
    if (foreignCount > 0 && !seen.has(context.workContext.id) && !anyClaimSeen) {
      return { kind: "pointer", context, claimCount: foreignCount };
    }
  }
  return SILENCE;
};
