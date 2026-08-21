/**
 * Summarizer cost, made visible (DESIGN.md §10 risk 7): the Stop hook books
 * every fire and its rough token estimate into the session state, and this
 * module sums what the LIVE sessions of one repo+hub have spent so
 * `crosscheck status` and `doctor` can print it. Session state is deleted at
 * SessionEnd, so this is per-LIVE-session visibility by design — the point
 * is that a running summarizer is never spending invisibly, not accounting.
 *
 * Every figure derived from CHARS_PER_TOKEN_ESTIMATE is an ESTIMATE, and
 * every surface printing one says so. WHAT IT COUNTS: the slice and the
 * prompt the Stop hook hands over, at ~4 chars/token — NOT the nested
 * claude's own system prompt, which is the larger share of a real call.
 * Measured 2026-08-21 on Claude Code 2.1.237 with the lean argv and the
 * doctor probe slice: the estimate says ~234 tokens; the CLI's usage
 * reports 6714 cached input + 187 output tokens (cost_usd 0.0028 on a
 * cache hit; the first, uncached call of the day creates that ~6.6k cache
 * at ~0.017). The line is a spend INDICATOR on the developer's quota —
 * "is this firing at all, and how often" — not a bill.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  DOCTOR_SUMMARIZER_SILENT_FIRES_WARN,
  STATUS_MAX_SESSION_STATES,
} from "@crosscheck/connector-core/constants.ts";
import { readJsonOrNull } from "@crosscheck/connector-core/config/paths.ts";
import { SessionStateSchema } from "@crosscheck/connector-core/state/session-state.ts";

export interface SummarizerCost {
  /** Live sessions of this repo+hub that were counted. */
  readonly sessions: number;
  readonly fires: number;
  /** Fires the model answered NONE — the gate's noise, counted honestly. */
  readonly nones: number;
  /** Fires that produced a spooled draft — the gate's signal. */
  readonly drafts: number;
  /**
   * Fires the RUNNER lost — binary missing, non-zero exit, deadline (trial
   * finding #14) — and one booked reason, already sanitized and bounded by
   * the writer (gate.ts withSummarizerFailure). Which live session's
   * failure is shown is scan order's choice; they all say the same thing
   * when the runner is broken, which is the case this exists for.
   */
  readonly fails: number;
  readonly lastFailure: string | null;
  /** Rough figure at ~4 chars/token — an estimate, never a bill. */
  readonly estimatedTokens: number;
}

const NO_COST: SummarizerCost = {
  sessions: 0,
  fires: 0,
  nones: 0,
  drafts: 0,
  fails: 0,
  lastFailure: null,
  estimatedTokens: 0,
};

/**
 * Bounded scan of the session-state directory: at most
 * STATUS_MAX_SESSION_STATES files are read — more live sessions than that on
 * one machine is not a cost question anymore.
 */
export const readSummarizerCost = async (
  home: string,
  hubUrl: string,
  repoId: string,
): Promise<SummarizerCost> => {
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
        SessionStateSchema.safeParse(
          await readJsonOrNull(join(home, "sessions", name)),
        ),
      ),
  );
  return parsed
    .filter((entry) => entry.success)
    .map((entry) => entry.data)
    .filter((state) => state.hubUrl === hubUrl && state.repoId === repoId)
    .reduce<SummarizerCost>(
      (total, state) => ({
        sessions: total.sessions + 1,
        fires: total.fires + state.summarizerFireCount,
        nones: total.nones + state.summarizerNoneCount,
        drafts: total.drafts + state.summarizerDraftCount,
        fails: total.fails + state.summarizerFailCount,
        lastFailure: state.summarizerLastFailure ?? total.lastFailure,
        estimatedTokens:
          total.estimatedTokens + state.summarizerEstimatedTokens,
      }),
      NO_COST,
    );
};

/**
 * The one spelling of the cost fact both CLI surfaces print. The outcome
 * split (trial finding #12's measuring stick) rides in the middle: NONE is
 * the gate's noise, drafts its signal, failures the runner's own losses
 * with the last booked reason (trial finding #14), and any gap left to the
 * run count is a drop or unparseable output — figures the trial reads side
 * by side.
 */
export const formatSummarizerCost = (cost: SummarizerCost): string => {
  if (cost.sessions === 0) {
    return "no live sessions";
  }
  const sessionsPart =
    cost.sessions === 1
      ? "1 live session"
      : `${String(cost.sessions)} live sessions`;
  const draftsPart =
    cost.drafts === 1 ? "1 draft" : `${String(cost.drafts)} drafts`;
  const lastPart =
    cost.lastFailure === null ? "" : `: last "${cost.lastFailure}"`;
  const failsPart =
    cost.fails === 0 ? "" : `, ${String(cost.fails)} failed${lastPart}`;
  return (
    `${String(cost.fires)} runs (${String(cost.nones)} NONE, ${draftsPart}${failsPart}), ` +
    `~${String(cost.estimatedTokens)} tokens (estimate) across ${sessionsPart}`
  );
};

/**
 * The finding-#14 signature: fires enough to mean it, and not ONE answered
 * — no NONE, no draft. Below DOCTOR_SUMMARIZER_SILENT_FIRES_WARN a lost
 * run is noise; from it on, fail-open has become silently dead and doctor
 * must say so (DESIGN.md §4: "fail-open must never mean silently dead").
 */
export const isSummarizerSilentlyDead = (cost: SummarizerCost): boolean =>
  cost.fires >= DOCTOR_SUMMARIZER_SILENT_FIRES_WARN &&
  cost.nones + cost.drafts === 0;
