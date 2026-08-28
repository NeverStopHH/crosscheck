/**
 * WHAT MAKES AN ACP AGENT INFER — the three triggers that give every agent
 * behind this proxy the same derived-intent, ghost-check and Tier-1
 * summarizer machinery Claude has had.
 *
 * EVERY ONE OF THEM RIDES THE PARSE COPY. The proxy is byte-transparent and
 * the tests that keep it that way (test/transparency.test.ts) are the
 * authority; nothing in this file is on the forward path, nothing here can
 * reorder, delay or alter a byte, and none of it needs `--inject` to be on.
 * The capture engine calls these from its serialized dispatch chain, which
 * already sits entirely off the wire.
 *
 * WHICH WIRE EVENT CARRIES WHICH TRIGGER, and why:
 *
 *   intent      the session/prompt REQUEST — the only message that carries
 *               what the developer asked for.
 *   ghost debt  the same request. ACP gives the proxy a guaranteed
 *               next-prompt event (unlike Cursor, where the debt had to be
 *               paid by whichever of two handlers fired first), so the debt
 *               is paid exactly where Claude pays it.
 *   summarizer  the session/prompt RESPONSE — the turn boundary the engine
 *               already ticked and its own comment already called "the
 *               future Tier-1 gate's tick".
 *
 * THE SHAPE IS THE CLAUDE HOOKS', DELIBERATELY: record-then-spawn (a crash
 * between the two costs one unspent slot, never a double spawn), the
 * check-and-set on FRESH state inside the lock, one detached worker nobody
 * waits for, and fail open on every rung. What is different here is only
 * that the parent OUTLIVES the worker, which is what lets the Tier-1 slice
 * travel on a pipe instead of becoming a file (core derive/spawn.ts).
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
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
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
} from "@crosscheck/connector-core/derive/summarizer/gate.ts";
import { SUMMARIZER_PROMPT } from "@crosscheck/connector-core/model/runner.ts";
import {
  readSessionState,
  updateSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";

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
 * Everything a trigger needs from the capture engine's session entry, and
 * nothing else of the engine exposed — the `PromptInjectionView` discipline,
 * one layer down.
 */
export interface AcpDeriveContext {
  readonly env: Env;
  readonly home: string;
  readonly hostSessionKey: string;
  /**
   * The SPAWNING connector's own kind — `acp:<agent>`, resolved from the
   * initialize response. Required, and passed on every spawn, because the
   * workers stamp a record's producer from the environment and default to
   * `claude-code`: forget it once and a Gemini-CLI session's derived intent
   * arrives on the hub as a Claude Code session's (core derive/spawn.ts
   * states the whole trap).
   */
  readonly agentKind: string;
}

const spawn = (
  ctx: AcpDeriveContext,
  cmd: readonly string[],
  stdinText?: string,
): void => {
  spawnDeriveWorker({
    env: ctx.env,
    home: ctx.home,
    agentKind: ctx.agentKind,
    cmd,
    stdinText,
  });
};

/**
 * THE DERIVED-INTENT FIRE, exactly once per session.
 *
 * The lockless pre-check keeps every later prompt to one state read; the
 * check-AND-set under the lock is what makes two racing dispatches spend ONE
 * fire. The prompt reaches the worker through a 0600 FILE named on argv and
 * NOT through the pipe the slice uses, deliberately: `ps` shows argv, so the
 * prompt may not be an argument; and the intent worker's own contract — it
 * removes that file as its FIRST act, before any branch that could return
 * early — is what the privacy pin rests on, unchanged and shared with two
 * other hosts. (A worker that never starts leaves nothing behind either:
 * end-session sweeps the same path.)
 *
 * Returns whether a worker was spawned, so the engine's counter is the truth
 * rather than a guess: a caller that incremented on its own would count the
 * fires it ASKED for, and every rung here can decline.
 */
export const maybeSpawnAcpIntentWorker = async (
  ctx: AcpDeriveContext,
  prompt: string,
): Promise<boolean> => {
  try {
    if (!isSubstantivePrompt(prompt)) {
      return false;
    }
    const state = await readSessionState(ctx.home, ctx.hostSessionKey);
    if (state === null || state.intentFireCount > 0) {
      return false;
    }
    let fired = false;
    await updateSessionState(ctx.home, ctx.hostSessionKey, (fresh) => {
      if (fresh.intentFireCount > 0) {
        return null;
      }
      fired = true;
      return withIntentFire(fresh);
    });
    if (!fired) {
      return false;
    }
    const promptFile = intentPromptPathForSlug(
      ctx.home,
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
    return true;
  } catch {
    // Fail open: capture's own job for this line is untouched.
    return false;
  }
};

/**
 * PAY THE GHOST DEBT, at most once per session and only when one is owed.
 *
 * `set_intent` through the MCP tools sets `ghostPending`; on this host,
 * until now, nothing ever paid it — the debt rotted in the state file for
 * the session's whole life and no surface said so. The claim is a
 * check-and-set under the lock, so two racing dispatches spawn one worker
 * between them; the allowance check beside it stops a re-declared intent
 * spawning a worker that would only exit again. The FIRE is booked in the
 * worker, because the worker is the first place that knows whether the
 * deterministic core found anybody to compare against.
 */
export const maybeSpawnAcpGhostWorker = async (
  ctx: AcpDeriveContext,
): Promise<boolean> => {
  try {
    const state = await readSessionState(ctx.home, ctx.hostSessionKey);
    if (state === null || !state.ghostPending || !hasGhostAllowance(state)) {
      return false;
    }
    const claimed = await updateSessionState(
      ctx.home,
      ctx.hostSessionKey,
      withGhostClaimed,
    );
    if (!claimed) {
      return false;
    }
    spawn(ctx, [
      process.execPath,
      GHOST_WORKER_ENTRY_PATH,
      "--session",
      ctx.hostSessionKey,
    ]);
    return true;
  } catch {
    // Fail open: capture's own job for this line is untouched.
    return false;
  }
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
 * THE TIER-1 GATE ON THE session/prompt RESPONSE — the turn boundary.
 *
 * ONE locked read-transform-write does both bookings, so a turn can never be
 * counted without its outcome: the turn is counted unconditionally and the
 * fire is re-decided on the FRESH state, so a racing sibling can never
 * double-spend a slot.
 *
 * THERE IS NO `noSlice` OUTCOME ON THIS HOST, and its absence is a fact
 * rather than an oversight. Cursor books one because its transcript POINTER
 * can be absent — a deployment state where the gate wanted to look and could
 * not. Here the slice is whatever the wire carried: an empty one means the
 * agent said nothing this turn, which is a quiet turn, not a missing input.
 * Booking that would put a number in front of a reader with nothing to fix.
 */
export const runAcpSummarizerGate = async (
  ctx: AcpDeriveContext,
  sliceText: string,
): Promise<boolean> => {
  try {
    const wantsFire = sliceText.length > 0 && isCaptureMoment(sliceText);
    let fired = false;
    await updateSessionState(ctx.home, ctx.hostSessionKey, (fresh) => {
      const counted = withStopTurn(fresh);
      if (!wantsFire || !summarizerFireAllowed(counted)) {
        return counted;
      }
      fired = true;
      return withSummarizerFire(counted, estimateFireTokens(sliceText));
    });
    if (!fired) {
      return false;
    }
    // The slice travels on the worker's STDIN and touches no disk on this
    // host — the design's stdin lane, and the reason it is available here and
    // nowhere else is in core derive/spawn.ts's `stdinText`.
    spawn(
      ctx,
      [
        process.execPath,
        SUMMARIZER_WORKER_ENTRY_PATH,
        "--session",
        ctx.hostSessionKey,
      ],
      sliceText,
    );
    return true;
  } catch {
    // Fail open, like its two siblings: a turn that could not be booked costs
    // a draft, never the capture row this line was actually dispatched for.
    return false;
  }
};
