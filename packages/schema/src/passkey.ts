/**
 * THE PASSKEY VOCABULARY (1.0 spec 04a §4) — the words the hub, the database
 * and the clients must agree on, in one module so they cannot drift.
 */

/**
 * A passkey's name, as its owner typed it at enrolment ("MacBook Touch ID").
 *
 * It is printed beside every enrolment announcement, so it is author-written
 * text on a surface other people read: one short label, bounded at the wire
 * and again by the database CHECK in `bootstrap.sql`.
 */
export const MAX_PASSKEY_LABEL_CHARS = 60;

/**
 * Who closed a passkey (04a §4.4): its `owner` during the cool-off (signed in
 * with the api key — making a credential LESS capable needs no stronger
 * authority), the `admin` token at any time, or a `passkey` assertion of the
 * same developer after the cool-off.
 */
export const PASSKEY_REVOKERS = ["owner", "admin", "passkey"] as const;

export type PasskeyRevoker = (typeof PASSKEY_REVOKERS)[number];

/**
 * Where an enrolment's permission came from (04a §4.1–4.2): a code the
 * `admin` minted and handed over out of band, or an assertion by an existing
 * `passkey` of the same developer. The api key alone is neither.
 */
export const ENROLMENT_SOURCES = ["admin", "passkey"] as const;

export type EnrolmentSource = (typeof ENROLMENT_SOURCES)[number];
