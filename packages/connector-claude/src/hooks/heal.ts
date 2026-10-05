import { sessionHealer } from "@crosscheck/connector-core/flows/heal-session.ts";
import type { SessionHealer } from "@crosscheck/connector-core/flows/heal-session.ts";
import { guaranteeDeclarationFor } from "@crosscheck/connector-core/guarantees/declarations.ts";
import type { HookBudget, HookContext } from "./runner.ts";

/**
 * The mid-life heal (core flows/heal-session.ts) for THIS hook's host session:
 * what SessionStart would register, from what the hook already resolved. The
 * hooks that capture hand it to their flush and their heartbeat; SessionStart
 * walks the ladder itself, and SessionEnd has no life left to heal.
 */
export const healerFor = (ctx: HookContext): SessionHealer =>
  sessionHealer({
    home: ctx.config.home,
    repoKey: ctx.repoKey,
    hub: ctx.hub,
    agentKind: ctx.config.agentKind,
    hostSessionKey: ctx.payload.session_id,
    repoId: ctx.identity.repoId,
    branch: ctx.identity.branch,
    baseCommit: ctx.identity.baseCommit,
    guarantees: guaranteeDeclarationFor("claude-code"),
    now: ctx.now,
  });

/**
 * The heartbeat's refusal, healed on the hook's leftover: `spareMs` at the
 * moment the hub refused, so the walk never eats the reserve that carries the
 * hook's own output and its last state write.
 */
export const onRefusedHeartbeat =
  (ctx: HookContext, budget: HookBudget, crosscheckSessionId: string) =>
  (): Promise<unknown> =>
    healerFor(ctx)(crosscheckSessionId, Date.now() + budget.spareMs());
