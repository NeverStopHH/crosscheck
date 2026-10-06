/**
 * What `crosscheck followed` and `crosscheck overrode` say back (1.0 spec 07
 * §13).
 *
 * IDS, OUTCOME WORDS AND THE HUB'S SENTENCE — nothing else, and never the
 * reason: the person just typed it. So the surface is BARE, like the label
 * shortcuts' (pilot-mark.ts), whose candidate list and failure lines these
 * commands share.
 *
 * EVERY GESTURE GETS AN ANSWER, including the one an older hub forces:
 * "this hub does not record outcomes" is a sentence, never a bare 404.
 */
import { bareUntrusted, safeId } from "@crosscheck/connector-core/briefing/sanitize.ts";
import type { RecordedOutcome } from "@crosscheck/connector-core/http/hint-outcomes.ts";
import type { HeldWhy } from "@crosscheck/connector-core/spool/held-deliveries.ts";
import { MAX_HINT_OUTCOME_REASON_CHARS } from "@crosscheck/schema";

/** The stored word as a person reads it; a word this client does not know prints as itself. */
const OUTCOME_WORDS: Readonly<Record<string, string>> = {
  followed: "followed",
  overrode: "overrode",
  not_relevant_now: "not relevant now",
};

export const outcomeWord = (outcome: string): string => OUTCOME_WORDS[outcome] ?? bareUntrusted(outcome);

/** A closed month by name — "July 2026" — or "an unknown month" for a start this client cannot read. */
export const monthOf = (iso: string): string => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms)
    ? "an unknown month"
    : new Date(ms).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
};

/** What a delivery stood or stands at, as a person reads it: the noise label is theirs. */
const standingWord = (word: string): string => (word === "noise" ? "your noise label" : outcomeWord(word));

/**
 * What the new word did to what stood before (review #11): superseded it —
 * an outcome, or the person's noise label — or, on a tie with the label,
 * nothing, and the label still stands.
 */
const supersededWords = (recorded: RecordedOutcome): string => {
  const stands = recorded.stands ?? recorded.outcome;
  if (stands !== recorded.outcome) {
    return `, but ${standingWord(stands)} from the same instant still stands (a label wins a tie)`;
  }
  // survivor R19: the same word, said better — not a word superseding itself
  if (recorded.reasonRevised === true) {
    return ", the reason revised (the earlier one kept in the history)";
  }
  if (recorded.replaced === null) {
    return "";
  }
  const earlier = recorded.replaced === "noise" ? "your earlier noise label" : `the earlier ${outcomeWord(recorded.replaced)}`;
  return `, superseding ${earlier} (kept in the history)`;
};

export const outcomeRecordedLine = (ref: string, recorded: RecordedOutcome): string => {
  const shown = safeId(ref);
  if (recorded.repeated) {
    const stands = recorded.stands ?? recorded.outcome;
    // 07 §13.11 (H2): the word said again may be the one the person's label superseded.
    return stands === recorded.outcome
      ? `already recorded: ${shown} stands at ${standingWord(stands)} — nothing was written a second time\n`
      : `already recorded: ${shown} — ${outcomeWord(recorded.outcome)} was said before, and ${standingWord(stands)}, made since, stands over it; nothing was written a second time\n`;
  }
  return (
    `recorded: ${shown} — ${outcomeWord(recorded.outcome)}${supersededWords(recorded)}. It shows in full only in your own crosscheck pilot --mine; ` +
    "others see it only inside totals for a whole past month — the team report's, and the teammate's count of how often their work was followed — " +
    "each shown only if, leaving out any one person's words, words from at least 3 people remain, so never in a team of three\n"
  );
};

export const DELIVERY_HELD_AMBIGUOUS_LINE =
  "that hint reached you, but its delivery is still on this machine and several crosscheck sessions are live in this checkout, so it was not sent in a guessed one's name; nothing was recorded — the session holding it sends it after its next tool call, so run this again then\n";

/** With no live session here nothing can send it now; a session starting on the repo does (07 §13.11). */
export const DELIVERY_HELD_NO_LIVE_SESSION_LINE =
  "that hint reached you, but its delivery is still on this machine and no crosscheck session is live here to send it; nothing was recorded — it is sent when a session on this repo next starts, so run this again then\n";

export const DELIVERY_STILL_ON_THIS_MACHINE_LINE =
  "that hint reached you, but its delivery is still on this machine — it is sent after the session's next tool call, and it could not be sent just now; nothing was recorded, so run this again after that\n";

export const OUTCOMES_NOT_SERVED_LINE =
  "this hub does not record hint outcomes — it predates them, so nothing was recorded; upgrade the hub to use crosscheck followed / overrode\n";

export const REASON_REQUIRED_LINE =
  'an override needs its reason: crosscheck overrode wc_… --reason "why your way was better" — nothing was recorded\n';

export const REASON_SECRET_LINE =
  "the reason looks like it holds a secret (a key, a token, a password), so nothing was sent — say it again without it\n";

export const reasonTooLongLine = (length: number): string =>
  `that reason is ${String(length)} characters; an outcome takes one sentence of at most ${String(MAX_HINT_OUTCOME_REASON_CHARS)} — nothing was sent\n`;

/** What is true of a delivery still held here, by why (07 §13.11): never "it never reached you". */
export const heldLine = (why: HeldWhy): string => {
  if (why === "ambiguous") {
    return DELIVERY_HELD_AMBIGUOUS_LINE;
  }
  return why === "no_live_session" ? DELIVERY_HELD_NO_LIVE_SESSION_LINE : DELIVERY_STILL_ON_THIS_MACHINE_LINE;
};
