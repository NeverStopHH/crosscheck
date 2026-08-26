/**
 * Session-state recovery for mid-conversation hooks — the Claude
 * post-tool-use `recoverState` need, answered with the SHARED register flow
 * instead of a package copy: `registerSessionFlow` already is "derive
 * deterministic ids → register (+409 retry) → state BEFORE append → work
 * context record", which is exactly what reconstruction needs. Two Cursor
 * realities make this path live: hooks installed mid-conversation (no
 * sessionStart ever fired here), and a conversation REOPENED after its
 * sessionEnd (same conversation_id, hub session already ended — the flow's
 * `~r1` retry mints the fresh session Claude's recovery cannot).
 */
import { fallbackWorkContextTitle, registerSessionFlow } from "@crosscheck/connector-core/flows/register-session.ts";
import {
  readSessionState,
  updateSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";

import type { CursorHookContext } from "../runner.ts";

export const IMPLEMENTING_STATUS = "implementing";

export interface RequireSessionStateOptions {
  /**
   * Whether the event that is asking IS an edit. The Claude twin counts the
   * fire in hooks/post-tool-use.ts BEFORE its foreign-repo guard can return,
   * for one reason: a conversation whose workspace resolves to a foreign repo
   * would otherwise print `0 edit-tool fires -> 0 targets` and PASS — the
   * exact silence these counters exist to end. Only afterFileEdit passes
   * true; the shell, postToolUse and failure rows are not edits and must not
   * inflate the ratio the doctor WARN is measured on.
   */
  readonly editFired?: boolean;
  /**
   * What `lastPostToolUseTool` should read for the event that is asking — the
   * event NAME on this host, since no Cursor hook payload carries a tool name
   * (handlers/file-edit.ts). Passed in rather than imported so this module
   * keeps no edge back to the handlers that call it.
   */
  readonly toolLabel?: string;
  /** The path the event touched, as the host spelled it (edits only). */
  readonly touchedPath?: string;
}

/**
 * The first-wins drop, booked AND named.
 *
 * The counters alone made a doctor line that contradicted itself: the drop
 * counts are rendered only inside doctor's `lastEditedPath !== null` branch,
 * so a conversation dropping here printed `3 edit-tool fires -> 0 targets ...
 * last tool none yet - last edited path resolved: no edit yet`, with the three
 * foreign drops nowhere on the line. Three claims about a session that had
 * just fired three edits, on the one surface a developer is asked to paste.
 *
 * The drop itself is counted whatever the event was, unlike the per-path
 * resolution drops (connector-core/state/capture-bookkeeping.ts folds those
 * only for an edit): this is not a touch that failed to resolve, it is the
 * whole SESSION being bound to another repo, which is equally true of a shell
 * row. The #18 diagnosis fields still describe the last EDIT only, and only
 * when no real capture has already described one.
 */
const withForeignRepoDrop = (
  fresh: SessionState,
  options: RequireSessionStateOptions,
): SessionState => ({
  ...fresh,
  foreignRepoDrops: fresh.foreignRepoDrops + 1,
  // Counted BEFORE the drop, exactly as the Claude hook does.
  editToolFires: fresh.editToolFires + (options.editFired === true ? 1 : 0),
  lastPostToolUseTool: options.toolLabel ?? fresh.lastPostToolUseTool,
  // Fill an EMPTY #18 diagnosis, never overwrite one: a drop must not erase a
  // path a real capture resolved (the Claude twin pins that in
  // connector-claude/test/worktree-capture.test.ts), and it must not leave a
  // conversation that has fired N edits saying `no edit yet` either.
  ...(options.editFired === true &&
  options.touchedPath !== undefined &&
  fresh.lastEditedPath === null
    ? {
        lastEditedPath: options.touchedPath,
        // It resolved against nothing: the repo it belongs to is not this
        // session's, which is what the line has to be able to say.
        lastEditedPathResolvedAgainst: null,
      }
    : {}),
});

/**
 * The stored state, or the state a fresh register just wrote — null only
 * when even the flow could not produce one (fail open, capture skipped) or
 * when the touch belongs to a DIFFERENT repo than the session registered
 * with (first-wins, trial finding #9 — the Claude post-tool-use guard's
 * twin): one conversation is ONE crosscheck session bound to one repo, so a
 * foreign-repo touch is dropped and counted rather than captured under the
 * wrong repo.
 */
export const requireSessionState = async (
  ctx: CursorHookContext,
  options: RequireSessionStateOptions = {},
): Promise<SessionState | null> => {
  const stored = await readSessionState(ctx.config.home, ctx.hostSessionKey);
  if (stored !== null) {
    if (stored.repoId !== ctx.identity.repoId) {
      await updateSessionState(ctx.config.home, ctx.hostSessionKey, (fresh) =>
        withForeignRepoDrop(fresh, options),
      );
      return null;
    }
    return stored;
  }
  await registerSessionFlow({
    home: ctx.config.home,
    repoKey: ctx.repoKey,
    hub: ctx.hub,
    agentKind: ctx.config.agentKind,
    hostSessionKey: ctx.hostSessionKey,
    repoId: ctx.identity.repoId,
    repoRoot: ctx.identity.root,
    branch: ctx.identity.branch,
    baseCommit: ctx.identity.baseCommit,
    hubUrl: ctx.config.hubUrl,
    fallbackDeveloperId: ctx.config.developerId,
    // No host title exists on this path (and never from prompt text — the
    // §2.4 privacy posture): branch @ repo, the honest fallback.
    title: fallbackWorkContextTitle(ctx.identity.branch, ctx.identity.repoId),
    status: IMPLEMENTING_STATUS,
    // State-less reconstruction: stop the ladder on repo_mismatch, CLAIM the
    // state file rather than overwrite a racing sibling's (flow header).
    recovery: true,
    // No sessionStart ever briefed this conversation (that is what made this
    // recovery live), so the debt is recorded atomically with the claim; the
    // NEXT injection-capable hook pays it (inject/deferred-briefing.ts) —
    // never this invocation, which already spent a register round trip
    // (test/briefing-parity.test.ts pins both halves).
    briefingPending: true,
    now: ctx.now(),
  });
  // The flow published state before any append — or ADOPTED a sibling's, or
  // (repo_mismatch, busy lock) wrote nothing at all. Reading it back gives
  // the schema-defaulted SessionState every later transform expects, and the
  // first-wins check re-runs against what is actually on disk: a sibling may
  // have bound this conversation to a DIFFERENT repo during our register
  // round-trip (handlers.test.ts, the recovery-race parity pin).
  const state = await readSessionState(ctx.config.home, ctx.hostSessionKey);
  if (state === null) {
    return null;
  }
  if (state.repoId !== ctx.identity.repoId) {
    await updateSessionState(ctx.config.home, ctx.hostSessionKey, (fresh) =>
      withForeignRepoDrop(fresh, options),
    );
    return null;
  }
  return state;
};
