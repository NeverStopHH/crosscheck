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
 *
 * AND TINY BEFORE THE RUNNER TOO (round 2, M2): the runner's preparation —
 * repo identity (four git spawns), the config read, the fired marker — ran
 * on the main thread for EVERY Agent/Task call, most of them a background
 * launch with nothing queued: a median of 135 ms against a 64 ms bare start.
 * `hasNothingToRelay` answers first, from the payload and the state file
 * alone, and the runner returns before preparing anything.
 */
import { crosscheckHome } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { parseHookPayload } from "../capture/tool-events.ts";
import { agentCopy, drainCollisionRelay, hasPendingRelay, personCopy } from "./collision-relay.ts";
import type { HookBudget, HookContext } from "./runner.ts";

/** `tool_response.status` of an Agent call that started a BACKGROUND subagent and returned at once. */
const ASYNC_LAUNCHED = "async_launched";

const isAsyncLaunch = (response: unknown): boolean =>
  typeof response === "object" && response !== null && (response as { readonly status?: unknown }).status === ASYNC_LAUNCHED;

/**
 * Whether this subagent-return fire has nothing to do — answered with no git,
 * no config and no write: an unreadable payload, a nested subagent's own
 * return (`agent_id`), a background LAUNCH (its subagent has not run yet; it
 * reports back as a prompt), or a session with nothing queued. Anything it
 * cannot read for certain falls through to the full hook.
 */
export const hasNothingToRelay = async (stdin: string, env: Env): Promise<boolean> => {
  try {
    const payload = parseHookPayload(stdin);
    if (payload === null || payload.agent_id !== undefined || isAsyncLaunch(payload.tool_response)) {
      return true;
    }
    const state = await readSessionState(crosscheckHome(env), payload.session_id);
    return state === null || !hasPendingRelay(state);
  } catch {
    return false;
  }
};

export const handleSubagentReturn = async (ctx: HookContext, budget: HookBudget): Promise<string> => {
  const drain = await drainCollisionRelay(ctx, budget);
  const agent = agentCopy(drain, ctx.now());
  return agent.length === 0
    ? ""
    : JSON.stringify({
        systemMessage: personCopy(drain, ctx.now()),
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: agent },
      });
};
