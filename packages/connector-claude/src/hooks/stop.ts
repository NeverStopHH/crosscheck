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

import { UNKNOWN_DEVELOPER_ID } from "@crosscheck/connector-core/capture/records.ts";

import {
  CHARS_PER_TOKEN_ESTIMATE,
  GIT_TOUCHES_TIMEOUT_MS,
} from "@crosscheck/connector-core/constants.ts";
import { captureGitTouches } from "@crosscheck/connector-core/flows/capture-git-touches.ts";
import { flushSpool } from "@crosscheck/connector-core/spool/flush.ts";
import {
  readSessionState,
  updateSessionState,
  withGitTouches,
} from "@crosscheck/connector-core/state/session-state.ts";
import {
  isCaptureMoment,
  summarizerFireAllowed,
  withStopTurn,
  withSummarizerFire,
} from "../summarizer/gate.ts";
import { SUMMARIZER_PROMPT } from "../summarizer/runner.ts";
import { extractSliceText, readTurnSlice } from "../summarizer/transcript.ts";
import type { TurnSlice } from "../summarizer/transcript.ts";
import { summarizerWorkerEnv } from "../summarizer/worker-env.ts";
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
 * Fire-and-forget: the child is unref'd, its stdio ignored, and a spawn
 * failure is swallowed — the hook has already recorded the fire, and losing
 * one draft is the cheap outcome (fail open).
 *
 * The env is the hook's own minus the parent-session markers, plus the
 * crosscheck home and the child marker (summarizer/worker-env.ts says why
 * an allowlist here lost every fire of the trial — finding #14).
 */
const spawnSummarizeWorker = (
  ctx: HookContext,
  transcriptPath: string,
  slice: TurnSlice,
): void => {
  try {
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        WORKER_ENTRY_PATH,
        "--transcript",
        transcriptPath,
        "--session",
        ctx.payload.session_id,
        "--slice-start",
        String(slice.start),
        "--slice-end",
        String(slice.end),
      ],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: summarizerWorkerEnv(ctx.env, ctx.config.home),
    });
    proc.unref();
  } catch {
    // Fail open — the fire slot is spent, the draft is lost, nothing breaks.
  }
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
    return withSummarizerFire(counted, estimateFireTokens(sliceText));
  });

  if (fired && slice !== null && transcriptPath !== undefined) {
    spawnSummarizeWorker(ctx, transcriptPath, slice);
  }

  // THE SECOND EVIDENCE LANE (regression-guard Stage 1). Stop is where it
  // belongs: the turn is over, so the working tree holds what the turn did,
  // including everything `sed -i`, a codemod or a generator changed without
  // ever raising an Edit event. Without it `crosscheck suspect` names the
  // session that used Edit with full confidence while the codemod session
  // leaves no trace at all.
  //
  // ON THE SPARE BUDGET, and skipped rather than shortened when it is gone:
  // one bounded `git diff --name-only HEAD` at GIT_TOUCHES_TIMEOUT_MS, run
  // only while the hook's reserve still covers it. A skipped turn is COUNTED
  // (state gitLaneSkipped) so a lane that never runs is a number in `status`
  // rather than a quiet absence of evidence.
  const laneAffordable = budget.spareMs() >= GIT_TOUCHES_TIMEOUT_MS;
  const captured = laneAffordable
    ? await captureGitTouches({
        home: ctx.config.home,
        repoKey: ctx.repoKey,
        hostSessionKey: ctx.payload.session_id,
        repoRoot: ctx.identity.root,
        workContextId: state.workContextId,
        producer: {
          developerId: state.developerId ?? UNKNOWN_DEVELOPER_ID,
          agentKind: ctx.config.agentKind,
          sessionId: state.crosscheckSessionId,
        },
        seenTargets: state.seenTargets,
        denylist: ctx.config.denylist,
        since: new Date(state.startedAt),
        now: ctx.now(),
      })
    : [];
  if (captured.length > 0 || !laneAffordable) {
    await updateSessionState(ctx.config.home, ctx.payload.session_id, (fresh) =>
      withGitTouches(fresh, { captured, skipped: !laneAffordable }),
    );
  }

  // Maintenance on the spare budget, like every hook: earlier drafts and
  // records ship now instead of waiting for the next tool use.
  await flushSpool(
    ctx.hub,
    {
      sessionId: state.crosscheckSessionId,
      developerId: state.developerId,
    },
    budget.spareMs(),
  );
  return "";
};
