/**
 * THE CUT LANDED-CHANGE CHECKS, COUNTED (2026-10-08): how many pre-edit
 * landed-change checks this machine had cut short in the last
 * BRIEFING_OMISSION_WINDOW_DAYS, and why — read off connector-core
 * state/landed-probe-cuts.ts, one sentence for `doctor` and `status` alike.
 *
 * Each session with a cut was told once, at its next prompt
 * (briefing/omission.ts `landedProbeCutsLine`); this is the count across
 * sessions, so a person who saw one such line can ask whether it is a
 * pattern. A WARN in doctor, because a cut check is an edit that went ahead
 * without the landed-change stop having finished.
 *
 * Counts, enum words and an ISO minute — no hub text, no path — so this
 * module renders nothing a render surface has to vouch for.
 */
import { BRIEFING_OMISSION_WINDOW_DAYS } from "@crosscheck/connector-core/constants.ts";
import type { LandedProbeCutCounts } from "@crosscheck/connector-core/state/landed-probe-cuts.ts";

import type { Check } from "./doctor.ts";

const NAME = "landed-change checks";

/** `2026-10-08T09:41Z` — the minute, as doctor's other ledger lines print instants. */
const ISO_MINUTE_CHARS = 16;

const window = `in the last ${String(BRIEFING_OMISSION_WINDOW_DAYS)} days`;

const causes = (byReason: LandedProbeCutCounts["byReason"]): string =>
  [
    byReason.deadline > 0 ? `${String(byReason.deadline)} ended by the check's deadline` : null,
    byReason.unanswered > 0
      ? `${String(byReason.unanswered)} with a landing branch git did not answer for`
      : null,
    byReason.budget > 0 ? `${String(byReason.budget)} ended with the edit hook's budget` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");

/** The one sentence both surfaces print when there is something to count. */
const cutSummary = (counts: LandedProbeCutCounts): string =>
  `${String(counts.total)} cut short ${window} (${causes(counts.byReason)})` +
  (counts.lastAt === null ? "" : `, newest ${counts.lastAt.slice(0, ISO_MINUTE_CHARS)}Z`);

export const landedProbeCutsCheck = (counts: LandedProbeCutCounts): Check =>
  counts.total === 0
    ? { level: "PASS", name: NAME, detail: `none cut short ${window}` }
    : {
        level: "WARN",
        name: NAME,
        detail:
          `${cutSummary(counts)} — each time an edit went ahead before the landed-change stop had finished; ` +
          "each session said so at its next prompt, and the hub latency line says whether the hub was the slow half",
      };

/** Zero prints nothing, the foreign-drops rule: status shows a count only when there is one. */
export const landedProbeCutsStatusLines = (counts: LandedProbeCutCounts): readonly string[] =>
  counts.total === 0 ? [] : [`${NAME}: ${cutSummary(counts)}`];
