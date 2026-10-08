/**
 * THE BRIEFINGS LINE (2026-10-08): how many SessionStart briefings this
 * machine did not deliver whole in the last BRIEFING_OMISSION_WINDOW_DAYS,
 * and why — read off connector-core state/briefing-omissions.ts.
 *
 * Each of them already told its own session (briefing/omission.ts); this is
 * the count across sessions, so a person who saw one such line can ask
 * whether it is a pattern. A WARN, because a briefing that did not arrive is
 * information the person did not get, and the remedy is one check up: the
 * hub reachability and latency lines say why the hub was slow.
 *
 * Counts, enum words and an ISO minute — no hub text, no path — so this
 * module renders nothing a render surface has to vouch for.
 */
import { BRIEFING_OMISSION_WINDOW_DAYS } from "@crosscheck/connector-core/constants.ts";
import type { BriefingOmissionCounts } from "@crosscheck/connector-core/state/briefing-omissions.ts";

import type { Check } from "./doctor.ts";

const NAME = "briefings";

/** `2026-10-08T09:41Z` — the minute, as doctor's other ledger lines print instants. */
const ISO_MINUTE_CHARS = 16;

const window = `in the last ${String(BRIEFING_OMISSION_WINDOW_DAYS)} days`;

const causes = (byReason: BriefingOmissionCounts["byReason"]): string =>
  [
    byReason.budget > 0 ? `${String(byReason.budget)} cut by the session-start budget` : null,
    byReason.error > 0 ? `${String(byReason.error)} connector error${byReason.error === 1 ? "" : "s"}` : null,
    byReason.hub > 0 ? `${String(byReason.hub)} with hub reads unanswered` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");

export const briefingOmissionsCheck = (counts: BriefingOmissionCounts): Check =>
  counts.total === 0
    ? { level: "PASS", name: NAME, detail: `none missing or incomplete ${window}` }
    : {
        level: "WARN",
        name: NAME,
        detail:
          `${String(counts.total)} missing or incomplete ${window} (${causes(counts.byReason)})` +
          (counts.lastAt === null ? "" : `, newest ${counts.lastAt.slice(0, ISO_MINUTE_CHARS)}Z`) +
          " — each session said so when it happened; the hub reachability and latency lines say why",
      };
