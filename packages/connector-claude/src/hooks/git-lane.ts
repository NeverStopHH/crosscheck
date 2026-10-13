/**
 * THE GIT EVIDENCE LANE AS A CLAUDE HOOK RUNS IT (core flows/git-lane.ts):
 * Stop sweeps every root the session touched, SubagentStop the subagent's own
 * root and the roots a shell touched. One spelling for both, because the
 * bookkeeping around the sweep is where a lane goes silently dead.
 *
 * ON THE SPARE BUDGET — which for Stop and SubagentStop, hooks that answer
 * nothing, is the hook's whole remainder (runner.ts ANSWERLESS_HOOKS) — and
 * skipped rather than shortened when it is gone: the sweep reads every root
 * in parallel, each git call on its own GIT_TOUCHES_TIMEOUT_MS deadline, so
 * it is affordable whenever one deadline is.
 *
 * TWO WAYS THE LANE PRODUCES NOTHING, and BOTH are counted (state
 * gitLaneSkipped): the budget was gone before it started, or git did not
 * answer for some root inside its deadline. Neither is the same as a clean
 * worktree, and a lane that silently produces nothing on every turn would
 * otherwise read in `status` and `doctor` exactly like a lane watching a quiet
 * tree — the fail-silent-dead this feature exists to refuse.
 */
import { UNKNOWN_DEVELOPER_ID } from "@crosscheck/connector-core/capture/records.ts";
import { NO_GENERATED } from "@crosscheck/connector-core/capture/generated.ts";
import { GIT_TOUCHES_TIMEOUT_MS } from "@crosscheck/connector-core/constants.ts";
import {
  deferredRootsOf,
  discoverShellRoots,
  selectGitLaneRoots,
  sweepGitRoots,
  withSweptRoots,
} from "@crosscheck/connector-core/flows/git-lane.ts";
import type { GitLaneChoice, GitLaneSweep } from "@crosscheck/connector-core/flows/git-lane.ts";
import { withTopicCapture } from "@crosscheck/connector-core/flows/topic-contexts.ts";
import { flushSpool } from "@crosscheck/connector-core/spool/flush.ts";
import { recordCaptureLoss } from "@crosscheck/connector-core/state/loss-ledger.ts";
import {
  allocateSeq,
  claimOwedSweep,
  updateSessionState,
  withGitTouches,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";
import type { HookBudget, HookContext } from "./runner.ts";

const SKIPPED: GitLaneSweep = { captured: [], topics: null, unavailable: true, swept: [], untrackedCut: [], generated: NO_GENERATED };

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
  // WHERE A SHELL MAY HAVE WORKED (review H2): after a Bash call, the repo's
  // worktrees that changed since their last sweep join the candidates, fs
  // only; the ones the root cap leaves are counted, and stay pending.
  const discovered = isAffordable ? await discoverShellRoots(state) : [];
  const withDiscovered: GitLaneChoice = { ...choice, discovered };
  const roots = isAffordable ? await selectGitLaneRoots(state, withDiscovered) : [];
  const deferred = isAffordable ? await deferredRootsOf(state, withDiscovered, roots) : 0;
  if (isAffordable && roots.length === 0) {
    // Nothing to sweep is not a turn the lane ran or skipped: SubagentStop
    // in a subagent that touched no root of its own.
    return;
  }
  // ALLOCATED INSIDE THE SWEEP — after its reads, before its spools — and not
  // folded into the state write below: the sweep spools its records and that
  // locked write happens AFTER them, so a position stamped there would be
  // stamped on records already on disk. One block, as wide as the roots may
  // file (core flows/git-lane.ts `blockFor`), taken only when the lane runs.
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
        seq: null,
        allocate: (count) => allocateSeq(ctx.config.home, ctx.payload.session_id, count),
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
      // How the generated-target rule classified what was spooled — the lane
      // that sees `bun install` and a codegen run (capture/generated.ts).
      ...(isSameLife ? { generated: sweep.generated } : {}),
      // The life this sweep filed under, when it ran and the life held (L10).
      ...(isSameLife && !sweep.unavailable ? { sweptLife: state.crosscheckSessionId } : {}),
    });
    const swept = withSweptRoots(
      withTopicCapture(booked, sweep.topics),
      sweep.swept,
      ctx.now().toISOString(),
      isSameLife ? sweep.untrackedCut : [],
    );
    // A full Stop that left nothing a shell asked for has answered the shell.
    const isShellAnswered = choice.subagent !== true && deferred === 0 && !sweep.unavailable;
    return {
      ...swept,
      gitLaneRootsDeferred: (swept.gitLaneRootsDeferred ?? 0) + deferred,
      shellSweepSince: isShellAnswered ? null : (swept.shellSweepSince ?? null),
    };
  });
};

/** The loss-ledger detail of a sweep owed to a healed life, booked only when the sweep ran and git did not answer. */
const HEAL_GIT_LANE_LOSS_DETAIL = "heal-git-lane";

/**
 * A SWEEP OWED TO A HEALED LIFE, PAID BY THE FIRST HOOK WITH ROOM (batch-2
 * integration review, L10). A mid-life heal registers the next life with an
 * empty seen-set, and the files the refused life had filed — on the hub
 * under a life now ended, so invisible to every teammate's tripwire — were
 * filed again only by the next Stop or SubagentStop lane: 0 of 6 pre-heal
 * files for a whole turn in the review's V1b. This is the git lane once
 * more, under the new life, from the window the session keeps across a
 * heal, and the spool flushed right after it so the hub holds the files
 * inside the same hook.
 *
 * WHY THE LANE AND NOT A RE-SPOOL of the refused life's seen targets: the
 * seen-set keeps paths and nothing else, and a target names which lane saw
 * the file (tool_edit, git_diff, git_commit) — a re-spool would have to
 * guess that, and a guessed source is a lie on the hub's record. The lane
 * reads the tree and files each path as what it is. Its cost is the lane's
 * (GIT_TOUCHES_TIMEOUT_MS per root, roots in parallel) plus one flush, paid
 * once per heal, only when the hook's spare budget covers the lane; a hook
 * without the room pays nothing and books nothing — the files are on the
 * hub under the ended life, and the next lane files them, as before.
 */
export const sweepIfLifeMoved = async (ctx: HookContext, budget: HookBudget): Promise<boolean> => {
  if (budget.spareMs() < GIT_TOUCHES_TIMEOUT_MS) {
    return false;
  }
  // CLAIMED IN THE TRANSFORM THAT READS THE DEBT (final review of batch 2,
  // N4): one hook pays the lane; a sibling that finds the claim fresh pays
  // nothing, and a busy lock is the same answer — the next hook asks again.
  const claimed: { value: SessionState | null } = { value: null };
  const isClaimed = await updateSessionState(ctx.config.home, ctx.payload.session_id, (fresh) => {
    claimed.value = claimOwedSweep(fresh, ctx.now());
    return claimed.value;
  });
  const state = claimed.value;
  if (!isClaimed || state === null) {
    return false;
  }
  await runGitLane(ctx, budget, state, { cwdRoot: ownCwdRoot(ctx, state) }, HEAL_GIT_LANE_LOSS_DETAIL);
  // No healer: the life was healed a moment ago, and a refusal now is the
  // next hook's to walk — this flush only carries the sweep's records.
  await flushSpool(
    ctx.hub,
    { sessionId: state.crosscheckSessionId, developerId: state.developerId, isAnswerless: budget.isAnswerless === true },
    budget.spareMs(),
  );
  return true;
};
