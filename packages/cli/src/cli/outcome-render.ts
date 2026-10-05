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
  if (recorded.replaced === null) {
    return "";
  }
  const earlier = recorded.replaced === "noise" ? "your earlier noise label" : `the earlier ${outcomeWord(recorded.replaced)}`;
  return `, superseding ${earlier} (kept in the history)`;
};

export const outcomeRecordedLine = (ref: string, recorded: RecordedOutcome): string => {
  const shown = safeId(ref);
  if (recorded.repeated) {
    const stands = standingWord(recorded.stands ?? recorded.outcome);
    return `already recorded: ${shown} stands at ${stands} — nothing was written a second time\n`;
  }
  return (
    `recorded: ${shown} — ${outcomeWord(recorded.outcome)}${supersededWords(recorded)}. It shows in full only in your own crosscheck pilot --mine; ` +
    "others see it only inside the team's totals for a whole past month, once at least 3 people recorded outcomes; " +
    "the teammate whose work it was sees how often it was followed in a whole past month, once at least 3 people recorded outcomes about it\n"
  );
};

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
