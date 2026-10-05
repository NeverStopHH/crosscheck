/**
 * What `crosscheck pilot label` says (1.0 spec 07 §12) — every sentence of
 * the walk, in one module, so the corpus can attack all of them at once.
 *
 * FRAMED, unlike `noise`'s bare lines, and for the reason the report is: a
 * walk happens AFTER the session, when the person no longer has the hint in
 * front of them, so each intervention is shown again — WHAT was shown (the
 * work context a pointer named, a teammate's title, quoted as data), WHEN
 * (an age the renderer builds) and on WHICH CHANNEL (a word this module
 * chooses for each known channel; an unknown one prints bare). The notice
 * is in the walk's header, once.
 *
 * EVERY KEY GETS AN ANSWER — recorded, already labelled, skipped, the hub's
 * refusal, or "press one of these" — because a gesture that appears to do
 * nothing is one a team stops making, and the labelled figures rest on
 * people making it.
 */
import { QUOTED_DATA_NOTICE, formatAge } from "@crosscheck/connector-core/briefing/render.ts";
import { bareUntrusted, safeId } from "@crosscheck/connector-core/briefing/sanitize.ts";
import {
  MAX_HUB_MESSAGE_CHARS,
  MAX_WORK_CONTEXT_TITLE_CHARS,
} from "@crosscheck/connector-core/constants.ts";
import { quoted } from "@crosscheck/connector-core/mcp/render.ts";
import type { UnlabeledIntervention } from "@crosscheck/connector-core/http/pilot.ts";
import { MAX_PILOT_LABEL_REASON_CHARS } from "@crosscheck/schema";
import type { DeliveryChannel } from "@crosscheck/schema";

const INDENT = "  ";
const MINUTES_PER_HOUR = 60;

/** What the walk counted, item by item. `notReached` is what a stop left. */
export interface WalkTally {
  readonly total: number;
  readonly helpful: number;
  readonly noise: number;
  readonly unclear: number;
  readonly skipped: number;
  /** Labelled elsewhere while the walk waited: the first label stands. */
  readonly already: number;
  /** Refused by the hub, with its sentence printed at the item. */
  readonly refused: number;
  readonly notReached: number;
}

/** The channel as a person would name it; the hub's own word when this client has none. */
const CHANNEL_WORD: Readonly<Record<DeliveryChannel, string>> = {
  briefing: "session briefing",
  prompt_hint: "mid-prompt hint",
  tripwire: "tripwire ask before an edit",
  suspect: "suspect answer",
  unknown: "channel not recorded",
};

const channelWord = (channel: string): string =>
  Object.hasOwn(CHANNEL_WORD, channel)
    ? CHANNEL_WORD[channel as DeliveryChannel]
    : bareUntrusted(channel);

const windowWords = (minutes: number): string => {
  if (minutes % MINUTES_PER_HOUR !== 0) {
    return `${String(minutes)} minutes`;
  }
  const hours = minutes / MINUTES_PER_HOUR;
  return hours === 1 ? "hour" : `${String(hours)} hours`;
};

const ageOf = (iso: string, now: Date): string => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "at an unknown time" : `${formatAge(now.getTime() - ms)} ago`;
};

/** How many, how far back, which keys — and the notice that frames every title below. */
export const walkHeaderLines = (count: number, more: boolean, windowMinutes: number): string => {
  const one = count === 1 && !more;
  const cut = more ? ` — this run walks the newest ${String(count)}, the rest wait for the next` : "";
  return [
    `${String(count)}${more ? "+" : ""} intervention${one ? "" : "s"} reached you on this repo in the last ${windowWords(windowMinutes)} and ${one ? "is" : "are"} not labelled yet${cut}`,
    "one key each: h helpful · n noise · u unclear · s skip · q stop — Shift (H, N, U) adds a one-sentence reason",
    QUOTED_DATA_NOTICE,
    "",
  ].join("\n");
};

/** One intervention as it was shown: channel, age, and the work it pointed at. */
export const interventionLine = (
  candidate: UnlabeledIntervention,
  index: number,
  total: number,
  now: Date,
): string => {
  const named =
    candidate.title === null
      ? `${safeId(candidate.refId)} (no title on this repo's record)`
      : `${safeId(candidate.refId)} ${quoted(candidate.title, MAX_WORK_CONTEXT_TITLE_CHARS)}`;
  return `\n[${String(index + 1)}/${String(total)}] ${channelWord(candidate.channel)} · ${ageOf(candidate.deliveredAt, now)} · pointed at ${named}\n`;
};

export const keyPromptLine = (): string => `${INDENT}h/n/u/s/q › `;

/** The decision, echoed: raw mode prints no key, so the walk says what it heard. */
export const decisionEchoLine = (word: "helpful" | "noise" | "unclear" | "skip" | "stop"): string =>
  `${word}\n`;

export const unknownKeyLine = (): string =>
  `\n${INDENT}press h, n, u, s or q — Shift adds a reason\n`;

export const reasonPromptLine = (): string => `${INDENT}reason, one sentence (Enter for none) › `;

export const reasonTooLongLine = (length: number): string =>
  `${INDENT}a reason is one sentence of at most ${String(MAX_PILOT_LABEL_REASON_CHARS)} characters, and that one has ${String(length)} — type it shorter, or press Enter for none\n`;

export const reasonSecretLine = (): string =>
  `${INDENT}that looks like it holds a secret (a key, a token, a password), so it was not sent — type it again without it, or press Enter for none\n`;

export const labelRecordedLine = (
  label: "helpful" | "noise" | "unclear",
  withReason: boolean,
  repeated: boolean,
): string =>
  repeated
    ? `${INDENT}already labelled — a label counts once, and a second one changes nothing\n`
    : `${INDENT}recorded: ${label}${withReason ? ", with your reason" : ""}\n`;

export const skippedLine = (): string => `${INDENT}skipped — it is offered again next time\n`;

/** The hub's refusal is ITS sentence; printed bare and bounded, and the walk goes on. */
export const labelRefusedLine = (message: string): string =>
  `${INDENT}not recorded: ${bareUntrusted(message, MAX_HUB_MESSAGE_CHARS)}\n`;

export const walkUnreachableLine = (message: string): string =>
  `${INDENT}hub unreachable: ${bareUntrusted(message, MAX_HUB_MESSAGE_CHARS)} — this one and the rest were not recorded\n`;

export const nothingToLabelLine = (windowMinutes: number): string =>
  `nothing reached you on this repo in the last ${windowWords(windowMinutes)} that you have not labelled — there is nothing to label\n`;

/** The walk's last word: what was labelled, what was not, and that it names nobody. */
export const walkSummaryLines = (tally: WalkTally, more: boolean): string => {
  const labelled = tally.helpful + tally.noise + tally.unclear;
  const extra = [
    ...(tally.already > 0 ? [`already labelled ${String(tally.already)}`] : []),
    ...(tally.refused > 0 ? [`not recorded ${String(tally.refused)}`] : []),
    ...(tally.notReached > 0 ? [`stopped with ${String(tally.notReached)} not reached`] : []),
  ].map((part) => ` · ${part}`);
  return [
    `labelled ${String(labelled)} of ${String(tally.total)} — helpful ${String(tally.helpful)} · noise ${String(tally.noise)} · unclear ${String(tally.unclear)} · skipped ${String(tally.skipped)}${extra.join("")}. Each label counts once toward this repo's pilot figures and names nobody.`,
    // No backticks: no renderer here emits one (the corpus's renderer-owned class).
    ...(more ? ["more are waiting past these — run crosscheck pilot label again"] : []),
    "",
  ].join("\n");
};
