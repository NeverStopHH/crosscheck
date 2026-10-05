import { sessionHealer } from "@crosscheck/connector-core/flows/heal-session.ts";
import type { RefusalCause, SessionHealer } from "@crosscheck/connector-core/flows/heal-session.ts";
import { guaranteeDeclarationFor } from "@crosscheck/connector-core/guarantees/declarations.ts";
import type { HookBudget } from "@crosscheck/connector-core/config/hook-budget.ts";
import type { CursorHookContext } from "../runner.ts";

/**
 * The mid-life heal (core flows/heal-session.ts) for this conversation: a
 * reopened chat keeps its `conversation_id`, and a sessionEnd that ran in
 * another window ends the crosscheck session under it. The capture handlers
 * hand this to their flush and their heartbeat; sessionStart walks the ladder
 * itself, and sessionEnd has no life left to heal.
 */
export const healerFor = (ctx: CursorHookContext): SessionHealer =>
  sessionHealer({
    home: ctx.config.home,
    repoKey: ctx.repoKey,
    hub: ctx.hub,
    agentKind: ctx.config.agentKind,
    hostSessionKey: ctx.hostSessionKey,
    repoId: ctx.identity.repoId,
    branch: ctx.identity.branch,
    baseCommit: ctx.identity.baseCommit,
    guarantees: guaranteeDeclarationFor("cursor-ide"),
    now: ctx.now,
  });

/** A refused heartbeat, healed on the handler's leftover (`spareMs`) only. */
export const onRefusedHeartbeat =
  (ctx: CursorHookContext, budget: HookBudget, crosscheckSessionId: string) =>
  (cause: RefusalCause): Promise<unknown> =>
    healerFor(ctx)({ sessionId: crosscheckSessionId, cause }, Date.now() + budget.spareMs());
