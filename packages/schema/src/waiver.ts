import { z } from "zod";

import { MAX_PIN_CHECK_CHARS, PIN_PRESENCE_TERMINAL } from "./pin.ts";

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

/**
 * WHAT A PERSON SENDS TO OPEN A FENCE.
 *
 * `presence` IS EVIDENCE, NOT A VERDICT — #50's pin rule, copied with its
 * stated limit. The client says what it OBSERVED (a controlling terminal); the
 * hub stamps the stored `capture_mode` itself. A body that could say "human"
 * would be a caller asserting something about itself that only the hub may
 * decide, and here that assertion would be a PERMISSION.
 *
 * The literal makes the gate fail CLOSED: an absent or unknown value is a parse
 * failure, never a default.
 *
 * WHAT THE GATE IS WORTH, stated rather than implied. A bearer key that can
 * reach the route can also send this field, and that key sits in plaintext in
 * `~/.crosscheck/config.json`. This makes the claim explicit, required and
 * refusable AT THE HUB; it does not make it unforgeable by an attacker who
 * already holds the key. That is why every waiver row names who granted it —
 * a forged permission is at least an attributable one.
 */
export const WaiverGrantSchema = z.object({
  repo: z.string().min(1),
  pinId: z.string().min(1),
  /**
   * WHICH VERSION of the invariant is being waived (04 §3.5).
   *
   * REQUIRED, and it is the sender's statement of what they looked at. A
   * waiver that defaulted to "whatever the pin is now" would let a sweep
   * landing between reading and granting move the fence under the decision.
   */
  pinVersion: z.number().int().min(1),
  reason: z.string().min(1).max(MAX_WAIVER_REASON_CHARS),
  expiresAt: z.iso.datetime(),
  presence: z.literal(PIN_PRESENCE_TERMINAL),
});

/**
 * WHAT A PERSON SENDS TO CLOSE ONE AGAIN.
 *
 * A REASON IS REQUIRED HERE TOO. It is easy to argue that taking a permission
 * back needs no justification, and that asymmetry is exactly what makes a
 * revocation read as an accusation. The grant being superseded comes from the
 * path, not the body: a revoke names one row, and letting the body choose it
 * would allow closing a fence the sender never looked at.
 */
export const WaiverRevokeSchema = z.object({
  repo: z.string().min(1),
  reason: z.string().min(1).max(MAX_WAIVER_REASON_CHARS),
  presence: z.literal(PIN_PRESENCE_TERMINAL),
});

export type WaiverGrant = z.infer<typeof WaiverGrantSchema>;
export type WaiverRevoke = z.infer<typeof WaiverRevokeSchema>;
