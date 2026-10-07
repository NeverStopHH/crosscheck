/**
 * THE GIT EVIDENCE LANE AS A CLAUDE HOOK RUNS IT (core flows/git-lane.ts):
 * Stop sweeps every root the session touched, SubagentStop the subagent's own
 * root and the roots a shell touched. One spelling for both, because the
 * bookkeeping around the sweep is where a lane goes silently dead.
 *
 * ON THE SPARE BUDGET, and skipped rather than shortened when it is gone: the
 * sweep reads every root in parallel, each git call on its own
 * GIT_TOUCHES_TIMEOUT_MS deadline, so it is affordable whenever one deadline
 * is.
 *
 * TWO WAYS THE LANE PRODUCES NOTHING, and BOTH are counted (state
 * gitLaneSkipped): the budget was gone before it started, or git did not
 * answer for some root inside its deadline. Neither is the same as a clean
 * worktree, and a lane that silently produces nothing on every turn would
 * otherwise read in `status` and `doctor` exactly like a lane watching a quiet
 * tree — the fail-silent-dead this feature exists to refuse.
 */
import { UNKNOWN_DEVELOPER_ID } from "@crosscheck/connector-core/capture/records.ts";
import { GIT_TOUCHES_TIMEOUT_MS, MAX_TARGETS_PER_INVOCATION } from "@crosscheck/connector-core/constants.ts";
import { selectGitLaneRoots, sweepGitRoots, withSweptRoots } from "@crosscheck/connector-core/flows/git-lane.ts";
import type { GitLaneChoice, GitLaneSweep } from "@crosscheck/connector-core/flows/git-lane.ts";
import { withTopicCapture } from "@crosscheck/connector-core/flows/topic-contexts.ts";
import { recordCaptureLoss } from "@crosscheck/connector-core/state/loss-ledger.ts";
import { allocateSeq, updateSessionState, withGitTouches } from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";
import type { HookBudget, HookContext } from "./runner.ts";

/**
 * Each swept root's worst case: `captureFileTargets` caps what one root
 * spools at MAX_TARGETS_PER_INVOCATION, commits and changes together, so a
 * root's slice of the block can never be short. Unused positions are gaps,
 * and gaps are legal.
 */
const GIT_LANE_SEQ_BLOCK = MAX_TARGETS_PER_INVOCATION;

const SKIPPED: GitLaneSweep = { captured: [], topics: null, unavailable: true, swept: [] };

/** The hook's cwd root, when it is this session's repo — a foreign cwd is never swept. */
export const ownCwdRoot = (ctx: HookContext, state: SessionState): string | null =>
  ctx.identity.repoId === state.repoId ? ctx.identity.root : null;

export const runGitLane = async (
  ctx: HookContext,
  budget: HookBudget,
  state: SessionState,
  choice: GitLaneChoice,
  lossDetail: string,
): Promise<void> => {
  const isAffordable = budget.spareMs() >= GIT_TOUCHES_TIMEOUT_MS;
  const roots = isAffordable ? await selectGitLaneRoots(state, choice) : [];
  if (isAffordable && roots.length === 0) {
    // Nothing to sweep is not a turn the lane ran or skipped: SubagentStop
    // in a subagent that touched no root of its own.
    return;
  }
  // ALLOCATED BEFORE THE SWEEP, not folded into the state write below: the
  // sweep spools its records and that locked write happens AFTER them, so a
  // position stamped there would be stamped on records already on disk. One
  // block, one slice per root, taken only when the lane is going to run.
  const seq = isAffordable
    ? await allocateSeq(ctx.config.home, ctx.payload.session_id, GIT_LANE_SEQ_BLOCK * roots.length)
    : null;
  const sweep = isAffordable
    ? await sweepGitRoots({
        home: ctx.config.home,
        repoKey: ctx.repoKey,
        hostSessionKey: ctx.payload.session_id,
        state,
        roots,
        producer: {
          developerId: state.developerId ?? UNKNOWN_DEVELOPER_ID,
          agentKind: ctx.config.agentKind,
          sessionId: state.crosscheckSessionId,
        },
        denylist: ctx.config.denylist,
        now: ctx.now(),
        seq,
      })
    : SKIPPED;
  // REVIEW M5: A SKIPPED OR UNANSWERED LANE IS A LOSS, NOT ONLY A NUMBER IN
  // SESSION STATE. Its window is the session's start, so the next turn's lane
  // re-examines the same touches — but a session whose last turn skipped, or
  // a touch reverted before the next run, is lost for good, and nothing told
  // the hub. Booked keyed (this hook knows its repo), dated, so it ages out;
  // the over-count for the turns a later lane recovers is the safe side.
  if (sweep.unavailable) {
    await recordCaptureLoss(ctx.config.home, {
      kind: "hook_timed_out",
      count: 1,
      key: ctx.repoKey,
      detail: lossDetail,
      now: ctx.now(),
    });
  }
  // BOOKED ON EVERY TURN, the one that ran and found nothing included: that
  // turn is the denominator doctor's verdict divides by (state/git-lane-cost
  // .ts). Files captured into a life a heal moved away from stay unseen, so
  // the next life captures them — and so do the topics it opened.
  await updateSessionState(ctx.config.home, ctx.payload.session_id, (fresh) => {
    const isSameLife = fresh.crosscheckSessionId === state.crosscheckSessionId;
    const booked = withGitTouches(fresh, {
      captured: isSameLife ? sweep.captured : [],
      skipped: sweep.unavailable,
    });
    return withSweptRoots(withTopicCapture(booked, sweep.topics), sweep.swept, ctx.now().toISOString());
  });
};
