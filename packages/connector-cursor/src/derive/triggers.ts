/**
 * WHAT MAKES CURSOR INFER — the three triggers that turn Cursor's hooks into
 * the same derived-intent, ghost-check and Tier-1 summarizer machinery Claude
 * has had. Nothing here derives anything itself: each trigger is a
 * deterministic decision, a booking under the state lock, and one detached
 * spawn it never waits for.
 *
 * THE SHAPE IS THE CLAUDE HOOKS', DELIBERATELY, because it is the shape that
 * survived a trial: record-then-spawn (a crash between the two costs one
 * unspent slot, never a double spawn), the fresh-state re-check INSIDE the
 * lock (two racing hook processes spend one slot between them), and fail open
 * on every rung. What is Cursor's own is only WHICH EVENT carries which
 * trigger, and that is decided by what Cursor's hooks can actually do:
 *
 *   intent      beforeSubmitPrompt — the only event that carries the prompt.
 *   ghost debt  stop AND postToolUse — Cursor has no single "next prompt"
 *               event that always runs (beforeSubmitPrompt is absent from
 *               older builds and the user may never type again), so the debt
 *               is paid by whichever of the two fires first. Claiming it is a
 *               check-and-set under the lock, so two of them racing still
 *               spawn one worker.
 *   summarizer  stop — the turn boundary, and the event whose common input
 *               carries `transcript_path`.
 *
 * afterFileEdit carries none of them: it is documented to support no output
 * fields at all, and this connector answers it with "" by design. Anything
 * owed at edit time is therefore booked as a debt and paid on an event that
 * can act — which is exactly the `ghostPending` shape above, and why the
 * ghost rung needed no new field.
 */
import { resolve } from "node:path";

import {
  CHARS_PER_TOKEN_ESTIMATE,
  INTENT_PROMPT_MAX_CHARS,
} from "@crosscheck/connector-core/constants.ts";
import { cutWellFormed } from "@crosscheck/connector-core/briefing/cut.ts";
import {
  intentPromptPathForSlug,
  sessionSlug,
  writePrivateFile,
} from "@crosscheck/connector-core/config/paths.ts";
import { spawnDeriveWorker } from "@crosscheck/connector-core/derive/spawn.ts";
import {
  hasGhostAllowance,
  withGhostClaimed,
} from "@crosscheck/connector-core/derive/ghost/gate.ts";
import {
  isSubstantivePrompt,
  withIntentFire,
} from "@crosscheck/connector-core/derive/intent/gate.ts";
import {
  isCaptureMoment,
  summarizerFireAllowed,
  withStopTurn,
  withSummarizerFire,
  withSummarizerNoSlice,
} from "@crosscheck/connector-core/derive/summarizer/gate.ts";
import { SUMMARIZER_PROMPT } from "@crosscheck/connector-core/model/runner.ts";
import {
  readSessionState,
  updateSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";

import type { CursorHookContext } from "../runner.ts";
import {
  extractCursorSliceText,
  NO_SLICE_NO_TRANSCRIPT,
  NO_SLICE_UNREADABLE,
  NO_SLICE_UNRECOGNISED,
  readCursorTurnSlice,
} from "./transcript.ts";
import type { CursorTurnSlice } from "./transcript.ts";

/** The three worker entries, INSIDE this package (the Stop hook's rule). */
const INTENT_WORKER_ENTRY_PATH = resolve(
  import.meta.dir,
  "intent-worker-entry.ts",
);
const GHOST_WORKER_ENTRY_PATH = resolve(
  import.meta.dir,
  "ghost-worker-entry.ts",
);
const SUMMARIZER_WORKER_ENTRY_PATH = resolve(
  import.meta.dir,
  "summarizer-worker-entry.ts",
);

/**
 * Every spawn from this connector goes through here, so `agentKind` is passed
 * exactly once and cannot be forgotten on the fourth call site. Without it the
 * worker stamps DEFAULT_AGENT_KIND and Ken's derived draft arrives on the hub
 * as a Claude Code session's (core derive/spawn.ts states the whole trap).
 */
const spawn = (ctx: CursorHookContext, cmd: readonly string[]): void => {
  spawnDeriveWorker({
    env: ctx.env,
    home: ctx.config.home,
    agentKind: ctx.config.agentKind,
    cmd,
  });
};

/**
 * THE DERIVED-INTENT FIRE, exactly once per session state.
 *
 * The lockless pre-check keeps every later prompt to one state read; the
 * check-AND-set under the lock is what makes two racing hook processes spend
 * ONE fire. The prompt reaches the worker through a 0600 FILE named on argv —
 * never the prompt itself, which `ps` would show, and never stdin, which a
 * detached child cannot be handed by a hook that exits first — and the worker
 * unlinks that file in `finally` whatever happens to it.
 */
export const maybeSpawnCursorIntentWorker = async (
  ctx: CursorHookContext,
): Promise<void> => {
  try {
    const prompt = ctx.payload.prompt ?? "";
    if (!isSubstantivePrompt(prompt)) {
      return;
    }
    const state = await readSessionState(ctx.config.home, ctx.hostSessionKey);
    if (state === null || state.intentFireCount > 0) {
      return;
    }
    let fired = false;
    await updateSessionState(ctx.config.home, ctx.hostSessionKey, (fresh) => {
      if (fresh.intentFireCount > 0) {
        return null;
      }
      fired = true;
      return withIntentFire(fresh);
    });
    if (!fired) {
      return;
    }
    const promptFile = intentPromptPathForSlug(
      ctx.config.home,
      sessionSlug(ctx.hostSessionKey),
    );
    await writePrivateFile(
      promptFile,
      cutWellFormed(prompt, INTENT_PROMPT_MAX_CHARS),
    );
    spawn(ctx, [
      process.execPath,
      INTENT_WORKER_ENTRY_PATH,
      "--session",
      ctx.hostSessionKey,
      "--prompt-file",
      promptFile,
    ]);
  } catch {
    // Fail open: the handler's own job is untouched.
  }
};

/**
 * PAY THE GHOST DEBT, at most once per session and only when one is owed.
 *
 * Until this existed, `set_intent` in Cursor set `ghostPending` and NOTHING
 * ever paid it: the debt rotted in the state file for the session's whole
 * life and no surface said so. The claim is a check-and-set under the lock
 * (two racing handlers spawn one worker between them); the allowance check
 * beside it stops a re-declared intent spawning a worker that would only exit
 * again. The FIRE is booked in the worker, because the worker is the first
 * place that knows whether the deterministic core found anybody to compare
 * against — a check that finds nobody costs one bounded GET and no tokens.
 *
 * Called from `stop` and from `postToolUse`, and safe on both for the reason
 * above: whichever runs first pays, the other finds nothing owed.
 */
export const maybeSpawnCursorGhostWorker = async (
  ctx: CursorHookContext,
): Promise<void> => {
  try {
    const state = await readSessionState(ctx.config.home, ctx.hostSessionKey);
    if (state === null || !state.ghostPending || !hasGhostAllowance(state)) {
      return;
    }
    const claimed = await updateSessionState(
      ctx.config.home,
      ctx.hostSessionKey,
      withGhostClaimed,
    );
    if (!claimed) {
      return;
    }
    spawn(ctx, [
      process.execPath,
      GHOST_WORKER_ENTRY_PATH,
      "--session",
      ctx.hostSessionKey,
    ]);
  } catch {
    // Fail open: the handler's own job is untouched.
  }
};

/**
 * Where this build's transcript is: the payload's documented field first, the
 * documented `CURSOR_TRANSCRIPT_PATH` environment variable second. Both are
 * documented as conditional — the field is `string | null` ("null if
 * transcripts disabled"), the variable is present "If transcripts enabled" —
 * so BOTH absent is the documented off state, not a contract drift. That is
 * why `transcript_path` is not a mapped field: counting an off switch as
 * drift would put a WARN in front of a reader with nothing to fix.
 */
const transcriptPathOf = (ctx: CursorHookContext): string | null => {
  const fromPayload = ctx.payload.transcript_path;
  if (typeof fromPayload === "string" && fromPayload.length > 0) {
    return fromPayload;
  }
  const fromEnv = ctx.env["CURSOR_TRANSCRIPT_PATH"];
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : null;
};

/**
 * Rough token estimate for this fire (§10 risk 7): prompt plus slice at the
 * ~4 chars/token rule. An ESTIMATE, and every surface printing it says so.
 */
const estimateFireTokens = (sliceText: string): number =>
  Math.ceil(
    (SUMMARIZER_PROMPT.length + sliceText.length) / CHARS_PER_TOKEN_ESTIMATE,
  );

/**
 * What the stop handler learned about this turn before it takes the lock:
 * either a slice the gate can read, or the named reason there is none.
 */
interface TurnLook {
  readonly slice: CursorTurnSlice | null;
  readonly sliceText: string;
  readonly transcriptPath: string | null;
  /** Null when a slice was produced; one of transcript.ts's reasons else. */
  readonly noSliceReason: string | null;
}

const lookAtTurn = async (
  ctx: CursorHookContext,
  couldFire: boolean,
): Promise<TurnLook> => {
  const transcriptPath = transcriptPathOf(ctx);
  const nothing = { slice: null, sliceText: "", transcriptPath } as const;
  if (!couldFire) {
    // Already at the cap or inside the debounce window: no file work, and no
    // no-slice booking either — a turn the gate was never going to look at
    // has no missing slice to report.
    return { ...nothing, noSliceReason: null };
  }
  if (transcriptPath === null) {
    return { ...nothing, noSliceReason: NO_SLICE_NO_TRANSCRIPT };
  }
  const slice = await readCursorTurnSlice(transcriptPath);
  if (slice === null) {
    return { ...nothing, noSliceReason: NO_SLICE_UNREADABLE };
  }
  const extracted = extractCursorSliceText(slice.raw);
  if (extracted === null) {
    return { ...nothing, noSliceReason: NO_SLICE_UNRECOGNISED };
  }
  return {
    slice,
    sliceText: extracted.text,
    transcriptPath,
    noSliceReason: null,
  };
};

/**
 * THE TIER-1 GATE ON `stop`, and the turn count that used to be all this
 * handler did.
 *
 * ONE locked read-transform-write does all three bookings, so a turn can
 * never be counted without its outcome: the turn is counted unconditionally,
 * the fire is re-decided on the FRESH state (a racing sibling can never
 * double-spend a slot), and a turn the gate wanted to read but could not is
 * booked as `noSlice` — its OWN outcome, never a runner failure, because no
 * model ran and the reader's local binary is not the problem.
 */
export const runCursorSummarizerGate = async (
  ctx: CursorHookContext,
): Promise<void> => {
  const state = await readSessionState(ctx.config.home, ctx.hostSessionKey);
  if (state === null) {
    return;
  }
  const couldFire = summarizerFireAllowed(withStopTurn(state));
  const look = await lookAtTurn(ctx, couldFire);
  const wantsFire = look.sliceText.length > 0 && isCaptureMoment(look.sliceText);

  let fired = false;
  await updateSessionState(ctx.config.home, ctx.hostSessionKey, (fresh) => {
    const counted = withStopTurn(fresh);
    if (look.noSliceReason !== null) {
      return withSummarizerNoSlice(counted, look.noSliceReason);
    }
    if (!wantsFire || !summarizerFireAllowed(counted)) {
      return counted;
    }
    fired = true;
    return withSummarizerFire(counted, estimateFireTokens(look.sliceText));
  });

  if (fired && look.slice !== null && look.transcriptPath !== null) {
    spawn(ctx, [
      process.execPath,
      SUMMARIZER_WORKER_ENTRY_PATH,
      "--session",
      ctx.hostSessionKey,
      "--transcript",
      look.transcriptPath,
      "--slice-start",
      String(look.slice.start),
      "--slice-end",
      String(look.slice.end),
    ]);
  }
};
