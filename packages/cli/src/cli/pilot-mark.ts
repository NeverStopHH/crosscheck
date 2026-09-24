/**
 * What `crosscheck noise` and `crosscheck pin --ok` say back (1.0 spec 07
 * §3.2) — the pilot's two human gestures.
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
} from "@crosscheck/connector-core/briefing/sanitize.ts";
import { MAX_HUB_MESSAGE_CHARS } from "@crosscheck/connector-core/constants.ts";
import type { MarkCandidate } from "@crosscheck/connector-core/http/pilot.ts";
import type { PilotMarkRefKind } from "@crosscheck/schema";

const INDENT = "  ";

/** What to type when this command cannot tell which delivery was meant. */
const NAME_IT_INSTEAD =
  "name what the hint printed instead, e.g. crosscheck noise wc_…";

const ageOf = (iso: string, now: Date): string => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "at an unknown time" : `${formatAge(now.getTime() - ms)} ago`;
};

export const markRecordedLine = (
  refKind: PilotMarkRefKind,
  id: string,
  repeated: boolean,
): string => {
  const shown = safeId(id);
  if (refKind === "pin") {
    return repeated
      ? `already recorded: you had said ${shown}'s check passed — it still counts once, however often it is said\n`
      : `recorded: you ran ${shown}'s check and watched it pass — the pin's notice is now falsifiable in both directions\n`;
  }
  return repeated
    ? `already recorded: you had marked ${shown} off-target — it still counts once, however often it is said\n`
    : `recorded: ${shown} is off-target. It counts once toward this repo's noise figure, and it names nobody\n`;
};

/**
 * MORE THAN ONE — LISTED, NEVER GUESSED. "The most recent" of several is a
 * guess, and a guessed mark is noise about noise.
 */
export const candidateListLines = (
  candidates: readonly MarkCandidate[],
  more: boolean,
  windowMinutes: number,
  now: Date,
): string =>
  [
    `${String(candidates.length)}${more ? "+" : ""} interventions reached a live session here in the last ${String(windowMinutes)} minutes — name the one you mean`,
    ...candidates.map(
      (candidate) =>
        `${INDENT}crosscheck noise ${safeId(candidate.id)} · ${bareUntrusted(candidate.channel)} · points at ${safeId(candidate.refId)} · ${ageOf(candidate.deliveredAt, now)}`,
    ),
    ...(more ? [`${INDENT}(more were not listed — ${NAME_IT_INSTEAD})`] : []),
    "",
  ].join("\n");

export const noLiveSessionLine = (): string =>
  `no live crosscheck session for this repo on this machine — ${NAME_IT_INSTEAD}\n`;

export const nothingRecentLine = (windowMinutes: number): string =>
  `nothing reached a live session here in the last ${String(windowMinutes)} minutes — ${NAME_IT_INSTEAD}\n`;

export const refNeverReachedLine = (ref: string): string =>
  `no pointer at ${safeId(ref)} reached you on this repo — check the id the hint printed\n`;

/**
 * The hub's refusal is ITS sentence and says what to do next; this prints it
 * bare and bounded. An unreachable hub is said as such: nothing was recorded,
 * and the person needs to know the gesture did not land.
 */
export const markFailureLine = (
  kind: "network" | "http" | "malformed",
  message: string,
): string => {
  const said = bareUntrusted(message, MAX_HUB_MESSAGE_CHARS);
  return kind === "network"
    ? `hub unreachable: ${said} — nothing was recorded\n`
    : `${said}\n`;
};
