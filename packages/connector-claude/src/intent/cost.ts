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
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  DOCTOR_INTENT_SILENT_FIRES_WARN,
  STATUS_MAX_SESSION_STATES,
} from "@crosscheck/connector-core/constants.ts";
import { readJsonOrNull } from "@crosscheck/connector-core/config/paths.ts";
import { SessionStateSchema } from "@crosscheck/connector-core/state/session-state.ts";

export interface IntentCost {
  /** Live sessions of this repo+hub that were counted. */
  readonly sessions: number;
  readonly fires: number;
  /** Fires the model answered NONE — a prompt that was not about a task. */
  readonly nones: number;
  /** Fires that put an intent record on the spool. */
  readonly sets: number;
  /**
   * Fires that landed neither: a runner loss or a worker-side drop (secret,
   * echo, empty, a pre-intent state file), and one booked reason — already
   * sanitized and bounded by the writer (intent/gate.ts withIntentFailure).
   */
  readonly fails: number;
  readonly lastFailure: string | null;
}

const NO_COST: IntentCost = {
  sessions: 0,
  fires: 0,
  nones: 0,
  sets: 0,
  fails: 0,
  lastFailure: null,
};

/** Bounded scan, the summarizer cost's: at most STATUS_MAX_SESSION_STATES files. */
export const readIntentCost = async (
  home: string,
  hubUrl: string,
  repoId: string,
): Promise<IntentCost> => {
  let names: readonly string[];
  try {
    names = await readdir(join(home, "sessions"));
  } catch {
    return NO_COST;
  }
  const parsed = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .slice(0, STATUS_MAX_SESSION_STATES)
      .map(async (name) =>
        SessionStateSchema.safeParse(await readJsonOrNull(join(home, "sessions", name))),
      ),
  );
  return parsed
    .filter((entry) => entry.success)
    .map((entry) => entry.data)
    .filter((state) => state.hubUrl === hubUrl && state.repoId === repoId)
    .reduce<IntentCost>(
      (total, state) => ({
        sessions: total.sessions + 1,
        fires: total.fires + state.intentFireCount,
        nones: total.nones + state.intentNoneCount,
        sets: total.sets + state.intentSetCount,
        fails: total.fails + state.intentFailCount,
        lastFailure: state.intentLastFailure ?? total.lastFailure,
      }),
      NO_COST,
    );
};

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
  return `${firesPart} (${String(cost.nones)} NONE, ${String(cost.sets)} set${failsPart}) across ${sessionsPart}`;
};

/**
 * Doctor's WARN rule: any booked failure at all, or
 * DOCTOR_INTENT_SILENT_FIRES_WARN fires that landed neither a NONE nor an
 * intent. Never PASS-only (the finding-#14 lesson).
 */
export const isIntentSilentlyDead = (cost: IntentCost): boolean =>
  cost.fails > 0 ||
  (cost.fires >= DOCTOR_INTENT_SILENT_FIRES_WARN && cost.nones + cost.sets === 0);
