/**
 * `crosscheck hook subagent-return` — the SYNC PostToolUse hook, matched on
 * the subagent tools only (SUBAGENT_RETURN_MATCHER; review H1b).
 *
 * WHY A SECOND PostToolUse HOOK. The capture hook is async, and the hooks
 * reference is plain about async output: Claude Code "delivers the
 * `additionalContext` and `systemMessage` fields … to Claude on the next
 * conversation turn. Unlike a synchronous hook's `systemMessage`, neither
 * field is shown to you." A subagent's collision therefore waited for the
 * person's next prompt — after the reply that should have mentioned it. This
 * hook fires the moment a foreground subagent RETURNS, in the main thread,
 * and drains what the subagent queued (hooks/collision-relay.ts): the person
 * sees the line as `systemMessage`, and the main thread's agent reads the
 * facts and the one relay sentence "next to the tool result", before it
 * writes its reply. A background subagent's return arrives as a prompt
 * instead, and UserPromptSubmit drains it there.
 *
 * TINY: no hub call, one state read, at most one locked drain, under
 * SUBAGENT_RETURN_BUDGET_RATIO. A nested subagent's own return (its payload
 * carries `agent_id`) leaves the queue for the main thread.
 */
import { drainCollisionRelay } from "./collision-relay.ts";
import type { HookBudget, HookContext } from "./runner.ts";

export const handleSubagentReturn = async (ctx: HookContext, budget: HookBudget): Promise<string> => {
  const relay = await drainCollisionRelay(ctx, budget);
  return relay.agent.length === 0
    ? ""
    : JSON.stringify({
        systemMessage: relay.person,
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: relay.agent },
      });
};
