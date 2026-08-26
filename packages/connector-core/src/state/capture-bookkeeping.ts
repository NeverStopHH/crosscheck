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
import { containsSecret } from "../capture/secret-scan.ts";
import {
  DOCTOR_PATH_MAX_CHARS,
  DOCTOR_TOOL_NAME_MAX_CHARS,
} from "../constants.ts";
import type { TouchedRootsResolution } from "../capture/touched-root.ts";

/**
 * Bounds one agent-chosen diagnosis string to what can ever be DISPLAYED.
 *
 * Same rule and same DIRECTION as doctor's own `boundedLocal` — control
 * characters stripped, the TAIL kept behind an ellipsis, because the end of a
 * path is the informative half. A value that already fits is returned
 * byte-for-byte, so for every real path and tool name this is invisible; a
 * value that does not fit is stored exactly as doctor would have rendered it,
 * so the reader sees the same line either way and the state file stops being
 * a place an agent can park a megabyte.
 *
 * Deliberately a second copy of that rule rather than a shared import: this
 * one bounds what is WRITTEN (connector-core, on the untrusted boundary), the
 * renderer bounds what is SHOWN (cli, which may not be imported from here).
 */
const boundedLabel = (value: string | null, max: number): string | null => {
  if (value === null) {
    return null;
  }
  const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, "");
  return clean.length <= max ? clean : `…${clean.slice(clean.length - (max - 1))}`;
};

export interface CaptureBookkeepingInput {
  /**
   * The pre-pass result (capture/touched-root.ts), or null when there was
   * nothing to resolve — no paths on this event. Null books no drops and no
   * cache additions, which is exactly what "nothing to resolve" means.
   */
  readonly resolution: TouchedRootsResolution | null;
  /** Targets actually spooled by this invocation. */
  readonly capturedCount: number;
  /**
   * Whether this event was an edit — counted even when everything dropped,
   * and the gate on whether the resolution's targets and drops count as
   * evidence about edit capture at all (argued in the fold below).
   */
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
  // The cache is a cache: a root a READ taught the session is just as true as
  // one an edit taught it, and re-judging it would pay git twice.
  for (const entry of input.resolution?.newlyResolved ?? []) {
    next = withKnownWorktreeRoot(
      next,
      entry.root,
      entry.repoId,
      entry.attempts,
      entry.stamp,
    );
  }
  // WHAT THE RATIO IS DIVIDED BY MUST ALSO BE EDITS. `editToolFires` counts
  // edits, so a target or a drop only counts as evidence about EDIT capture
  // when the event that produced it was an edit. Claude and Cursor cannot tell
  // the difference — no non-edit event there carries a file path — but ACP is
  // a host where `tool_call kind: "read"` arrives with `locations`, and there
  // both halves were dishonest: three in-repo reads fed `targetsCapturedCount`
  // while `editToolFires` counted only edits, which put
  // `isCaptureSilentlyDead` (fires >= DOCTOR_CAPTURE_SILENT_FIRES_WARN AND
  // targets === 0) out of reach for the rest of the session — the PASS-only
  // telemetry these counters exist to end — and one read of a second connected
  // repo raised the machine-wide `foreign-repo drops` WARN, telling a
  // developer who had edited nothing to re-open a workspace.
  //
  // A non-edit touch still SPOOLS its targets and still stamps `lastTargetAt`:
  // it is real work context, it is simply not evidence about whether edit
  // capture is alive.
  const evidence = input.editFired ? input.resolution : null;
  // THESE TWO FIELDS ARE THE ONLY AGENT-CHOSEN STRINGS THIS TRANSFORM STORES,
  // and on ACP the agent is the party the proxy exists to be transparent TO,
  // not to trust: `firstPath` is a `locations[].path` off the wire and the
  // label is the agent's own `kind`. Bounded and screened here, at the one
  // place all three hosts share, so Claude and Cursor are covered with it.
  const diagnosisPath =
    input.firstPath === null || containsSecret(input.firstPath)
      ? null
      : boundedLabel(input.firstPath, DOCTOR_PATH_MAX_CHARS);
  return {
    ...next,
    editToolFires: next.editToolFires + (input.editFired ? 1 : 0),
    targetsCapturedCount:
      next.targetsCapturedCount + (input.editFired ? input.capturedCount : 0),
    ...(input.capturedCount > 0 ? { lastTargetAt: input.now.toISOString() } : {}),
    lastPostToolUseTool:
      boundedLabel(input.toolLabel, DOCTOR_TOOL_NAME_MAX_CHARS) ??
      next.lastPostToolUseTool,
    foreignRepoDrops: next.foreignRepoDrops + (evidence?.foreignDrops ?? 0),
    outsideRootDrops: next.outsideRootDrops + (evidence?.outsideDrops ?? 0),
    ...(input.editFired && diagnosisPath !== null
      ? {
          lastEditedPath: diagnosisPath,
          lastEditedPathResolvedAgainst: input.resolution?.firstResolvedRoot ?? null,
        }
      : {}),
  };
};
