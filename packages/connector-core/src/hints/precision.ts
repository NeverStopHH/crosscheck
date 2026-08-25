/**
 * The solved-pointer precision loop, in words (VISION.md §1, DESIGN.md §4
 * "telemetry from day one") — the ONE spelling `crosscheck status` prints
 * and `doctor` warns on, so the two can never disagree about the same rows.
 *
 * WHAT THE NUMBERS MEAN, stated because the pair is easy to misread: `shown`
 * counts solved-tree pointers this developer was HANDED on this repo inside
 * the hub's window, `pulled` counts how many of those they then opened with
 * `get_diagnosis`. Both are floors — the hub reads a bounded page of the
 * delivery ledger — which is why every sentence here names the window.
 *
 * NOTHING UNTRUSTED REACHES THIS MODULE: it formats integers and its own
 * literals. That is why it is not a §4.4 render surface and imports nothing
 * from the render layer.
 */
import { DOCTOR_SOLVED_SHOWN_WARN } from "../constants.ts";
import type { SolvedMatchCounts } from "../http/hub.ts";

/**
 * `3 shown, 1 pulled in the last 30 days` — or "not measured yet", which is
 * the honest reading of zero shown: nothing was offered, so nothing could be
 * ignored. A hub too old to answer the counters sends zeros and lands here
 * too, and "not measured yet" is true of it as well.
 */
export const formatSolvedCounts = (counts: SolvedMatchCounts): string => {
  if (counts.shown === 0) {
    return "not measured yet (nothing shown)";
  }
  return (
    `${String(counts.shown)} shown, ${String(counts.pulled)} pulled ` +
    `in the last ${String(counts.windowDays)} days`
  );
};

/**
 * The WARN path, so this counter is never PASS-only (the finding-#14
 * lesson). ONE failure is worth a human's attention here, and it is not
 * "few pulls" — it is pointers that are shown repeatedly and opened NEVER,
 * which is what a surface that asserts relevance unasked looks like when it
 * is wrong. Below DOCTOR_SOLVED_SHOWN_WARN there is not enough evidence to
 * say anything, and saying it anyway would be the same over-claiming the
 * warning exists to catch. Null = nothing to warn about.
 */
export const solvedPrecisionWarning = (
  counts: SolvedMatchCounts,
): string | null => {
  if (counts.shown < DOCTOR_SOLVED_SHOWN_WARN || counts.pulled > 0) {
    return null;
  }
  return (
    "no solved pointer has been opened — the matches are being shown and " +
    "ignored, which is what a wrong match looks like"
  );
};
