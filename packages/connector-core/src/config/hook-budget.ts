/**
 * The hook budget discipline as SHARED arithmetic (DESIGN-agent-agnostic.md
 * prime rule: a hook that cannot reach the hub exits fast and silent — the
 * host never waits meaningfully, never breaks).
 *
 * EXTRACTED FROM `connector-claude/src/hooks/runner.ts` verbatim for Block 6
 * (the first second consumer — the Cursor connector's `cursor-hook`
 * processes run under the identical race), not invented: the Claude runner
 * calls these now and re-exports `hookBudget` reference-identically, so the
 * budget family has exactly one spelling. WHICH event maps to WHICH ratio
 * stays host policy in each connector, the `heartbeatMaybe` split.
 */
import { HOOK_RESERVE_RATIO } from "../constants.ts";
import { readStoredConfig, resolveTimeoutMs } from "./config.ts";
import { crosscheckHome } from "./paths.ts";
import type { Env } from "./paths.ts";

/**
 * How much of the hosting hook's TOTAL budget maintenance may still spend, read
 * at the moment of the call — the same budget `withBudget` below enforces by
 * abandoning the hook.
 *
 * One grade, deliberately. `spareMs` is what may go to work the developer never
 * sees — draining the spool, ending a deferred session — and it already holds
 * the reserve back. There is no accessor for the rest: a hook's own essential
 * step is bounded by the per-request timeout and by the total-budget race, and
 * every time maintenance was handed the raw remainder instead it finished after
 * the race had already resolved and took the hook's whole point down with it
 * (see HOOK_RESERVE_RATIO for both measurements).
 *
 * A CLAIM THE OUTPUT MUST DELIVER (batch-2 review, H2) is not gated on the
 * spare: a hook that marks something told and then loses the race told
 * nobody, and waiting for spare time only moved the loss to the hooks whose
 * answer came late. Such a claim registers its undo with `onCut` instead, in
 * the same locked transform that makes it, and the runner runs every undo
 * once the race is lost (`hookRace`). `isCut` refuses a claim the race has
 * already lost. Both are absent on a budget built outside a race — a test
 * driving a handler directly — which is never cut.
 */
export interface HookBudget {
  readonly spareMs: () => number;
  /** Whether the race has already abandoned this hook: an output made now is never read. */
  readonly isCut?: () => boolean;
  /** How to undo a claim this hook's output must deliver, should the race abandon the hook. */
  readonly onCut?: (undo: CutUndo) => void;
  /**
   * The hook's capture is on disk — its records appended, its state written —
   * and only maintenance is left: a cut from here on loses nothing, since a
   * drain the race abandons leaves its records in the spool for the next hook
   * (the runner books a cut capture hook as `hook_timed_out` until this is
   * said; release gate, loaded lane, 2026-10-09). Absent on a budget built
   * outside a race.
   */
  readonly captured?: () => void;
}

/** Undoes one claim of a hook the race abandoned; never throws (the race's settle swallows it). */
export type CutUndo = () => Promise<void>;

/**
 * The reserve as arithmetic: what is LEFT of the hook's deadline, minus one
 * per-request timeout, floored at zero.
 *
 * WHAT THE RESERVE CARRIES OUT IS THE HOOK'S ANSWER, and an ANSWERLESS hook
 * — Stop, SubagentStop: async, their response ignored (connector-claude
 * cli/settings-merge.ts) — holds nothing back (`holdsReserve` false): its
 * spare is the whole remainder, floored the same way. Held back on them, the
 * request timeout starved exactly the work they exist for (release gate,
 * loaded lane, 2026-10-09): the git lane, which needs one git deadline of the
 * hook's 800 ms, was skipped once 150 ms had passed, and the drain after it
 * shipped one of the two batches a resumed life's re-filing takes. The race
 * still cuts the hook at its deadline, and the drain still bounds every
 * request to the room left (spool/flush.ts), so nothing outlives it.
 *
 * `now` is a parameter, and that is the only reason this is exported. The
 * reserve used to be observable ONLY through its wall-clock side effect — take
 * it away and maintenance eats the hook, so the briefing goes missing and the
 * hook runs long — which makes detecting its removal a bet on how slow
 * maintenance happens to be on the machine running the check. Pass a frozen
 * clock and the subtraction itself is observable, with no process, no file and
 * no real clock in the way: connector-claude/test/hook-reserve.test.ts.
 * Production passes no clock and gets `Date.now`.
 */
export const hookBudget = (
  deadlineMs: number,
  timeoutMs: number,
  now: () => number = Date.now,
  holdsReserve = true,
): HookBudget => ({
  spareMs: () =>
    Math.max(0, deadlineMs - now() - (holdsReserve ? timeoutMs * HOOK_RESERVE_RATIO : 0)),
});

/** One hook run's race: the budget its handler sees, and the cut its runner settles. */
export interface HookRace {
  readonly budget: HookBudget;
  /**
   * The race was lost: no claim is accepted from here on, and every undo a
   * claim registered so far runs. Answers how many ran; never throws.
   */
  readonly cut: () => Promise<number>;
  /** Whether the handler said its capture was on disk before the race was lost (`budget.captured`). */
  readonly isCaptured: () => boolean;
}

/**
 * `hookBudget` with the cut wired in (review H2). The two mutable cells are
 * this one run's: which undos its claims registered, and whether the race
 * was lost. A claim registers INSIDE its locked transform, so a cut can never
 * fall between a claim and its undo: either the transform ran first and its
 * undo is in the list `cut` runs — and waits for the claim's own write, which
 * holds the lock — or it runs after and sees `isCut`.
 */
export const hookRace = (
  deadlineMs: number,
  timeoutMs: number,
  now: () => number = Date.now,
  holdsReserve = true,
): HookRace => {
  const undos: CutUndo[] = [];
  const lost = { value: false };
  // Said BEFORE the race is lost, or not at all: a capture settled after the
  // cut is one the abandoned handler finished too late to vouch for.
  const captured = { value: false };
  return {
    budget: {
      ...hookBudget(deadlineMs, timeoutMs, now, holdsReserve),
      isCut: () => lost.value,
      onCut: (undo) => {
        undos.push(undo);
      },
      captured: () => {
        captured.value = captured.value || !lost.value;
      },
    },
    cut: async () => {
      lost.value = true;
      const settled = await Promise.allSettled(undos.map((undo) => undo()));
      return settled.length;
    },
    isCaptured: () => captured.value,
  };
};

/**
 * What the race answered, and WHICH side answered it. "" alone cannot say:
 * a handler that chose silence and a handler the budget abandoned return the
 * same string, and only the second one lost telemetry
 * (docs/1.0/loss-accounting.md §3 row 14).
 */
export interface BudgetOutcome {
  readonly output: string;
  /** True when the budget resolved the race: the work was abandoned unfinished. */
  readonly timedOut: boolean;
}

const BUDGET_SPENT: BudgetOutcome = { output: "", timedOut: true };

/**
 * Total-hook budget: a slow hub must never hold the developer's session. The
 * runners read `timedOut` to book the abandoned capture as a loss; the race
 * itself is unchanged.
 */
export const raceHookBudget = async (
  work: Promise<string>,
  budgetMs: number,
): Promise<BudgetOutcome> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<BudgetOutcome>((resolve) => {
    timer = setTimeout(() => resolve(BUDGET_SPENT), budgetMs);
  });
  const finished = work.then((output): BudgetOutcome => ({ output, timedOut: false }));
  try {
    return await Promise.race([finished, budget]);
  } finally {
    clearTimeout(timer);
  }
};

/** The race's answer alone, for callers that have nothing to book. */
export const withBudget = async (
  work: Promise<string>,
  budgetMs: number,
): Promise<string> => (await raceHookBudget(work, budgetMs)).output;

export interface ResolvedHookBudget {
  readonly budgetMs: number;
  /** Per-request timeout: the longest a single hub call can run. */
  readonly timeoutMs: number;
}

/**
 * The budget has to be known before repo identity spawns git, so it comes from
 * the environment plus the stored config — one small file read — rather than
 * from the fully resolved config. The RATIO is the caller's: each connector
 * maps its own host events onto the shared ratio constants.
 */
export const resolveHookBudget = async (
  ratio: number,
  env: Env,
): Promise<ResolvedHookBudget> => {
  const stored = await readStoredConfig(crosscheckHome(env));
  const timeoutMs = resolveTimeoutMs(env, stored);
  return { budgetMs: timeoutMs * ratio, timeoutMs };
};
