/**
 * sessionEnd (§3.2 row 7): the whole body is the shared `endSessionFlow` —
 * flush → pending-end marker → state delete → `end` only when nothing
 * undelivered remains (else reap's DeferredEnder finishes it later). What
 * stays here is identity resolution (deterministic fallback when no state
 * file survives) and the budget policy: the drain gets `spareMs` only.
 */
import { endSessionFlow } from "@crosscheck/connector-core/flows/end-session.ts";
import {
  crosscheckSessionIdFor,
  readSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { HookBudget } from "@crosscheck/connector-core/config/hook-budget.ts";

import type { CursorHookContext } from "../runner.ts";

export const handleCursorSessionEnd = async (
  ctx: CursorHookContext,
  budget: HookBudget,
): Promise<string> => {
  const stored = await readSessionState(ctx.config.home, ctx.hostSessionKey);
  await endSessionFlow({
    home: ctx.config.home,
    repoKey: ctx.repoKey,
    hub: ctx.hub,
    hostSessionKey: ctx.hostSessionKey,
    crosscheckSessionId:
      stored?.crosscheckSessionId ?? crosscheckSessionIdFor(ctx.hostSessionKey),
    developerId: stored?.developerId ?? ctx.config.developerId,
    flushBudgetMs: budget.spareMs(),
    now: ctx.now,
  });
  return "";
};
