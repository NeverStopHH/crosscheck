/**
 * UserPromptSubmit — the injection pipeline's fast path (DESIGN.md §4).
 *
 * TWO deliveries can ride this hook, never both on one prompt:
 *
 *   1. A DEFERRED BRIEFING (flows/briefing.ts `deliverDeferredBriefing`):
 *      a session that registered late — PostToolUse's recovery, the
 *      parent-workspace shape — is owed the briefing SessionStart never got
 *      to deliver, and the first prompt pays that debt. Precedence is
 *      pinned: the briefing OUTRANKS the hint for that one prompt (the ACP
 *      injector's order — briefing on the first prompt it is ready for, the
 *      hint flow afterwards), and the hint pipeline is not even consulted,
 *      so one prompt carries at most one injection.
 *   2. Otherwise the hint: the WHOLE pipeline — meaning floor, seen-set +
 *      cap, one bounded hub call, one bounded git call, at most ONE hint,
 *      record-then-emit — is the core `selectAndRenderHint` flow since
 *      Block 5 extracted it (connector-core/src/flows/hint.ts, where the
 *      ordering and privacy arguments now live).
 *
 * AND, BEFORE EITHER, one thing that delivers nothing: the derived-intent
 * fire (trial finding #16). On the FIRST substantive prompt of a session
 * this hook books a fire under the state lock, parks the prompt in a 0600
 * file and spawns the detached intent worker (intent/worker.ts) — the Stop
 * hook's summarizer spawn shape, byte for byte: record-then-spawn, unref,
 * stdio ignored, the worker env minus the parent session's markers plus the
 * child marker, fail open. No hub call, no model wait: one lock round, one
 * small file write, one spawn inside the same 800 ms race
 * (USER_PROMPT_SUBMIT_BUDGET_RATIO; test/hint-hook-latency.test.ts measures
 * it). The prompt text itself NEVER leaves the machine — only the model's
 * one sentence can, and only from the worker, after its gates.
 *
 * AND ONE MORE THING THAT DELIVERS NOTHING: the ghost check (VISION.md §3).
 * When an intent has been recorded and nothing has compared it against the
 * team's live plans yet, session state carries `ghostPending` — the debt shape
 * `briefingPending` already uses — and this hook claims it under the lock and
 * spawns the detached ghost worker. Identical cost to the intent fire: one
 * state read the hook was making anyway, one lock round, one unref'd spawn,
 * no hub call and no model wait. The DEBT exists because the writer that
 * records an intent is either `set_intent` (an MCP call in connector-core,
 * which cannot reach a Claude-specific worker) or the intent worker itself
 * (already detached, and its job is the intent).
 *
 * This hook is the Claude-specific shell: payload fields in,
 * `hookSpecificOutput` envelope out.
 */
import { resolve } from "node:path";

import { INTENT_PROMPT_MAX_CHARS } from "@crosscheck/connector-core/constants.ts";
import { cutWellFormed } from "@crosscheck/connector-core/briefing/cut.ts";
import {
  intentPromptPathForSlug,
  sessionSlug,
  writePrivateFile,
} from "@crosscheck/connector-core/config/paths.ts";
import { deliverDeferredBriefing } from "@crosscheck/connector-core/flows/briefing.ts";
import { selectAndRenderHint } from "@crosscheck/connector-core/flows/hint.ts";
import {
  readSessionState,
  updateSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import { hasGhostAllowance, withGhostClaimed } from "../ghost/gate.ts";
import { isSubstantivePrompt, withIntentFire } from "../intent/gate.ts";
import { summarizerWorkerEnv } from "@crosscheck/connector-core/model/worker-env.ts";
import type { HookContext } from "./runner.ts";

/** The intent worker's own entry, INSIDE this package (intent/worker-entry.ts). */
const INTENT_WORKER_ENTRY_PATH = resolve(
  import.meta.dir,
  "..",
  "intent",
  "worker-entry.ts",
);

/** The ghost worker's own entry, beside it (ghost/worker-entry.ts). */
const GHOST_WORKER_ENTRY_PATH = resolve(
  import.meta.dir,
  "..",
  "ghost",
  "worker-entry.ts",
);

const envelope = (text: string): string =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: text,
    },
  });

/**
 * Fire-and-forget, the Stop hook's shape: the child is unref'd, its stdio
 * ignored, a spawn failure swallowed — the work is already booked and losing
 * one worker is the cheap outcome (fail open). ONE helper for both detached
 * workers this hook can start, so the worker env, the ignored stdio and the
 * unref are decided once: the pair drifting apart is how a child ends up
 * inheriting the parent session's markers (trial finding #14).
 */
const spawnDetached = (ctx: HookContext, cmd: readonly string[]): void => {
  try {
    const proc = Bun.spawn({
      cmd: [...cmd],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: summarizerWorkerEnv(ctx.env, ctx.config.home),
    });
    proc.unref();
  } catch {
    // Fail open — the fire slot is spent, the work is lost, nothing breaks.
  }
};

/**
 * The prompt reaches the intent worker through the FILE path on argv — never
 * the prompt itself, which `ps` would show, and never stdin, which a detached
 * child cannot be handed by a hook that exits first.
 */
const spawnIntentWorker = (ctx: HookContext, promptFile: string): void => {
  spawnDetached(ctx, [
    process.execPath,
    INTENT_WORKER_ENTRY_PATH,
    "--session",
    ctx.payload.session_id,
    "--prompt-file",
    promptFile,
  ]);
};

/**
 * Exactly once per session state: the lockless pre-check keeps every later
 * prompt to one state read, and the check-AND-set under the lock is what
 * makes two racing hook processes spend ONE fire (the tripwire's shape).
 * Record-then-spawn, like the summarizer: a crash between the two costs one
 * unspent fire, never a double spawn.
 */
const maybeSpawnIntentWorker = async (ctx: HookContext): Promise<void> => {
  try {
    const prompt = ctx.payload.prompt ?? "";
    if (!isSubstantivePrompt(prompt)) {
      return;
    }
    const state = await readSessionState(ctx.config.home, ctx.payload.session_id);
    if (state === null || state.intentFireCount > 0) {
      return;
    }
    let fired = false;
    await updateSessionState(ctx.config.home, ctx.payload.session_id, (fresh) => {
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
      sessionSlug(ctx.payload.session_id),
    );
    await writePrivateFile(promptFile, cutWellFormed(prompt, INTENT_PROMPT_MAX_CHARS));
    spawnIntentWorker(ctx, promptFile);
  } catch {
    // Fail open: the prompt hook's own job (briefing or hint) is untouched.
  }
};

/**
 * Pay the ghost debt, at most once per session and only when one is owed.
 *
 * The DEBT is claimed here and the FIRE is booked in the worker, which is not
 * a split for its own sake: the fire pays for a MODEL CALL, and the worker is
 * the first place that knows whether the deterministic core found anybody to
 * compare against. Claiming the debt here is what stops two racing hooks from
 * spawning two workers; checking the allowance here as well is what stops a
 * re-declared intent from spawning a worker that would only exit again.
 */
const maybeSpawnGhostWorker = async (ctx: HookContext): Promise<void> => {
  try {
    const state = await readSessionState(ctx.config.home, ctx.payload.session_id);
    if (state === null || !state.ghostPending || !hasGhostAllowance(state)) {
      return;
    }
    const claimed = await updateSessionState(
      ctx.config.home,
      ctx.payload.session_id,
      withGhostClaimed,
    );
    if (!claimed) {
      return;
    }
    spawnDetached(ctx, [
      process.execPath,
      GHOST_WORKER_ENTRY_PATH,
      "--session",
      ctx.payload.session_id,
    ]);
  } catch {
    // Fail open: the prompt hook's own job (briefing or hint) is untouched.
  }
};

export const handleUserPromptSubmit = async (
  ctx: HookContext,
): Promise<string> => {
  // The derived-intent fire delivers nothing and runs first, so it happens
  // on the first substantive prompt whatever else this hook goes on to emit.
  await maybeSpawnIntentWorker(ctx);
  // The ghost debt, likewise: nothing is emitted here, and a session that
  // owes nothing pays one state read it had already made.
  await maybeSpawnGhostWorker(ctx);
  // The deferred briefing never reads the prompt text, so it sits BEFORE the
  // hint pipeline's meaning floor and secret gate: a session owed a briefing
  // gets it whatever the first prompt says. Exactly-once and the
  // failed-assembly semantics live on the flow.
  const briefing = await deliverDeferredBriefing({
    home: ctx.config.home,
    repoKey: ctx.repoKey,
    hub: ctx.hub,
    hostSessionKey: ctx.payload.session_id,
    repoId: ctx.identity.repoId,
    agentKind: ctx.config.agentKind,
    now: ctx.now(),
  });
  if (briefing.length > 0) {
    return envelope(briefing);
  }
  const text = await selectAndRenderHint({
    home: ctx.config.home,
    repoKey: ctx.repoKey,
    hub: ctx.hub,
    hostSessionKey: ctx.payload.session_id,
    repoId: ctx.identity.repoId,
    repoRoot: ctx.identity.root,
    agentKind: ctx.config.agentKind,
    prompt: ctx.payload.prompt ?? "",
    now: ctx.now(),
  });
  if (text.length === 0) {
    return "";
  }
  return envelope(text);
};
