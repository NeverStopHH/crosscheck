/**
 * stop (§3.2 row 6) — until the derive rungs landed this handler only counted
 * the turn and flushed. It now carries the two things Cursor's turn boundary
 * is the right place for, both of them deterministic and local:
 *
 *   1. THE TIER-1 GATE (derive/triggers.ts runCursorSummarizerGate), which
 *      also does the turn count: cheap regexes over the transcript tail, the
 *      fire recorded under the state lock BEFORE the detached worker is
 *      spawned, and a turn with no readable slice booked as its own named
 *      outcome rather than as a runner failure. The turn count moved INTO
 *      that one locked write on purpose — counting the turn and deciding the
 *      fire in two separate locked writes is how a racing sibling gets to see
 *      a turn count that its own debounce check has not seen.
 *   2. THE GHOST DEBT, paid here or on postToolUse, whichever fires first
 *      (derive/triggers.ts states why Cursor needs both).
 *
 * NEVER `followup_message`: auto-continuing the user's session is not ours to
 * do, and the handler suite pins the absence.
 *
 * No recovery here — the Claude Stop rule: a turn count is never worth a
 * register.
 */
import { flushSpool } from "@crosscheck/connector-core/spool/flush.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import type { HookBudget } from "@crosscheck/connector-core/config/hook-budget.ts";

import type { CursorHookContext } from "../runner.ts";
import {
  maybeSpawnCursorGhostWorker,
  runCursorSummarizerGate,
} from "../derive/triggers.ts";

export const handleCursorStop = async (
  ctx: CursorHookContext,
  budget: HookBudget,
): Promise<string> => {
  const state = await readSessionState(ctx.config.home, ctx.hostSessionKey);
  if (state === null) {
    return "";
  }
  // The gate counts the turn, so it runs even when nothing can fire.
  await runCursorSummarizerGate(ctx);
  await maybeSpawnCursorGhostWorker(ctx);
  await flushSpool(
    ctx.hub,
    { sessionId: state.crosscheckSessionId, developerId: state.developerId },
    budget.spareMs(),
  );
  return "";
};
