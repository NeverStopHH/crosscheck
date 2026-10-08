/**
 * THE MAIN THREAD'S SHARE OF A SUBAGENT'S COLLISION (pilot, 2026-10-07: 91%
 * of the owner's edits were made by subagents). hooks/pre-tool-use.ts queues
 * the teammate groups a subagent ran into; this drains the queue for the
 * MAIN thread, once, from whichever of its sync hooks gets there first —
 * unnamed only when a presence answer omits the teammate —
 * UserPromptSubmit (which also fires when a background subagent reports
 * back) or the PostToolUse hook on the subagent tools, which fires the moment
 * a foreground subagent RETURNS (hooks/subagent-return.ts).
 *
 * TWO COPIES OF ONE FACT: the agent's (a header, every line, the one relay
 * sentence) and the PERSON'S (the lines alone, for `systemMessage`, in ONE
 * bounded render with whatever else the same hook tells the person — a paid
 * briefing's ghost rows; round 2, L4). Both are rendered by core
 * hints/collision-notice.ts; this module composes nothing.
 */
import {
  relayedCollisions,
  renderCollisionNotices,
  renderSubagentCollisionRelay,
} from "@crosscheck/connector-core/hints/collision-notice.ts";
import type { RenderableCollision } from "@crosscheck/connector-core/hints/collision-notice.ts";
import { RELAY_PRESENCE_REFRESH_MS } from "@crosscheck/connector-core/constants.ts";
import type { PresenceEntry } from "@crosscheck/connector-core/http/hub.ts";
import { isCacheFresh, readPresenceCache } from "@crosscheck/connector-core/state/presence-cache.ts";
import { refreshPresence } from "./presence-refresh.ts";
import {
  readSessionState,
  updateSessionState,
  withDrainedCollisionRelays,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { CollisionNotice, SessionState } from "@crosscheck/connector-core/state/session-state.ts";
import type { HookBudget, HookContext } from "./runner.ts";

/** What one drain hands the main thread. */
export interface RelayDrain {
  /** The queued groups as the main thread is told them — unnamed only where presence omits the teammate. */
  readonly groups: readonly RenderableCollision[];
  /** Queued groups the record could only count (round 2, L6). */
  readonly hidden: number;
}

export const NO_DRAIN: RelayDrain = { groups: [], hidden: 0 };

/** The main thread's copy: header, every line, the count, the one request — "" when nothing drained. */
export const agentCopy = (drain: RelayDrain, now: Date): string =>
  renderSubagentCollisionRelay(drain.groups, now, drain.hidden);

/**
 * The person's copy: the drained lines AND `alsoTold` — the other groups the
 * same hook tells the person — through ONE `renderCollisionNotices`, so one
 * `systemMessage` keeps one cap of lines and characters (round 2, L4).
 */
export const personCopy = (drain: RelayDrain, now: Date, alsoTold: readonly RenderableCollision[] = []): string =>
  renderCollisionNotices([...drain.groups, ...alsoTold], now, drain.hidden);

/**
 * THE PRESENCE ANSWER a drained group is held to (review M2, round 2 H1 as
 * refined): a FRESH cache is that answer, and one local read. Otherwise the
 * relay asks ONCE — the statusline's own call and cache
 * (hooks/presence-refresh.ts), bounded by RELAY_PRESENCE_REFRESH_MS, the
 * request timeout and what the budget spares — because a subagent that ran
 * longer than the 10 s cache, in a session with no statusline render between
 * (every IDE session), would otherwise have no answer at all. Null when none
 * could be had: the refresh failed or ran out of time, or no time was left.
 * A stale cache never decides anything by itself.
 */
const presenceAnswer = async (ctx: HookContext, budget: HookBudget): Promise<readonly PresenceEntry[] | null> => {
  const now = ctx.now();
  const cache = await readPresenceCache(ctx.config.home, ctx.repoKey);
  if (cache !== null && isCacheFresh(cache, now)) {
    return cache.entries;
  }
  const timeoutMs = Math.min(RELAY_PRESENCE_REFRESH_MS, ctx.hub.timeoutMs, budget.spareMs());
  if (timeoutMs <= 0) {
    return null;
  }
  const result = await refreshPresence(ctx, timeoutMs, cache);
  return result.ok ? result.data : null;
};

/** What a drain took: the queued groups still remembered, and how many it could only count. */
interface TakenRelay {
  readonly groups: readonly CollisionNotice[];
  readonly hidden: number;
}

const NOTHING_TAKEN: TakenRelay = { groups: [], hidden: 0 };

/** Whether a state has anything for the main thread: a queued key, or a drop to own up to. */
export const hasPendingRelay = (state: SessionState): boolean =>
  (state.collisionRelayQueue ?? []).length > 0 || (state.collisionRelayDropped ?? 0) > 0;

/**
 * The queued groups the record still holds, and the rest COUNTED (round 2,
 * L6): those the cap had to drop, and any queue key whose group is gone.
 */
const takenFrom = (state: SessionState): TakenRelay => {
  const queue = state.collisionRelayQueue ?? [];
  const groups = (state.collisionNotices ?? []).filter((notice) => queue.includes(notice.key));
  return { groups, hidden: (state.collisionRelayDropped ?? 0) + queue.length - groups.length };
};

/**
 * The presence answer the drained groups will be held to, asked BEFORE the
 * queue is emptied (round 3, F-M1): drained first, a refresh that threw or a
 * hook abandoned while it waited on the hub — up to RELAY_PRESENCE_REFRESH_MS
 * — lost groups already recorded as told. Asked from the unlocked read: the
 * answer is the repo's, so a group a racing sibling queues before the drain
 * is held to it too. No queued group still remembered, no presence call: a
 * drain that only owns up to dropped groups asks the hub nothing.
 */
const answerBeforeDrain = async (
  ctx: HookContext,
  state: SessionState,
  budget: HookBudget,
): Promise<readonly PresenceEntry[] | null> =>
  takenFrom(state).groups.length === 0 ? null : presenceAnswer(ctx, budget);

/**
 * The queue taken and emptied in ONE locked transform, so a racing sibling
 * finds it empty, and only groups still remembered are said — the rest are
 * counted into the `+N more` line. A hook inside a subagent (its payload
 * carries `agent_id`) leaves the queue for the main thread. Drained only
 * while the spare budget lasts (review L3): a queue left alone waits for the
 * next hook. Everything slow comes BEFORE the drain and nothing after it can
 * throw — the groups are held to presence by a pure function — so only the
 * output's own last step stands between an emptied queue and the person.
 * Fail open: a busy lock relays later, never twice.
 */
export const drainCollisionRelay = async (ctx: HookContext, budget: HookBudget): Promise<RelayDrain> => {
  try {
    if (ctx.payload.agent_id !== undefined || budget.spareMs() <= 0) {
      return NO_DRAIN;
    }
    const state = await readSessionState(ctx.config.home, ctx.payload.session_id);
    if (state === null || !hasPendingRelay(state)) {
      return NO_DRAIN;
    }
    const answer = await answerBeforeDrain(ctx, state, budget);
    const taken: { value: TakenRelay } = { value: NOTHING_TAKEN };
    const drained = await updateSessionState(ctx.config.home, ctx.payload.session_id, (fresh) => {
      if (!hasPendingRelay(fresh)) {
        return null;
      }
      taken.value = takenFrom(fresh);
      return withDrainedCollisionRelays(fresh);
    });
    return drained
      ? { groups: relayedCollisions(taken.value.groups, answer, ctx.now()), hidden: taken.value.hidden }
      : NO_DRAIN;
  } catch {
    // Fail open: the hosting hook's own job is untouched.
    return NO_DRAIN;
  }
};
