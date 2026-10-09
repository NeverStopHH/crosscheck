/**
 * What `crosscheck noise` and `crosscheck pin --ok` say back (1.0 spec 07
 * §3.2) — two of the pilot's three human gestures. The third, `crosscheck
 * pilot label` (§12), shows each intervention again and so quotes a title:
 * its lines are framed, in pilot-label-render.ts, not here.
 *
 * EVERY GESTURE GETS AN ANSWER. "Recorded", "you had already said that",
 * "nothing reached you", "name the one you mean", or the hub's own refusal:
 * a gesture that appears to do nothing is the fastest way to teach a team to
 * stop making it, and the whole proactive-precision figure rests on people
 * making it.
 *
 * IDS, CHANNEL WORDS, AGES AND THE HUB'S SENTENCE — nothing else. No title,
 * no intent, no teammate's name: the person typed this beside the session
 * that got the intervention and already knows what it said, and repeating a
 * teammate's prose here would put it on a surface that needs none. So the
 * surface is registered in the BARE class, and the corpus holds it there.
 */
import { formatAge } from "@crosscheck/connector-core/briefing/render.ts";
import {
  bareUntrusted,
  safeId,
  sanitizeUntrusted,
} from "@crosscheck/connector-core/briefing/sanitize.ts";
import { MAX_HUB_MESSAGE_CHARS } from "@crosscheck/connector-core/constants.ts";
import type { MarkCandidate } from "@crosscheck/connector-core/http/pilot.ts";
import type { HubFailureKind } from "@crosscheck/connector-core/http/client.ts";
import type { PilotMarkRefKind } from "@crosscheck/schema";

import { ALREADY_DRAFTED, NOT_YOURS_YET } from "./draft-lines.ts";
import { outcomeWord } from "./outcome-render.ts";

const INDENT = "  ";

/**
 * The two one-word label shortcuts (07 §12, second review M6) and the two
 * outcome commands that resolve a delivery the same way (07 §13), each
 * printed as itself.
 */
export type ShortcutCommand = "noise" | "helpful" | "followed" | "overrode";

/** What to type when this command cannot tell which delivery was meant. */
const nameItInstead = (command: ShortcutCommand): string =>
  `name what the hint printed instead, e.g. crosscheck ${command} wc_…`;

const ageOf = (iso: string, now: Date): string => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "at an unknown time" : `${formatAge(now.getTime() - ms)} ago`;
};

export const markRecordedLine = (
  refKind: PilotMarkRefKind,
  id: string,
  repeated: boolean,
  word: ShortcutCommand = "noise",
): string => {
  const shown = safeId(id);
  if (refKind === "pin") {
    return repeated
      ? `already recorded: you had said ${shown}'s check passed — it still counts once, however often it is said\n`
      : `recorded: you ran ${shown}'s check and watched it pass — the pin's notice is now falsifiable in both directions\n`;
  }
  // A REPEAT NAMES NO WORD: since 07 §12 the first label may have been
  // `helpful` or `unclear` from `crosscheck pilot label`, and the first one
  // stands — so "you had marked it noise" could be false.
  return repeated
    ? `already recorded: you had labelled ${shown} — a label counts once, and a second one changes nothing\n`
    : `recorded: ${shown} is ${word}. It counts once toward this repo's pilot figures, and it names nobody\n`;
};

/**
 * THE SAME GESTURES, ON A HUB THAT ONLY DRAFTS THEM (human provenance §5): a
 * label or a passed check typed with the key is a draft until the person
 * confirms it with their passkey — the line says so, and never "recorded".
 */
export const markDraftedLine = (
  refKind: PilotMarkRefKind,
  id: string,
  repeated: boolean,
  word: ShortcutCommand = "noise",
): string => {
  const shown = safeId(id);
  if (repeated) {
    return `already drafted: you had said that of ${shown} — ${ALREADY_DRAFTED}\n`;
  }
  return refKind === "pin"
    ? `drafted: you ran ${shown}'s check and watched it pass — ${NOT_YOURS_YET}\n`
    : `drafted: ${shown} is ${word} — ${NOT_YOURS_YET}; once it is, it counts once toward this repo's pilot figures, and it names nobody\n`;
};

/** The hub's answer to a label, as its line: drafted (a hub since 0.11) or recorded (one before). */
export const markAnswerLine = (
  refKind: PilotMarkRefKind,
  id: string,
  answer: { readonly repeated: boolean; readonly draft?: boolean | undefined },
  word: ShortcutCommand = "noise",
): string =>
  answer.draft === true
    ? markDraftedLine(refKind, id, answer.repeated, word)
    : markRecordedLine(refKind, id, answer.repeated, word);

/**
 * WHAT NOW STANDS (07 §13.11, review H2): a noise label said over an outcome —
 * fresh, or said again over a word recorded since — stands over it now, and
 * the person is told which word it stands over. Every other answer adds nothing.
 */
export const labelStandsLine = (result: {
  readonly stands?: string | null | undefined;
  readonly replaced?: string | null | undefined;
}): string =>
  result.stands === "noise" && typeof result.replaced === "string" && result.replaced !== "noise"
    ? `noise now stands over the earlier ${outcomeWord(result.replaced)}, which stays in the history\n`
    : "";

/**
 * MORE THAN ONE — LISTED, NEVER GUESSED. "The most recent" of several is a
 * guess, and a guessed mark is noise about noise.
 */
export const candidateListLines = (
  candidates: readonly MarkCandidate[],
  more: boolean,
  windowMinutes: number,
  now: Date,
  command: ShortcutCommand = "noise",
): string =>
  [
    `${String(candidates.length)}${more ? "+" : ""} interventions reached a live session here in the last ${String(windowMinutes)} minutes — name the one you mean`,
    ...candidates.map(
      (candidate) =>
        `${INDENT}crosscheck ${command} ${safeId(candidate.id)} · ${bareUntrusted(candidate.channel)} · points at ${safeId(candidate.refId)} · ${ageOf(candidate.deliveredAt, now)}`,
    ),
    ...(more ? [`${INDENT}(more were not listed — ${nameItInstead(command)})`] : []),
    "",
  ].join("\n");

export const noLiveSessionLine = (command: ShortcutCommand = "noise"): string =>
  `no live crosscheck session for this repo on this machine — ${nameItInstead(command)}\n`;

export const nothingRecentLine = (windowMinutes: number, command: ShortcutCommand = "noise"): string =>
  `nothing reached a live session here in the last ${String(windowMinutes)} minutes — ${nameItInstead(command)}\n`;

export const refNeverReachedLine = (ref: string): string =>
  `no pointer at ${safeId(ref)} reached you on this repo — check the id the hint printed\n`;

/**
 * The hub's refusal is ITS sentence and says what to do next; this prints it
 * bare and bounded. An unreachable hub is said as such: nothing was recorded,
 * and the person needs to know the gesture did not land.
 */
export const markFailureLine = (
  kind: HubFailureKind,
  message: string,
): string => {
  // Never sent (http/client.ts key-origin check): the client's own sentence
  // of two canonical origins, whole — the sanitizer would strip their `:`.
  if (kind === "refused") {
    return `${message} — nothing was recorded\n`;
  }
  return kind === "network"
    ? `hub unreachable: ${bareUntrusted(message, MAX_HUB_MESSAGE_CHARS)} — nothing was recorded\n`
    : `${hubSentence(message)}\n`;
};

/**
 * A HUB'S SENTENCE, PRINTED AS THE WHOLE LINE (round-6 LOW-5): the prose class — invisibles,
 * renderer-owned characters and instruction-shaped text go, bounded — and its ordinary punctuation
 * stays. The bare class strips "—", ":" and "·" because a FIELD inside a line must not mint another
 * field; a sentence that is the whole line has none to mint, and the strip ran its clauses together
 * ("nothing was recorded say it again"). An unreachable hub's error sits inside this CLI's own line,
 * so it stays bare.
 */
const hubSentence = (message: string): string => sanitizeUntrusted(message, MAX_HUB_MESSAGE_CHARS);
