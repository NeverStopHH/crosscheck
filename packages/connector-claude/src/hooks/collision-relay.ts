/**
 * THE MAIN THREAD'S SHARE OF A SUBAGENT'S COLLISION (pilot, 2026-10-07: 91%
 * of the owner's edits were made by subagents). hooks/pre-tool-use.ts queues
 * the teammate groups a subagent ran into; this drains the queue for the
 * MAIN thread, once, from whichever of its sync hooks gets there first —
 * UserPromptSubmit (which also fires when a background subagent reports
 * back) or the PostToolUse hook on the subagent tools, which fires the moment
 * a foreground subagent RETURNS (hooks/subagent-return.ts).
 *
 * TWO COPIES OF ONE FACT: the agent's (a header, the lines, the one relay
 * sentence) and the PERSON'S (the lines alone, for `systemMessage`). Both are
 * rendered by core hints/collision-notice.ts; this module composes nothing.
 */
import { renderCollisionNotices, renderSubagentCollisionRelay } from "@crosscheck/connector-core/hints/collision-notice.ts";
import {
  readSessionState,
  updateSessionState,
  withDrainedCollisionRelays,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { CollisionNotice } from "@crosscheck/connector-core/state/session-state.ts";
import type { HookBudget, HookContext } from "./runner.ts";

export interface CollisionRelay {
  /** The main thread's copy: header, one line per group, the one request. */
  readonly agent: string;
  /** The person's copy: the lines alone, for `systemMessage`. */
  readonly person: string;
}

export const NO_RELAY: CollisionRelay = { agent: "", person: "" };

/**
 * The queue taken and emptied in ONE locked transform, so a racing sibling
 * finds it empty, and only groups still remembered are said. A hook inside a
 * subagent (its payload carries `agent_id`) leaves the queue for the main
 * thread. Drained only while the spare budget lasts (review L3): a queue left
 * alone waits for the next hook, a queue drained into an abandoned hook is
 * lost. Fail open: a busy lock relays later, never twice.
 */
export const drainCollisionRelay = async (ctx: HookContext, budget: HookBudget): Promise<CollisionRelay> => {
  try {
    if (ctx.payload.agent_id !== undefined || budget.spareMs() <= 0) {
      return NO_RELAY;
    }
    const state = await readSessionState(ctx.config.home, ctx.payload.session_id);
    if (state === null || (state.collisionRelayQueue ?? []).length === 0) {
      return NO_RELAY;
    }
    const taken: { value: readonly CollisionNotice[] } = { value: [] };
    const drained = await updateSessionState(ctx.config.home, ctx.payload.session_id, (fresh) => {
      const queue = fresh.collisionRelayQueue ?? [];
      if (queue.length === 0) {
        return null;
      }
      taken.value = (fresh.collisionNotices ?? []).filter((notice) => queue.includes(notice.key));
      return withDrainedCollisionRelays(fresh);
    });
    return drained && taken.value.length > 0
      ? {
          agent: renderSubagentCollisionRelay(taken.value, ctx.now()),
          person: renderCollisionNotices(taken.value, ctx.now()),
        }
      : NO_RELAY;
  } catch {
    // Fail open: the hosting hook's own job is untouched.
    return NO_RELAY;
  }
};
