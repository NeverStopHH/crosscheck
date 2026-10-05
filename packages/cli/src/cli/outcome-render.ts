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

export const outcomeRecordedLine = (ref: string, recorded: RecordedOutcome): string => {
  const shown = safeId(ref);
  const word = outcomeWord(recorded.outcome);
  if (recorded.repeated) {
    return `already recorded: ${shown} stands at ${word} — nothing was written a second time\n`;
  }
  const replaced =
    recorded.replaced === null
      ? ""
      : `, superseding the earlier ${outcomeWord(recorded.replaced)} (kept in the history)`;
  return (
    `recorded: ${shown} — ${word}${replaced}. It shows in full only in your own crosscheck pilot --mine; ` +
    "others see it only inside the team's totals for a whole past month, once at least 3 people recorded outcomes; " +
    "the teammate whose work it was sees how often their work was followed\n"
  );
};

export const OUTCOMES_NOT_SERVED_LINE =
  "this hub does not record hint outcomes — it predates them, so nothing was recorded; upgrade the hub to use crosscheck followed / overrode\n";

export const REASON_REQUIRED_LINE =
  'an override needs its reason: crosscheck overrode wc_… --reason "why your way was better" — nothing was recorded\n';

export const REASON_SECRET_LINE =
  "the reason looks like it holds a secret (a key, a token, a password), so nothing was sent — say it again without it\n";

export const reasonTooLongLine = (length: number): string =>
  `that reason is ${String(length)} characters; an outcome takes one sentence of at most ${String(MAX_HINT_OUTCOME_REASON_CHARS)} — nothing was sent\n`;
