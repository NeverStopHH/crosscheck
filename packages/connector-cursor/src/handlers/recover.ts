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
): Promise<SessionState | null> => {
  const stored = await readSessionState(ctx.config.home, ctx.hostSessionKey);
  if (stored !== null) {
    if (stored.repoId !== ctx.identity.repoId) {
      await updateSessionState(ctx.config.home, ctx.hostSessionKey, (fresh) => ({
        ...fresh,
        foreignRepoDrops: fresh.foreignRepoDrops + 1,
      }));
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
    now: ctx.now(),
  });
  // The flow wrote the state file before any append; reading it back gives
  // the schema-defaulted SessionState every later transform expects.
  return readSessionState(ctx.config.home, ctx.hostSessionKey);
};
