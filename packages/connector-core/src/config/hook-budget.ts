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
 */
export interface HookBudget {
  readonly spareMs: () => number;
}

/**
 * The reserve as arithmetic: what is LEFT of the hook's deadline, minus one
 * per-request timeout, floored at zero.
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
): HookBudget => ({
  spareMs: () =>
    Math.max(0, deadlineMs - now() - timeoutMs * HOOK_RESERVE_RATIO),
});

/** Total-hook budget: a slow hub must never hold the developer's session. */
export const withBudget = async (
  work: Promise<string>,
  budgetMs: number,
): Promise<string> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(""), budgetMs);
  });
  try {
    return await Promise.race([work, budget]);
  } finally {
    clearTimeout(timer);
  }
};

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
