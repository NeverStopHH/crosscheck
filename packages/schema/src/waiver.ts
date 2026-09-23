import { MAX_PIN_CHECK_CHARS } from "./pin.ts";

/**
 * A FENCE WAIVER'S TWO KINDS (1.0 spec 04 §3.6).
 *
 * `grant` lifts a `PROTECTED_CONFLICT` for a bounded time; `revoke` takes that
 * back and names the grant it supersedes. ITS OWN MODULE rather than a corner
 * of `pin.ts`: a waiver is a decision ABOUT a pin, not a part of one, and the
 * two have different writers, different routes and different authority.
 *
 * APPEND-ONLY IN BOTH DIRECTIONS. Nothing updates a waiver row; withdrawal is a
 * second row naming the first — the `claims` pattern, where revision means a
 * NEW claim. A team that can only see the current permission has no account of
 * how it got there, and "who opened this fence and why" is the question this
 * record exists to answer months later.
 */
export const WAIVER_KINDS = ["grant", "revoke"] as const;

/**
 * How long a waiver's reason may be.
 *
 * REQUIRED ON A REVOKE TOO, which is the unusual half: it is easy to argue that
 * taking a permission back needs no justification, and that asymmetry is
 * exactly what makes a revocation read as an accusation. Both directions carry
 * a sentence, and both are AUTHOR-WRITTEN TEXT — one of only two untrusted
 * slots a verdict line may carry (04 §3.1), so every surface printing it frames
 * it, and `status` / `doctor` print counts and expiries instead.
 *
 * THE SAME 200 as `MAX_PIN_CHECK_CHARS`, `MAX_REFUSAL_CHARS` and
 * `MAX_HUB_MESSAGE_CHARS` — one human sentence about one thing. Derived from
 * the pin cap rather than repeated, so the two cannot drift into two different
 * answers to "how much may a person write here":
 *
 * VERIFY: bun -e 'const w=await import("./packages/schema/src/waiver.ts");const p=await import("./packages/schema/src/pin.ts");console.log(w.MAX_WAIVER_REASON_CHARS === p.MAX_PIN_CHECK_CHARS)'
 * PRINTS: true
 */
export const MAX_WAIVER_REASON_CHARS = MAX_PIN_CHECK_CHARS;

export type WaiverKind = (typeof WAIVER_KINDS)[number];
