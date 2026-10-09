/**
 * What `crosscheck pilot --mine` prints (1.0 spec 07 §13): the caller's own
 * hint outcomes on this repo — what reached them unasked, what each led to,
 * from whose work, and why.
 *
 * FRAMED. Two kinds of other people's text reach these lines: a teammate's
 * display name (bare, the author-name class every hint uses) and the reasons
 * — written by the caller or the caller's agent, and quoted as data all the
 * same, because an agent's sentence is not trusted text either.
 *
 * NO RANKING, NO SCORE. Teammates arrive from the hub in name order and are
 * printed in it; nothing here sorts people by how often their work was taken,
 * and no line puts a percentage beside a person (00 §8.5).
 *
 * WHO SEES WHAT IS SAID ON THE PAGE, not left to be inferred: this view is
 * the caller's alone; a teammate learns one count about their own work, for a
 * whole past month and only above the people-minimum (review #10); the team
 * report's line is a whole past month above its own minimums (review #4).
 */
import { QUOTED_DATA_NOTICE } from "@crosscheck/connector-core/briefing/render.ts";
import { bareUntrusted } from "@crosscheck/connector-core/briefing/sanitize.ts";
import type { Credit, MyHintOutcomes, SourceTally } from "@crosscheck/connector-core/http/hint-outcomes.ts";
import { quoted } from "@crosscheck/connector-core/mcp/render.ts";
import { HINT_OUTCOME_DISCLOSURE_MINIMUMS, MAX_PILOT_LABEL_REASON_UTF16_UNITS } from "@crosscheck/schema";

import { COUNTED_WHILE_ENROLLED, RECONSTRUCTED_ENROLMENT, monthOf, outcomeWord } from "./outcome-render.ts";
import { uncountedLines } from "./uncounted-lines.ts";

const INDENT = "  ";
/** A source the hub could not name — work that is not this repo's, or is gone. */
const UNNAMED_SOURCE = "work this repo cannot name";
const ISO_DAY_CHARS = 10;
const MS_PER_DAY = 86_400_000;

type Tally = Pick<SourceTally, "followed" | "overrode" | "notRelevantNow" | "noise" | "unmarked">;

const tallyWords = (tally: Tally): string =>
  [
    `followed ${String(tally.followed)}`,
    `overrode ${String(tally.overrode)}`,
    `not relevant now ${String(tally.notRelevantNow)}`,
    `noise ${String(tally.noise)}`,
    `unmarked ${String(tally.unmarked)}`,
  ].join(" · ");

const sourceName = (source: string | null): string => {
  const name = source === null ? "" : bareUntrusted(source);
  return name.length === 0 ? UNNAMED_SOURCE : name;
};

const day = (iso: string): string => bareUntrusted(iso.slice(0, ISO_DAY_CHARS));

const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? "" : "s"}`;

/**
 * WHERE COUNTING STARTS (07 §13.9): the hub clips the window to the instant
 * outcomes became recordable here, and a header that still said "last 56
 * days" over a view that began this morning would name a window nothing was
 * counted in. A start the client cannot read is treated as unclipped.
 */
const isClipped = (view: MyHintOutcomes): boolean =>
  Date.parse(view.sinceIso) > Date.parse(view.untilIso) - view.days * MS_PER_DAY;

const windowWords = (view: MyHintOutcomes): string =>
  isClipped(view)
    ? `since ${day(view.sinceIso)}, when outcomes became recordable here (..${day(view.untilIso)})`
    : `last ${plural(view.days, "day")} (${day(view.sinceIso)}..${day(view.untilIso)})`;

/** 07 §13.11 (review M3): a pause inside the window is said, so the window is not read as unbroken. */
const pausedWords = (view: MyHintOutcomes): string =>
  view.pausedInWindow === true ? " — counted only while the pilot was enrolled here" : "";

const headerLines = (view: MyHintOutcomes): readonly string[] => [
  `your hint outcomes on ${bareUntrusted(view.repo)} · ${windowWords(view)}${pausedWords(view)}`,
  QUOTED_DATA_NOTICE,
];

const receivedLines = (view: MyHintOutcomes): readonly string[] =>
  view.received === 0
    ? ["nothing reached you unasked on this repo in this window"]
    : [
        `hints that reached you unasked: ${String(view.received)} — as you confirmed them with your passkey: ${tallyWords(view)}`,
        ...view.bySource.flatMap((source) => [
          `${INDENT}from ${sourceName(source.source)}: ${String(source.received)} — ${tallyWords(source)}`,
          // 07 §13.14 (round-6 HIGH-1): the person's own verdict, on its own line — never one of the buckets
          ...(source.helpful === undefined ? [] : [`${INDENT}${INDENT}helpful (your label) ${String(source.helpful)}`]),
        ]),
        ...(view.bySourceBeyondList > 0
          ? [`${INDENT}(+${plural(view.bySourceBeyondList, "more teammate")}, counted above, not listed)`]
          : []),
      ];

/** 07 §13.14 (round-6 LOW-6): a helpful label's sentence is the person's own label's, as the helpful line says. */
const reasonWord = (outcome: string): string => (outcome === "helpful" ? "helpful (your label)" : outcomeWord(outcome));

const reasonLines = (view: MyHintOutcomes): readonly string[] =>
  view.reasons.length === 0
    ? []
    : [
        "why, newest first — as you confirmed it:",
        ...view.reasons.map(
          (said) =>
            `${INDENT}${reasonWord(said.outcome)}${said.reasserted === true ? ", said again" : ""}, from ${sourceName(said.source)}: ${quoted(said.reason, MAX_PILOT_LABEL_REASON_UTF16_UNITS)}`,
        ),
        ...(view.reasonsBeyondList > 0 ? [`${INDENT}(+${String(view.reasonsBeyondList)} more, not listed)`] : []),
      ];

const PEOPLE_MINIMUM = String(HINT_OUTCOME_DISCLOSURE_MINIMUMS.recorders);

/** Why a credit carries no number: the month was outside the repo's enrolment (07 §13.11, M3). */
const NOT_RECORDABLE_CREDIT = "nothing to count — the pilot was not enrolled here during it";

/** One generic sentence for every other word (review M1): which minimum failed is never said. */
const BELOW_MINIMUMS_CREDIT = `no count — below the disclosure minimums: leaving out any one person, at least ${PEOPLE_MINIMUM} people must have followed it`;

/**
 * THE SOURCE CREDIT (07 §13.10, review #10, M-1): one closed month's follows
 * of the caller's work, shown only once three people followed it with any one
 * left out — or why there is no number. Never a "followed 0", whoever sent it:
 * a zero is every recorder's verdict at once.
 */
const creditWords = (credit: Credit): string => {
  if (credit.withheld === null && credit.followed !== null && credit.followed > 0) {
    return `followed ${plural(credit.followed, "time")} — shown once, leaving out any one person, at least ${PEOPLE_MINIMUM} people followed it`;
  }
  return credit.withheld === "not_recordable" ? NOT_RECORDABLE_CREDIT : BELOW_MINIMUMS_CREDIT;
};

/**
 * FOLLOWS CONFIRMED LATE (review M6), a figure of its own (round-2 R2-H2):
 * a number only when it passes the minimum on its own — never "followed 0" —
 * the generic sentence otherwise. An older hub sends no late part.
 */
const lateCreditWords = (credit: Credit): string => {
  if (credit.late === undefined) {
    return "";
  }
  const late = credit.late;
  const words =
    late.withheld === null && late.followed !== null && late.followed > 0
      ? `followed ${plural(late.followed, "time")} — shown once, leaving out any one person, at least ${PEOPLE_MINIMUM} people followed them`
      : "no count — below the disclosure minimums";
  return `; and confirmed late, about earlier months' hints: ${words}`;
};

/** The correction (round-2 R2-H1): follows of the month later declared compromised; a count only past the minimums. */
const correctionCreditWords = (credit: Credit): string => {
  const retracted = credit.laterRetracted;
  if (retracted === undefined || retracted === null) {
    return "";
  }
  return retracted.count === null
    ? "; correction: some of these were later retracted — their passkey was declared compromised (no count: below the disclosure minimums)"
    : `; correction: ${String(retracted.count)} of these were later retracted — their passkey was declared compromised`;
};

/** 07 §13.11 (round 3): a credit this client cannot read is one line, and the person's own view still prints. */
const UNREADABLE_CREDIT_LINE =
  "your own work, in teammates' hints: this hub sent a count this client cannot read — nothing is shown from it";

const creditLine = (credit: MyHintOutcomes["yourWork"]): string =>
  "unreadable" in credit
    ? UNREADABLE_CREDIT_LINE
    : `your own work, in teammates' hints, ${monthOf(credit.periodStartIso)}: ${creditWords(credit)}` +
      lateCreditWords(credit) +
      correctionCreditWords(credit) +
      (credit.pausedInPeriod === true ? `; ${COUNTED_WHILE_ENROLLED}` : "") +
      (credit.reconstructed === true ? `; ${RECONSTRUCTED_ENROLMENT}` : "");

/**
 * WHAT IS NOT YOURS YET (human provenance §5), never inside the counts above:
 * your agent's words and words typed at a terminal are drafts until your
 * passkey confirms them, and words from before provenance existed stay apart.
 * An older hub sends no block and gets no line.
 */
const notConfirmedLines = (view: MyHintOutcomes): readonly string[] => {
  const pending = view.notConfirmed;
  if (pending === undefined) {
    return [];
  }
  const waiting = pending.byAgent + pending.atTerminal;
  return [
    `not confirmed by you, so not counted above: ${String(pending.byAgent)} rated by your agent · ${String(pending.atTerminal)} typed at a terminal · ${String(pending.legacy)} recorded before provenance existed`,
    ...(waiting > 0 ? [`${INDENT}confirm or discard them with your passkey: crosscheck confirm`] : []),
    ...uncountedLines(pending, INDENT),
  ];
};

/** Human provenance §9: a hub where no passkey could confirm says so, rather than show an empty view as a verdict. */
export const CONFIRMABILITY_LINE: Readonly<Record<"hub_machine_only" | "none", string>> = {
  none: "no human-confirmed judgements possible on this hub: set up https",
  hub_machine_only:
    "human-confirmed judgements are possible here only from the hub's own machine (localhost): set up https, for example with tailscale serve, to confirm from yours",
};

const confirmabilityLines = (view: MyHintOutcomes): readonly string[] =>
  view.humanConfirmation === "none" || view.humanConfirmation === "hub_machine_only"
    ? [CONFIRMABILITY_LINE[view.humanConfirmation]]
    : [];

const footerLines = (view: MyHintOutcomes): readonly string[] => [
  creditLine(view.yourWork),
  // Human provenance §5: only a passkey makes a word yours; every door with your key only drafts
  "counted above: only what you confirmed with your passkey (crosscheck confirm); your agent's words (mark_hint_outcome) and words typed at a terminal (crosscheck followed / overrode / noise / helpful) are drafts until then",
  "only you see this view in full; others see your words only inside totals for a whole past month: the team report's, and a teammate's count of how often their work was followed",
  `each is shown only if, leaving out any one person's words, words from at least ${PEOPLE_MINIMUM} people remain — the team report's also about at least ${String(HINT_OUTCOME_DISCLOSURE_MINIMUMS.sources)} people's work, ${String(HINT_OUTCOME_DISCLOSURE_MINIMUMS.recorded)} or more — so a team of three never gets either`,
];

export const renderMyOutcomes = (view: MyHintOutcomes): string =>
  `${[
    ...headerLines(view),
    ...confirmabilityLines(view),
    ...receivedLines(view),
    ...notConfirmedLines(view),
    ...reasonLines(view),
    ...footerLines(view),
  ].join("\n")}\n`;

export const MINE_NOT_SERVED_LINE =
  "this hub does not record hint outcomes — it predates them, so there is nothing to show until it is upgraded\n";

export const MINE_JSON_REFUSAL =
  "--mine prints your own view as text only; --json is the team report's (crosscheck pilot --json)\n";
