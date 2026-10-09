/**
 * Stop hook — the Tier-1 summarizer's trigger (DESIGN.md §3 Tier 1), and
 * NOTHING ELSE runs a model here. The hook's own work is deterministic and
 * local: count the turn, run the gate over the transcript tail, and — when
 * the gate fires — record the fire under the state lock and spawn the
 * DETACHED worker (summarizer/worker.ts), which it never waits for. The
 * spool-flush pattern one step earlier: the worker appends to the spool,
 * later hooks flush it.
 *
 * ORDER OF THE FIRE PATH IS THE CONTRACT: the fire is recorded in state
 * BEFORE the worker is spawned, and the transform re-checks cap and debounce
 * on the FRESHEST state inside the lock. A crash between record and spawn
 * costs one unspent fire slot — the honest direction; the reverse order
 * could spawn twice against one slot, which is the §10 risk 7 overspend the
 * cap exists to stop.
 */
import { resolve } from "node:path";

import { selfSpawnCmd } from "@crosscheck/connector-core/config/runtime-isolation.ts";
import { CHARS_PER_TOKEN_ESTIMATE } from "@crosscheck/connector-core/constants.ts";
import { flushSpool } from "@crosscheck/connector-core/spool/flush.ts";
import {
  readSessionState,
  updateSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import {
  isCaptureMoment,
  summarizerFireAllowed,
  withStopTurn,
  withSummarizerFire,
} from "@crosscheck/connector-core/derive/summarizer/gate.ts";
import { SUMMARIZER_PROMPT, resolveSummarizerTimeoutMs } from "@crosscheck/connector-core/model/runner.ts";
import { extractSliceText, readTurnSlice } from "../summarizer/transcript.ts";
import type { TurnSlice } from "../summarizer/transcript.ts";
import { spawnDeriveWorker } from "@crosscheck/connector-core/derive/spawn.ts";
import { ownCwdRoot, runGitLane, sweepIfLifeMoved } from "./git-lane.ts";
import { healerFor } from "./heal.ts";
import type { HookBudget, HookContext } from "./runner.ts";

/**
 * The worker's own entry, INSIDE this package (summarizer/worker-entry.ts).
 * Before Block 8 this was the `crosscheck` bin's `summarize-turn` branch;
 * the bin now lives in packages/cli, and the hook must not depend on the
 * CLI package's location — the summarizer is Claude-specific code and its
 * entry lives beside it.
 */
const WORKER_ENTRY_PATH = resolve(
  import.meta.dir,
  "..",
  "summarizer",
  "worker-entry.ts",
);

/**
 * Fire-and-forget, through the SHARED door (core derive/spawn.ts): the child
 * is unref'd, its stdio ignored, and a spawn failure swallowed — the hook has
 * already recorded the fire, and losing one draft is the cheap outcome (fail
 * open).
 *
 * The env is the hook's own minus the parent-session markers, plus the
 * crosscheck home, the child marker (core model/worker-env.ts says why an
 * allowlist here lost every fire of the trial — finding #14) and this
 * connector's agent kind, which the shared door REQUIRES so a worker can
 * never stamp the wrong host on the draft it writes.
 */
const spawnSummarizeWorker = (
  ctx: HookContext,
  transcriptPath: string,
  slice: TurnSlice,
): void => {
  spawnDeriveWorker({
    env: ctx.env,
    home: ctx.config.home,
    agentKind: ctx.config.agentKind,
    cmd: [
      ...selfSpawnCmd(WORKER_ENTRY_PATH),
      "--transcript",
      transcriptPath,
      "--session",
      ctx.payload.session_id,
      "--slice-start",
      String(slice.start),
      "--slice-end",
      String(slice.end),
    ],
  });
};

/**
 * Rough token estimate for this fire (§10 risk 7): prompt plus slice at the
 * ~4 chars/token rule. An ESTIMATE, and every surface printing it says so —
 * it exists so the summarizer's cost on the developer's own quota is never
 * invisible, not to bill anyone.
 */
const estimateFireTokens = (sliceText: string): number =>
  Math.ceil(
    (SUMMARIZER_PROMPT.length + sliceText.length) / CHARS_PER_TOKEN_ESTIMATE,
  );

/** The capture-loss detail for a git lane this turn could not run (review M5). */
const GIT_LANE_LOSS_DETAIL = "stop-git-lane";

export const handleStop = async (
  ctx: HookContext,
  budget: HookBudget,
): Promise<string> => {
  // A Stop forced by another stop hook is the SAME logical turn seen twice:
  // the first pass already gated it, so a second capture would double-fire.
  if (ctx.payload.stop_hook_active === true) {
    return "";
  }
  const state = await readSessionState(ctx.config.home, ctx.payload.session_id);
  if (state === null) {
    // No SessionStart ran here: nothing to attribute a draft to, and the
    // prompt hook's rule applies — a capture is never worth a register.
    return "";
  }

  // Cheap pre-check BEFORE the transcript read: a session already at its cap
  // (or inside the debounce window) skips the file work entirely.
  const transcriptPath = ctx.payload.transcript_path;
  const couldFire =
    transcriptPath !== undefined && summarizerFireAllowed(withStopTurn(state));
  const slice = couldFire ? await readTurnSlice(transcriptPath) : null;
  const sliceText = slice === null ? "" : extractSliceText(slice.raw);
  const wantsFire = sliceText.length > 0 && isCaptureMoment(sliceText);

  // One locked read-transform-write: the turn is counted unconditionally,
  // and the fire is re-decided on the FRESH state so a racing sibling can
  // never double-spend a slot (state/session-state.ts updateSessionState).
  let fired = false;
  await updateSessionState(ctx.config.home, ctx.payload.session_id, (fresh) => {
    const counted = withStopTurn(fresh);
    if (!wantsFire || !summarizerFireAllowed(counted)) {
      return counted;
    }
    fired = true;
    return withSummarizerFire(counted, estimateFireTokens(sliceText), ctx.now(), resolveSummarizerTimeoutMs(ctx.env));
  });

  if (fired && slice !== null && transcriptPath !== undefined) {
    spawnSummarizeWorker(ctx, transcriptPath, slice);
  }

  // THE SECOND EVIDENCE LANE (regression-guard Stage 1). Stop is where it
  // belongs: the turn is over, so the working tree holds what the turn did,
  // including everything `sed -i`, a codemod, a generator or a `cp` changed
  // without ever raising an Edit event — and the commits the turn made. Since
  // DESIGN.md "One session, many topics" it sweeps EVERY root the session
  // touched, not the one its cwd sat in, and files each root's findings under
  // that root's topic (core flows/git-lane.ts; hooks/git-lane.ts holds the
  // budget and the bookkeeping, shared with SubagentStop).
  //
  // The skip is not hypothetical: driven 12 times against a machine held
  // busy by eight spinning processes, 11 turns recorded and 1 skipped — and
  // the 1 was a number in the session state rather than a silence.
  // (HISTORICAL: that split belongs to the machine it was measured on and
  // nothing here re-derives it; test/stop-git-touches.test.ts asserts the
  // invariant that holds at any load.) The lane books the generated-target
  // rule's counts beside its captures (hooks/git-lane.ts).
  await runGitLane(ctx, budget, state, { cwdRoot: ownCwdRoot(ctx, state) }, GIT_LANE_LOSS_DETAIL);
  // The turn's capture is on disk — the lane's records spooled, its skip
  // counted, the state written: a cut from here on abandons only the drain
  // below, whose records wait for the next hook (runner.ts, the booking).
  budget.captured?.();

  // Maintenance on the spare budget, like every hook: earlier drafts and
  // records ship now instead of waiting for the next tool use.
  await flushSpool(
    ctx.hub,
    {
      sessionId: state.crosscheckSessionId,
      developerId: state.developerId,
      heal: healerFor(ctx),
    },
    budget.spareMs(),
  );
  // The flush may have healed the life away from the lane above (L10): the
  // turn's files are then on the hub under an ended life only, until swept
  // again under the new one — here, when the spare budget covers it.
  await sweepIfLifeMoved(ctx, budget);
  return "";
};
