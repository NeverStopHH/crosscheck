/**
 * Summarizer cost, made visible (DESIGN.md §10 risk 7): the Stop hook books
 * every fire and its rough token estimate into the session state, and this
 * module sums what the LIVE sessions of one repo+hub have spent so
 * `crosscheck status` and `doctor` can print it. Session state is deleted at
 * SessionEnd, so this is per-LIVE-session visibility by design — the point
 * is that a running summarizer is never spending invisibly, not accounting.
 *
 * Every figure derived from CHARS_PER_TOKEN_ESTIMATE is an ESTIMATE, and
 * every surface printing one says so.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { STATUS_MAX_SESSION_STATES } from "@crosscheck/connector-core/constants.ts";
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
  /** Rough figure at ~4 chars/token — an estimate, never a bill. */
  readonly estimatedTokens: number;
}

const NO_COST: SummarizerCost = {
  sessions: 0,
  fires: 0,
  nones: 0,
  drafts: 0,
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
        estimatedTokens:
          total.estimatedTokens + state.summarizerEstimatedTokens,
      }),
      NO_COST,
    );
};

/**
 * The one spelling of the cost fact both CLI surfaces print. The outcome
 * split (trial finding #12's measuring stick) rides in the middle: NONE is
 * the gate's noise, drafts its signal, and any gap to the run count is a
 * drop or a runner failure — three figures the trial reads side by side.
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
  return (
    `${String(cost.fires)} runs (${String(cost.nones)} NONE, ${draftsPart}), ` +
    `~${String(cost.estimatedTokens)} tokens (estimate) across ${sessionsPart}`
  );
};
