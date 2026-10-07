/**
 * SubagentStop hook — the git lane over the subagent's own root (DESIGN.md
 * "One session, many topics").
 *
 * WHY A HOOK OF ITS OWN. Subagents make most of a long-lived session's edits
 * — 91% in the owner's — and each works in a worktree of its own, much of it
 * through a shell. Their Edit calls reach PostToolUse under the parent's
 * session id, but what their shell did (`cp`, `mv`, a generator, a commit)
 * reached nothing until the parent's next Stop, which sweeps what it can
 * reach in its own budget and may come hours later, after a revert. Sweeping
 * the subagent's root the moment it finishes captures that work under the
 * subagent's topic while it is still on disk.
 *
 * WHAT IT SWEEPS: the root of the payload's cwd first, then the roots a shell
 * touched (hooks/post-tool-use.ts marks them) — never the full sweep, which is
 * Stop's to make once per turn (core flows/git-lane.ts `selectGitLaneRoots`).
 *
 * ASYNC, like Stop (cli/settings-merge.ts): it answers nothing, so the
 * subagent's parent never waits on it.
 */
import { flushSpool } from "@crosscheck/connector-core/spool/flush.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { ownCwdRoot, runGitLane } from "./git-lane.ts";
import { healerFor } from "./heal.ts";
import type { HookBudget, HookContext } from "./runner.ts";

/** The capture-loss detail for a SubagentStop lane git did not answer (review M5). */
const SUBAGENT_GIT_LANE_LOSS_DETAIL = "subagent-stop-git-lane";

export const handleSubagentStop = async (
  ctx: HookContext,
  budget: HookBudget,
): Promise<string> => {
  // A stop forced by another stop hook is the same subagent seen twice.
  if (ctx.payload.stop_hook_active === true) {
    return "";
  }
  const state = await readSessionState(ctx.config.home, ctx.payload.session_id);
  if (state === null) {
    // No SessionStart ran for the parent here: nothing to file a touch under,
    // and a capture is never worth a register (the Stop hook's rule).
    return "";
  }
  await runGitLane(
    ctx,
    budget,
    state,
    { cwdRoot: ownCwdRoot(ctx, state), subagent: true },
    SUBAGENT_GIT_LANE_LOSS_DETAIL,
  );
  // Maintenance on the spare budget, like every hook.
  const current = (await readSessionState(ctx.config.home, ctx.payload.session_id)) ?? state;
  await flushSpool(
    ctx.hub,
    { sessionId: current.crosscheckSessionId, developerId: current.developerId, heal: healerFor(ctx) },
    budget.spareMs(),
  );
  return "";
};
