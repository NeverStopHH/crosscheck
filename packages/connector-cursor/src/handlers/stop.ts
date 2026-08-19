/**
 * stop (§3.2 row 6): count the turn (the future Tier-1 gate reads
 * stopTurnCount — the same core state field Claude's summarizer gate uses),
 * flush the spool on the spare budget. NEVER `followup_message`:
 * auto-continuing the user's session is not ours to do, and the handler
 * suite pins the absence.
 *
 * No recovery here — the Claude Stop rule: a turn count is never worth a
 * register.
 */
import { flushSpool } from "@crosscheck/connector-core/spool/flush.ts";
import {
  readSessionState,
  updateSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { HookBudget } from "@crosscheck/connector-core/config/hook-budget.ts";

import type { CursorHookContext } from "../runner.ts";

export const handleCursorStop = async (
  ctx: CursorHookContext,
  budget: HookBudget,
): Promise<string> => {
  const state = await readSessionState(ctx.config.home, ctx.hostSessionKey);
  if (state === null) {
    return "";
  }
  await updateSessionState(ctx.config.home, ctx.hostSessionKey, (fresh) => ({
    ...fresh,
    stopTurnCount: fresh.stopTurnCount + 1,
  }));
  await flushSpool(
    ctx.hub,
    { sessionId: state.crosscheckSessionId, developerId: state.developerId },
    budget.spareMs(),
  );
  return "";
};
