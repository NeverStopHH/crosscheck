/**
 * THE ONE SPELLING of a briefing that did not arrive whole (2026-10-08) —
 * printed by the hook that lost it, so the person learns it in the session
 * it happened in, never only from a counter they would have to go and read.
 *
 * "A hook that cannot reach the hub exits fast and silent" was the rule, and
 * the silence was the defect: a SessionStart whose budget ran out, whose
 * handler threw, or whose hub reads did not answer printed nothing at all,
 * and an empty session read exactly like a quiet repo. Fast stays the rule;
 * silent does not. One line, no hub text and no internal detail in it — only
 * that the briefing is missing or incomplete, the coarse reason, and where
 * the count lives (`crosscheck doctor`, state/briefing-omissions.ts).
 *
 * The same shape for the pre-edit landed-change check (2026-10-08): a check
 * the hub or git cut short used to print nothing and book nothing; its line
 * lives here too, told once at the session's next prompt.
 *
 * Not a render-layer module: nothing here carries untrusted text, so there is
 * nothing to sanitize and no surface to register.
 */
import type { BriefingOmissionReason } from "../state/briefing-omissions.ts";

const DOCTOR_COUNTS = "`crosscheck doctor` counts these";

const SKIPPED_BECAUSE: Readonly<Record<Exclude<BriefingOmissionReason, "hub">, string>> = {
  budget: "the hub or git did not answer within the session-start budget",
  error: "the connector failed while building it",
};

/** The whole briefing is gone: the budget won, or the handler threw. */
export const briefingSkippedLine = (reason: Exclude<BriefingOmissionReason, "hub">): string =>
  `crosscheck: no briefing this session — ${SKIPPED_BECAUSE[reason]}; ${DOCTOR_COUNTS}.`;

/**
 * Landed-change checks this session's edits had cut short (state/landed-
 * probe-cuts.ts) — said ONCE per session, at its next prompt, never per edit:
 * the stop it could not finish is about one file, and a line on every edit
 * of a slow repo would be the noise its once-per-file rule exists to prevent.
 */
export const landedProbeCutsLine = (cuts: number): string =>
  `crosscheck: ${String(cuts)} landed-change check${cuts === 1 ? " was" : "s were"} cut short this session ` +
  `(the hub or git was slow), so an edit may have gone ahead without a teammate's landed change being checked; ${DOCTOR_COUNTS}.`;

/**
 * Hub reads that did not answer — timed out or unreachable, never a hub that
 * answered with something this connector cannot use (an older hub's missing
 * route is fail-open by design and stays silent). `wholeBriefingLost` when no
 * section survived, so the line is the whole briefing; otherwise it is
 * appended under what did arrive.
 */
export const unansweredReadsLine = (unanswered: number, reads: number, wholeBriefingLost: boolean): string => {
  const counted = `${String(unanswered)} of ${String(reads)} hub reads did not answer (timed out or unreachable)`;
  return wholeBriefingLost
    ? `crosscheck: no briefing this session — ${counted}; ${DOCTOR_COUNTS}.`
    : `crosscheck: this briefing is incomplete — ${counted}.`;
};
