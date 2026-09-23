/**
 * IS A CLAIM STILL CURRENT ENOUGH TO ASSERT? (1.0 spec 02 §5.)
 *
 * ONE PREDICATE, TWO SURFACES, AND THAT IS THE WHOLE REASON THIS FILE EXISTS.
 * `claim-hint` (hints/select.ts) and the briefing's solved root cause
 * (briefing/render.ts) both take a teammate's claim BODY and put it in front
 * of a reader who did not ask for it. They are the unsolicited substance lane,
 * and a claim that has stopped being a current statement about the code may
 * not travel it.
 *
 * Written once because the alternative is the defect spec 02 exists to
 * prevent, one level down: two renderers each deciding "still current" for
 * themselves is two silent definitions, and the day they disagree a root
 * cause is refused on one surface and asserted on the other.
 *
 * NOT A RENDERER. It prints nothing and touches no sanitizer, so it is not
 * render-layer and needs no registration; the VOCABULARY that turns a state
 * into a sentence lives in briefing/render.ts with the rest of the words.
 *
 * NOT THE HUB'S `isCurrent` EITHER, and the difference is deliberate. The hub
 * asks "was this measured current?" (services/claim-validity.ts), where
 * `unknown` is not current. This asks "may this be ASSERTED unasked?", where
 * `unknown` is allowed through: a claim nobody has revalidated is not a claim
 * somebody checked and found wrong, and refusing everything unmeasured would
 * silence a whole hub on the day this shipped.
 */
import type { ClaimValidity } from "@crosscheck/schema";

/**
 * The states that have stopped being a CURRENT statement about the code
 * (1.0 spec 02 §5, D3's default).
 *
 * `unknown` is deliberately absent — see the header.
 *
 * `invalidated` IS PRESENT, and §5's set is taken verbatim — but only because
 * the DERIVATION behind the word was narrowed first. Read as §3.5's table
 * first wrote it (`status === "rejected"`, whatever the kind), the word would
 * fire on every evidence-backed `rejected_approach` — the one category
 * DESIGN.md §4 privileges above all others, whose demotion hands the reader
 * the settled POSITIVE in its place. The fix belongs where the word is
 * minted, and it is there: the hub derives `invalidated` only for kinds whose
 * `rejected` status is a RETRACTION (server services/claim-validity.ts).
 *
 * So what this set refuses is a claim THE HUB calls invalidated, whatever
 * kind it carries. An older hub, or a forging one, that hands that label to a
 * rejected approach keeps it out of the substance lane rather than in it —
 * the same direction every other term here fails.
 */
export const NON_CURRENT_VALIDITY_STATES: ReadonlySet<string> = new Set([
  "stale",
  "invalidated",
  "superseded",
]);

/**
 * May this claim's BODY be asserted to a reader who did not ask for it?
 *
 * Two terms, both failing closed toward the pointer lane:
 *
 *   1. `commitBinding !== "none"` — a claim whose observation point is
 *      unknown may not be presented as current at all. Non-negotiable #3 on
 *      the code axis: unknown provenance fails CLOSED. (CCB-1.)
 *   2. `state ∉ NON_CURRENT_VALIDITY_STATES` — the hub's one authoritative
 *      verdict (server/src/services/claim-validity.ts), edge-derived for
 *      `superseded` and revalidation-derived for `stale`. (CCB-7.)
 *
 * ABSENT MEANS "THE HUB DID NOT ANSWER", NOT "REFUSE". A hub too old to send
 * the field keeps its team's claims in the substance lane; the alternative is
 * one connector upgrade silencing a whole hub, and `unknown` is injectable
 * anyway, so the two cases land in the same place. The residue is real and
 * doctor names it out loud rather than leaving a reader to notice.
 *
 * REFUSING IS NOT SILENCING. Every caller keeps the pointer — the hint's
 * count, the briefing's `get_diagnosis <id>` — so the claim stays readable
 * with its full clause on the surface a reader pulled. One rung down the
 * SUBSTANCE / POINTER / SILENCE ladder, never out.
 */
export const isAssertableValidity = (
  validity: ClaimValidity | null | undefined,
): boolean => {
  if (validity === null || validity === undefined) {
    return true;
  }
  return (
    validity.commitBinding !== "none" &&
    !NON_CURRENT_VALIDITY_STATES.has(validity.state)
  );
};
