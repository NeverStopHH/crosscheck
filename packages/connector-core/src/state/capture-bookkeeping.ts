/**
 * The capture COUNTERS, as one pure state transform (trial findings
 * #17/#18/#20) — the fold every connector owes its session state after a
 * capture attempt, so "N edit-tool fires → M targets" means the same thing on
 * Claude Code, on Cursor and on every ACP agent.
 *
 * WHY IT IS A TRANSFORM AND NOT A HELPER THAT WRITES. Each host batches its
 * ONE mid-session state write differently — Claude folds a heartbeat stamp and
 * a seen-target merge, Cursor folds a heartbeat through its own host session
 * key, ACP has no heartbeat there and keeps an in-memory seen-set twin — so
 * the write stays the caller's (the rule flows/capture-targets.ts already
 * states). This is the part that must NOT differ: the six counters, the two
 * #18 diagnosis fields and the newly-resolved worktree roots. Pure and
 * immutable, so it is unit-testable without git, a hub or a temp home.
 *
 * WHAT EACH FIELD MEANS ACROSS HOSTS, since one of them is Claude-flavoured:
 *   - `editFired` is "this event was an edit", decided by the caller BEFORE
 *     anything can drop, so a foreign or outside-root touch still leaves
 *     "N fires → 0 targets" behind it rather than silence;
 *   - `toolLabel` fills `lastPostToolUseTool`. The field name predates the
 *     other connectors and is kept because old state files must keep parsing
 *     (state/session-state.ts); its value is per host — Claude the
 *     `tool_name`, Cursor the event name `afterFileEdit` (that event carries
 *     no tool name), ACP the ToolCallUpdate `kind` or the agent→client method.
 *     All three are bounded host vocabularies and doctor bounds them again on
 *     display;
 *   - `firstPath` is the path AS THE HOST GAVE IT, not a repo-relative id: the
 *     #18 line has to be able to name a path that never resolved, and such a
 *     path has no repo-relative form to hold.
 */
import { withKnownWorktreeRoot } from "./session-state.ts";
import type { SessionState } from "./session-state.ts";
import type { TouchedRootsResolution } from "../capture/touched-root.ts";

export interface CaptureBookkeepingInput {
  /**
   * The pre-pass result (capture/touched-root.ts), or null when there was
   * nothing to resolve — no paths on this event. Null books no drops and no
   * cache additions, which is exactly what "nothing to resolve" means.
   */
  readonly resolution: TouchedRootsResolution | null;
  /** Targets actually spooled by this invocation. */
  readonly capturedCount: number;
  /** Whether this event was an edit — counted even when everything dropped. */
  readonly editFired: boolean;
  /** Host label for `lastPostToolUseTool`; null keeps the previous one. */
  readonly toolLabel: string | null;
  /** The first touched path as the host spelled it, or null when there was none. */
  readonly firstPath: string | null;
  readonly now: Date;
}

/**
 * Folds one capture attempt's counters into `state`. Call it INSIDE the
 * caller's single locked `updateSessionState` transform, on the FRESH state —
 * never on a snapshot read before the capture, or a sibling hook's write made
 * inside that window is erased (the Claude state-race lesson).
 */
export const withCaptureBookkeeping = (
  state: SessionState,
  input: CaptureBookkeepingInput,
): SessionState => {
  let next = state;
  for (const entry of input.resolution?.newlyResolved ?? []) {
    next = withKnownWorktreeRoot(next, entry.root, entry.repoId, entry.attempts);
  }
  return {
    ...next,
    editToolFires: next.editToolFires + (input.editFired ? 1 : 0),
    targetsCapturedCount: next.targetsCapturedCount + input.capturedCount,
    ...(input.capturedCount > 0 ? { lastTargetAt: input.now.toISOString() } : {}),
    lastPostToolUseTool: input.toolLabel ?? next.lastPostToolUseTool,
    foreignRepoDrops: next.foreignRepoDrops + (input.resolution?.foreignDrops ?? 0),
    outsideRootDrops: next.outsideRootDrops + (input.resolution?.outsideDrops ?? 0),
    ...(input.editFired && input.firstPath !== null
      ? {
          lastEditedPath: input.firstPath,
          lastEditedPathResolvedAgainst: input.resolution?.firstResolvedRoot ?? null,
        }
      : {}),
  };
};
