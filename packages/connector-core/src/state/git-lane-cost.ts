/**
 * The second evidence lane's telemetry (regression-guard Stage 1), summed
 * across live sessions for `status` and `doctor`.
 *
 * WHY THIS EXISTS AT ALL. The lane is a bounded `git diff --name-only HEAD`
 * at Stop, and it is the only thing that sees a file `sed -i`, a codemod or a
 * generator changed — the host reports no Edit event for any of them, so
 * `crosscheck suspect` built on the tool lane alone names the session that
 * used Edit and never mentions the one that actually rewrote the file.
 *
 * A LANE THAT NEVER RUNS LOOKS EXACTLY LIKE A QUIET ONE, which is why both
 * halves are counted and both are printed. There are two ways a Stop turn
 * produces nothing — the hook's spare budget was gone before the lane
 * started, or git did not answer inside its own deadline — and neither is the
 * same as a clean worktree. Reporting only what the lane FOUND would make a
 * lane skipped on every turn indistinguishable from one watching a tidy repo,
 * and `suspect` would then answer "no session touched this surface" out of a
 * blind spot nobody could see. That is the finding-#14 lesson and
 * non-negotiable 4 in one number.
 *
 * WHY IT LIVES IN CORE, unlike its three siblings. `ghost/cost.ts`,
 * `intent/cost.ts` and `summarizer/cost.ts` sit in connector-claude because
 * those lanes are Claude-only end to end. This lane's CAPTURE is core
 * (flows/capture-git-touches.ts) and only its Stop trigger is Claude's, so it
 * follows state/conference-cost.ts — the core-side counter formatter — and a
 * second connector adopting the lane inherits the counter with it.
 *
 * SHAPE COPIED, DELIBERATELY: one reduce over the states `status` and
 * `doctor` already read, and ONE formatter both surfaces call, so the two can
 * never describe the same lane differently.
 */
import type { SessionState } from "./session-state.ts";

export interface GitLaneCost {
  readonly sessions: number;
  /** Files the lane recorded that no Edit tool reported. */
  readonly recorded: number;
  /** Stop turns the lane did not run: no budget, or git did not answer. */
  readonly skipped: number;
}

const NO_COST: GitLaneCost = { sessions: 0, recorded: 0, skipped: 0 };

/**
 * Below this many skips there is nothing to say: one starved turn on a busy
 * afternoon is the design working, and warning about it would be the noise
 * this whole feature is built to avoid.
 */
const MIN_SKIPS_TO_WARN = 3;

export const summarizeGitLaneCost = (
  states: readonly SessionState[],
): GitLaneCost =>
  states.reduce<GitLaneCost>(
    (total, state) => ({
      sessions: total.sessions + 1,
      recorded: total.recorded + state.gitTouchCount,
      skipped: total.skipped + state.gitLaneSkipped,
    }),
    NO_COST,
  );

/**
 * When the lane is worth complaining about — and NOT "any skip". The warning
 * fires when the lane is skipped more often than it records AND has been
 * skipped enough times to be a pattern rather than an afternoon: at that
 * point `crosscheck suspect` is mostly blind to codemods while every
 * individual Stop hook behaved perfectly, which is precisely the failure
 * nothing else would ever mention.
 */
export const gitLaneWarning = (cost: GitLaneCost): string | null =>
  cost.skipped >= MIN_SKIPS_TO_WARN && cost.skipped > cost.recorded
    ? "the lane is skipped more often than it records, so suspect is largely blind to codemods and `sed -i`: give the hooks more room with CROSSCHECK_TIMEOUT_MS, or expect its answers to under-report"
    : null;

/**
 * The one spelling both CLI surfaces print.
 *
 * THE BLIND SPOTS ARE IN THE SENTENCE, not in a document nobody opens: the
 * lane reads uncommitted changes only, so work already committed during the
 * turn and untracked new files are invisible to it — `git diff` reports
 * neither. A reader deciding how far to trust a `suspect` answer needs that
 * beside the count, not two screens away.
 */
export const formatGitLaneCost = (cost: GitLaneCost): string => {
  if (cost.sessions === 0) {
    return "no live sessions";
  }
  const sessions = `across ${String(cost.sessions)} live session${
    cost.sessions === 1 ? "" : "s"
  }`;
  return (
    `${String(cost.recorded)} file(s) no Edit tool reported · ` +
    `${String(cost.skipped)} turn(s) skipped (no budget, or git did not answer) ${sessions}` +
    " — uncommitted changes only: commits made during the turn, and untracked files, are invisible to it"
  );
};
