/**
 * WHAT A GESTURE SAYS WHEN THE HUB ONLY DRAFTED IT (human provenance §5–§8).
 *
 * A hub since 0.11 answers `draft: true` from every door a key reaches for a
 * label, a rating, a pin, a break, a mute, an unmute or presence-on: nothing
 * counts, protects or changes until the person confirms it with their passkey
 * on the hub's own page. So no such gesture may read as done — each of these
 * lines says it is a draft and how it becomes the person's.
 *
 * An older hub answers without `draft`, and applied the word at once: its
 * lines stay as they were, beside these.
 *
 * Fixed words only: no hub text, no title, no teammate's prose.
 */

/** How a draft becomes the person's — the clause every drafted line ends with. */
export const CONFIRM_CLAUSE = "confirm it with your passkey — crosscheck confirm opens the page";

/** A judgement (a label, a rating, a check that passed): it counts for nothing yet. */
export const NOT_YOURS_YET = `it is not yours yet: it counts only once you ${CONFIRM_CLAUSE}`;

/** A pin or a break: until it is confirmed it protects nothing — no fence, no suspect. */
export const PROTECTS_NOTHING_YET = `it protects nothing yet — no fence, no suspect — until you ${CONFIRM_CLAUSE}`;

/** A setting (a mute, an unmute, presence on): it has not changed. */
export const UNCHANGED_UNTIL_CONFIRMED = `nothing changed yet: it takes effect only once you ${CONFIRM_CLAUSE}`;

/** The same saying drafted before: nothing new waits, and whether the old one still does is on the page. */
export const ALREADY_DRAFTED =
  "nothing was written a second time — crosscheck confirm shows whether it still waits for your passkey";
