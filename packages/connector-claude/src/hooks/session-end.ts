import { endSessionFlow } from "@crosscheck/connector-core/flows/end-session.ts";
import {
  crosscheckSessionIdFor,
  readSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { HookBudget, HookContext } from "./runner.ts";

/**
 * The whole SessionEnd body is the §1.3 `endSessionFlow`
 * (flows/end-session.ts): flush → pending-end marker → state delete → `end`
 * only when nothing undelivered remains. The ordering arguments live with
 * the flow now; what stays HERE is Claude-side identity resolution and the
 * budget policy — the drain gets `spareMs` only, what is left after
 * reserving one request timeout for the `end` call. With the whole budget it
 * took the hook: measured through the binary with a 600-record backlog and a
 * 350 ms hub, SessionEnd ran 831 ms, sent no `end`, and never reached the
 * state delete — which also left that spool unreapable, since reap reads a
 * state file as a live writer.
 */
export const handleSessionEnd = async (
  ctx: HookContext,
  budget: HookBudget,
): Promise<string> => {
  const stored = await readSessionState(ctx.config.home, ctx.payload.session_id);
  await endSessionFlow({
    home: ctx.config.home,
    repoKey: ctx.repoKey,
    hub: ctx.hub,
    hostSessionKey: ctx.payload.session_id,
    crosscheckSessionId:
      stored?.crosscheckSessionId ??
      crosscheckSessionIdFor(ctx.payload.session_id),
    developerId: stored?.developerId ?? ctx.config.developerId,
    flushBudgetMs: budget.spareMs(),
    now: ctx.now,
  });
  return "";
};