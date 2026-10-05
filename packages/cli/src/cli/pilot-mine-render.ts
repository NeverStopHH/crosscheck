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
 * the caller's alone, a teammate learns one count about their own work, and
 * the team report stays per repo.
 */
import { QUOTED_DATA_NOTICE } from "@crosscheck/connector-core/briefing/render.ts";
import { bareUntrusted } from "@crosscheck/connector-core/briefing/sanitize.ts";
import type { MyHintOutcomes, SourceTally } from "@crosscheck/connector-core/http/hint-outcomes.ts";
import { quoted } from "@crosscheck/connector-core/mcp/render.ts";
import { HINT_OUTCOME_DISCLOSURE_MINIMUMS, MAX_PILOT_LABEL_REASON_UTF16_UNITS } from "@crosscheck/schema";

import { outcomeWord } from "./outcome-render.ts";

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

const headerLines = (view: MyHintOutcomes): readonly string[] => [
  `your hint outcomes on ${bareUntrusted(view.repo)} · ${windowWords(view)}`,
  QUOTED_DATA_NOTICE,
];

const receivedLines = (view: MyHintOutcomes): readonly string[] =>
  view.received === 0
    ? ["nothing reached you unasked on this repo in this window"]
    : [
        `hints that reached you unasked: ${String(view.received)} — ${tallyWords(view)}`,
        ...view.bySource.map(
          (source) => `${INDENT}from ${sourceName(source.source)}: ${String(source.received)} — ${tallyWords(source)}`,
        ),
        ...(view.bySourceBeyondList > 0
          ? [`${INDENT}(+${plural(view.bySourceBeyondList, "more teammate")}, counted above, not listed)`]
          : []),
      ];

const reasonLines = (view: MyHintOutcomes): readonly string[] =>
  view.reasons.length === 0
    ? []
    : [
        "why, newest first — as you or your agent wrote it:",
        ...view.reasons.map(
          (said) =>
            `${INDENT}${outcomeWord(said.outcome)}, from ${sourceName(said.source)}: ${quoted(said.reason, MAX_PILOT_LABEL_REASON_UTF16_UNITS)}`,
        ),
        ...(view.reasonsBeyondList > 0 ? [`${INDENT}(+${String(view.reasonsBeyondList)} more, not listed)`] : []),
      ];

const footerLines = (view: MyHintOutcomes): readonly string[] => [
  `your own work, in teammates' hints: followed ${plural(view.yourWork.followed, "time")}`,
  "recorded with your key — by your agent (mark_hint_outcome) or by you (crosscheck followed / overrode); noise is your own label (crosscheck noise)",
  `only you see this view in full; others see your words only inside the team report's totals for a whole past month, shown once at least ${String(HINT_OUTCOME_DISCLOSURE_MINIMUMS.recorders)} people recorded outcomes about at least ${String(HINT_OUTCOME_DISCLOSURE_MINIMUMS.sources)} people's work, and each teammate whose work it was sees how often it was followed`,
];

export const renderMyOutcomes = (view: MyHintOutcomes): string =>
  `${[...headerLines(view), ...receivedLines(view), ...reasonLines(view), ...footerLines(view)].join("\n")}\n`;

export const MINE_NOT_SERVED_LINE =
  "this hub does not record hint outcomes — it predates them, so there is nothing to show until it is upgraded\n";

export const MINE_JSON_REFUSAL =
  "--mine prints your own view as text only; --json is the team report's (crosscheck pilot --json)\n";
