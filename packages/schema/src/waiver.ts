import { z } from "zod";

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
 *
 * AND THE THIRD AUTHORITY, which is the one that can refuse a write nobody
 * validated: `bootstrap.sql` spells the bound as a SQL literal, because a
 * CHECK cannot import a TypeScript constant. `ddl-sync.test.ts` reddens on
 * drift; this states the agreement HERE, where the number is decided, so the
 * prose beside the constant cannot go stale while the test stays green on a
 * branch nobody ran:
 *
 * VERIFY: bun -e 'const w=await import("./packages/schema/src/waiver.ts");const sql=await Bun.file("./packages/server/src/db/bootstrap.sql").text();const m=/fence_waivers_reason_length_check CHECK \(char_length\(reason\) <= (\d+)\)/.exec(sql);console.log(m===null?"NO CHECK IN bootstrap.sql":String(Number(m[1])===w.MAX_WAIVER_REASON_CHARS))'
 * PRINTS: true
 */
export const MAX_WAIVER_REASON_CHARS = MAX_PIN_CHECK_CHARS;

export type WaiverKind = (typeof WAIVER_KINDS)[number];

/**
 * WHO OPENED A FENCE, as the hub recorded it (1.0 spec 04a §6).
 *
 * `terminal` — the pre-04a grant: an api key plus a body that said it saw a
 * controlling terminal. Any agent holding the key could send both, so it is
 * the WEAKER authority, and no new row of it can be written; the rows already
 * live run out on their own expiry (at most `MAX_WAIVER_DAYS`).
 *
 * `passkey` — a WebAuthn assertion with user verification, by a passkey of the
 * approving developer, over exactly the terms stored. The row names the
 * credential, so "which device said yes" survives a later revocation of it.
 */
export const WAIVER_AUTHORITIES = ["terminal", "passkey"] as const;

export type WaiverAuthority = (typeof WAIVER_AUTHORITIES)[number];

/**
 * WHAT AN AGENT — OR A PERSON AT A TERMINAL — SENDS TO ASK FOR A FENCE TO OPEN.
 *
 * A REQUEST, NOT A GRANT (04a §2). The api key that carries it is held by the
 * developer AND by every agent on their machine, so it can only ask; a person
 * approves with a passkey in the web UI, where the terms below are shown and
 * signed. Nothing about a human is asserted here, which is why the old
 * `presence: "controlling_terminal"` literal is gone: a field that proves
 * nothing to the hub would only read as if it did.
 */
export const WaiverRequestSchema = z.object({
  repo: z.string().min(1),
  pinId: z.string().min(1),
  /**
   * WHICH VERSION of the invariant is being waived (04 §3.5).
   *
   * REQUIRED, and it is the sender's statement of what they looked at. A
   * waiver that defaulted to "whatever the pin is now" would let a sweep
   * landing between reading and granting move the fence under the decision —
   * and an approval later signs this same version or nothing.
   */
  pinVersion: z.number().int().min(1),
  reason: z.string().min(1).max(MAX_WAIVER_REASON_CHARS),
  /** The expiry ASKED for; the approver may shorten it before signing. */
  expiresAt: z.iso.datetime(),
});

export type WaiverRequestInput = z.infer<typeof WaiverRequestSchema>;
