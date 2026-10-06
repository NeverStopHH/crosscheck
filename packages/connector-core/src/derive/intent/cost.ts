/**
 * Derived-intent cost and outcome, made visible (trial finding #16; the
 * finding-#14 lesson that a fire which lands nothing must be a number
 * somebody can explain): the UserPromptSubmit hook books each fire and the
 * worker books what came of it, and this module sums the LIVE sessions of
 * one repo+hub so `crosscheck status` and `doctor` can print it — the
 * summarizer cost module's shape (summarizer/cost.ts), one bounded scan.
 *
 * Each fire is one Haiku call on the developer's own quota — at most one
 * per session state — so there is no token estimate here: the count IS the
 * spend indicator.
 */
import { DOCTOR_INTENT_SILENT_FIRES_WARN } from "../../constants.ts";
import { readLiveSessionStates } from "../../state/session-state.ts";
import type { SessionState } from "../../state/session-state.ts";

export interface IntentCost {
  /** Live sessions of this repo+hub that were counted. */
  readonly sessions: number;
  readonly fires: number;
  /** Fires the model answered NONE — a prompt that was not about a task. */
  readonly nones: number;
  /** Fires that put an intent record on the spool. */
  readonly sets: number;
  /** Fires the model answered and the worker refused (intent/gate.ts withIntentRefusal). */
  readonly refused: number;
  /** Fires dropped before the model was asked (intent/gate.ts withIntentSkip). */
  readonly skipped: number;
  /**
   * Runner losses, and the newest one's reason — already sanitized and
   * bounded by the writer (intent/gate.ts withIntentFailure).
   */
  readonly fails: number;
  readonly lastFailure: string | null;
  /** The newest refusal's or skip's reason. */
  readonly lastDrop: string | null;
}

const NO_COST: IntentCost = {
  sessions: 0,
  fires: 0,
  nones: 0,
  sets: 0,
  refused: 0,
  skipped: 0,
  fails: 0,
  lastFailure: null,
  lastDrop: null,
};

/** Sums states the caller already read — one scan for all three counters. */
export const summarizeIntentCost = (
  states: readonly SessionState[],
): IntentCost =>
  states.reduce<IntentCost>(
    (total, state) => ({
      sessions: total.sessions + 1,
      fires: total.fires + state.intentFireCount,
      nones: total.nones + state.intentNoneCount,
      sets: total.sets + state.intentSetCount,
      refused: total.refused + state.intentRefusedCount,
      skipped: total.skipped + state.intentSkippedCount,
      fails: total.fails + state.intentFailCount,
      lastFailure: state.intentLastFailure ?? total.lastFailure,
      lastDrop: state.intentLastDrop ?? total.lastDrop,
    }),
    NO_COST,
  );

/** Scan-and-sum, for a caller that wants only this one figure. */
export const readIntentCost = async (
  home: string,
  hubUrl: string,
  repoId: string,
): Promise<IntentCost> =>
  summarizeIntentCost((await readLiveSessionStates(home, hubUrl, repoId)).states);

/** The one spelling of the intent fact both CLI surfaces print. */
export const formatIntentCost = (cost: IntentCost): string => {
  if (cost.sessions === 0) {
    return "no live sessions";
  }
  const sessionsPart =
    cost.sessions === 1 ? "1 live session" : `${String(cost.sessions)} live sessions`;
  const firesPart = cost.fires === 1 ? "1 fire" : `${String(cost.fires)} fires`;
  const lastPart = cost.lastFailure === null ? "" : `: last "${cost.lastFailure}"`;
  const failsPart = cost.fails === 0 ? "" : `, ${String(cost.fails)} failed${lastPart}`;
  const dropped = [
    ...(cost.refused === 0 ? [] : [`${String(cost.refused)} refused`]),
    ...(cost.skipped === 0 ? [] : [`${String(cost.skipped)} skipped`]),
  ];
  const dropPart =
    dropped.length === 0
      ? ""
      : `, ${dropped.join(", ")}${cost.lastDrop === null ? "" : `: last "${cost.lastDrop}"`}`;
  return `${firesPart} (${String(cost.nones)} NONE, ${String(cost.sets)} set${dropPart}${failsPart}) across ${sessionsPart}`;
};

/**
 * Doctor's WARN rule: any runner failure or refused answer, or
 * DOCTOR_INTENT_SILENT_FIRES_WARN fires that reported nothing back at all.
 * A skipped run is no fault of the model and never warns by itself. Never
 * PASS-only (the finding-#14 lesson).
 */
export const isIntentSilentlyDead = (cost: IntentCost): boolean =>
  cost.fails > 0 ||
  cost.refused > 0 ||
  (cost.fires >= DOCTOR_INTENT_SILENT_FIRES_WARN &&
    cost.nones + cost.sets + cost.refused + cost.skipped === 0);
