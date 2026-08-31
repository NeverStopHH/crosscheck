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
}

const SILENCE: HintSelection = { kind: "silence" };

const hasEvidence = (claim: HintClaimCandidate): boolean =>
  claim.evidenceRefCount >= HINT_MIN_EVIDENCE_REFS;

const isNegativeKnowledge = (claim: HintClaimCandidate): boolean =>
  claim.kind === "rejected_approach";

const isSettled = (claim: HintClaimCandidate): boolean =>
  INJECTABLE_STATUSES.has(claim.status);

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

/** The asymmetry, in one predicate: provenance and evidence first, then kind or status. */
const isInjectable = (claim: HintClaimCandidate): boolean =>
  isDeclared(claim) &&
  hasBody(claim) &&
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

  // Pointer pass: the best-ranked unseen context — one with foreign claims,
  // one the prompt named a file of (#19), or one whose owner stated an intent
  // (#16, the claimless "same topic, different files" case). "Unseen" covers
  // the context id AND its claims: once substance from a context was
  // delivered, re-surfacing the same context as a pointer is noise, not news.
  for (const context of eligible) {
    if (seen.has(context.workContext.id)) {
      continue;
    }
    if (context.claims.some((claim) => seen.has(claim.id))) {
      continue;
    }
    const foreignCount = context.claims.filter((claim) =>
      isForeignClaim(claim, selfDeveloperId),
    ).length;
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
    if (
      context.workContext.tier === "exact" &&
      context.workContext.developerId !== selfDeveloperId
    ) {
      const target = context.matchedTargets.find(
        (matched) => matched.kind === "file",
      );
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
    if (isForeignIntentOnly(context, selfDeveloperId)) {
      return { kind: "pointer", context, claimCount: 0 };
    }
  }
  return SILENCE;
};
