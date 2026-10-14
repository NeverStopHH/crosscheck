/**
 * THE COLLISION WARNINGS THAT MAY NOT HAVE REACHED A PERSON, COUNTED (batch-2
 * review, L2 and H2): how many times in the last BRIEFING_OMISSION_WINDOW_DAYS
 * a teammate collision's person may not have been told — a 30 s rest whose
 * recheck never ran (`rest_unchecked`), or a tripwire answer the edit hook's
 * budget cut before its line left (`tripwire_cut`) — read off connector-core
 * state/rest-omissions.ts, one sentence for `doctor` and `status` alike.
 *
 * The ledger was written and read by nothing (L2), so a cut collision warning
 * showed in doctor only as a landed-check cut. Each such moment also left the
 * file owing a recheck, which a later hook paid or booked; this is the
 * pattern across sessions. A WARN, like the landed-change checks beside it.
 *
 * Counts, enum words and an ISO minute — no hub text, no path — so this
 * module renders nothing a render surface has to vouch for.
 */
import { BRIEFING_OMISSION_WINDOW_DAYS } from "@crosscheck/connector-core/constants.ts";
import type { RestOmissionCounts } from "@crosscheck/connector-core/state/rest-omissions.ts";

import type { Check } from "./doctor.ts";

const NAME = "collision warnings";

/** `2026-10-09T07:12Z` — the minute, as doctor's other ledger lines print instants. */
const ISO_MINUTE_CHARS = 16;

const window = `in the last ${String(BRIEFING_OMISSION_WINDOW_DAYS)} days`;

const causes = (byReason: RestOmissionCounts["byReason"]): string =>
  [
    byReason.tripwire_cut > 0
      ? `${String(byReason.tripwire_cut)} cut by the edit hook's budget before the line left`
      : null,
    byReason.rest_unchecked > 0 ? `${String(byReason.rest_unchecked)} rest never rechecked` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");

/** The one sentence both surfaces print when there is something to count. */
const omissionSummary = (counts: RestOmissionCounts): string =>
  `${String(counts.total)} possibly not shown ${window} (${causes(counts.byReason)})` +
  (counts.lastAt === null ? "" : `, newest ${counts.lastAt.slice(0, ISO_MINUTE_CHARS)}Z`);

export const collisionOmissionsCheck = (counts: RestOmissionCounts): Check =>
  counts.total === 0
    ? { level: "PASS", name: NAME, detail: `none missed ${window}` }
    : {
        level: "WARN",
        name: NAME,
        detail:
          `${omissionSummary(counts)} — each time a teammate's overlap may have reached the agent and not the person; ` +
          "each file was left owing a recheck, which the next hook paid or booked",
      };

/** Zero prints nothing, the foreign-drops rule: status shows a count only when there is one. */
export const collisionOmissionsStatusLines = (counts: RestOmissionCounts): readonly string[] =>
  counts.total === 0 ? [] : [`${NAME}: ${omissionSummary(counts)}`];
