/**
 * UserPromptSubmit — the injection pipeline's fast path (DESIGN.md §4).
 *
 * THREE deliveries can ride this hook, never two on one prompt:
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
 *   3. Only when neither spoke: the draft review nudge, once per session
 *      (connector-core/src/flows/draft-nudge.ts) — housekeeping yields to
 *      team knowledge, and a nudge that loses this prompt waits for the next.
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
 * AND ONE THING THAT RIDES BESIDE WHICHEVER OF THE THREE SPOKE: a teammate
 * collision a SUBAGENT of this session ran into (hooks/pre-tool-use.ts queues
 * it). The subagent's own context is not the conversation the person reads —
 * 91% of the pilot owner's edits were made by subagents, and every tripwire
 * hit among them reached nobody — so the main thread is handed the facts and
 * the one relay sentence here, first, drained under the lock so a group is
 * relayed exactly once. This hook and not Stop: Stop is registered async (its
 * gate must never hold the model), and the reference delivers an async hook's
 * fields to Claude only "on the next conversation turn" and never shows them
 * to the person — which is this hook, and it also fires when a background
 * subagent reports back. It is a few renderer-owned lines, so it does not
 * count as the one injection; it costs one state read, and a lock round only
 * when something is queued.
 *
 * This hook is the Claude-specific shell: payload fields in,
 * `hookSpecificOutput` envelope out.
 */
import { resolve } from "node:path";

import { aPersonReads } from "@crosscheck/connector-core/config/tripwire.ts";
import { INTENT_PROMPT_MAX_CHARS } from "@crosscheck/connector-core/constants.ts";
import { cutWellFormed } from "@crosscheck/connector-core/briefing/cut.ts";
import {
  intentPromptPathForSlug,
  sessionSlug,
  writePrivateFile,
} from "@crosscheck/connector-core/config/paths.ts";
import { deliverDeferredBriefing } from "@crosscheck/connector-core/flows/briefing.ts";
import { deliverDraftNudge } from "@crosscheck/connector-core/flows/draft-nudge.ts";
import { selectAndRenderHint } from "@crosscheck/connector-core/flows/hint.ts";
import { renderSubagentCollisionRelay } from "@crosscheck/connector-core/hints/collision-notice.ts";
import {
  readSessionState,
  updateSessionState,
  withDrainedCollisionRelays,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { CollisionNotice } from "@crosscheck/connector-core/state/session-state.ts";
import { hasGhostAllowance, withGhostClaimed } from "@crosscheck/connector-core/derive/ghost/gate.ts";
import { isSubstantivePrompt, withIntentFire } from "@crosscheck/connector-core/derive/intent/gate.ts";
import { resolveSummarizerTimeoutMs } from "@crosscheck/connector-core/model/runner.ts";
import { spawnDeriveWorker } from "@crosscheck/connector-core/derive/spawn.ts";
import { requestLandingFetchFor } from "./landing-fetch.ts";
import type { HookBudget, HookContext } from "./runner.ts";

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

interface PromptOutput {
  readonly hookSpecificOutput: {
    readonly hookEventName: "UserPromptSubmit";
    readonly additionalContext: string;
  };
}

/**
 * An OBJECT, serialized once in `handleUserPromptSubmit`, so the subagent
 * relay can ride beside whatever the prompt carries without re-reading JSON.
 */
const envelope = (text: string): PromptOutput => ({
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: text,
  },
});

/** The relay first, then the prompt's own delivery; "" when neither spoke. */
const serialize = (output: PromptOutput | "", relay: string): string => {
  const text = [relay, output === "" ? "" : output.hookSpecificOutput.additionalContext]
    .filter((part) => part.length > 0)
    .join("\n\n");
  return text.length === 0 ? "" : JSON.stringify(envelope(text));
};

/**
 * The teammate groups this session's SUBAGENTS ran into, handed to the main
 * thread once: the queue is taken and emptied in ONE locked transform, so a
 * racing sibling finds it empty, and only groups still remembered are said.
 * A prompt inside a subagent (none fires today, but the payload would say so)
 * leaves the queue for the main thread. Fail open: a busy lock relays next
 * prompt, never twice.
 */
const relaySubagentCollisions = async (ctx: HookContext, budget: HookBudget): Promise<string> => {
  try {
    // Drained only while the spare budget lasts (review L3): a queue left
    // alone waits for the next prompt, a queue drained into an abandoned
    // hook is lost.
    if (ctx.payload.agent_id !== undefined || budget.spareMs() <= 0) {
      return "";
    }
    const state = await readSessionState(ctx.config.home, ctx.payload.session_id);
    if (state === null || (state.collisionRelayQueue ?? []).length === 0) {
      return "";
    }
    const taken: { value: readonly CollisionNotice[] } = { value: [] };
    const drained = await updateSessionState(ctx.config.home, ctx.payload.session_id, (fresh) => {
      const queue = fresh.collisionRelayQueue ?? [];
      if (queue.length === 0) {
        return null;
      }
      taken.value = (fresh.collisionNotices ?? []).filter((notice) => queue.includes(notice.key));
      return withDrainedCollisionRelays(fresh);
    });
    return drained ? renderSubagentCollisionRelay(taken.value, ctx.now()) : "";
  } catch {
    // Fail open: the prompt hook's own job (briefing or hint) is untouched.
    return "";
  }
};

/**
 * Fire-and-forget, through the SHARED door (core derive/spawn.ts): the child
 * is unref'd, its stdio ignored, a spawn failure swallowed — the work is
 * already booked and losing one worker is the cheap outcome (fail open). The
 * helper was this file's own until Cursor needed the identical shape; it took
 * the worker env, the ignored stdio and the unref with it, plus the agent
 * kind, which is REQUIRED there because a worker that is not told stamps
 * `claude-code` by default and would file a Cursor draft as a Claude one.
 */
const spawnDetached = (ctx: HookContext, cmd: readonly string[]): void => {
  spawnDeriveWorker({
    env: ctx.env,
    home: ctx.config.home,
    agentKind: ctx.config.agentKind,
    cmd,
  });
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
      return withIntentFire(fresh, ctx.now(), resolveSummarizerTimeoutMs(ctx.env));
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

const deliverPromptContext = async (ctx: HookContext, budget: HookBudget): Promise<PromptOutput | ""> => {
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
    tellsNotices: aPersonReads(ctx.env),
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
    // An author's notice is told on a prompt a person reads — never in a
    // headless run — within what the budget spares (landed changes, step 4).
    tellsNotices: aPersonReads(ctx.env),
    spareMs: () => budget.spareMs(),
  });
  if (text.length > 0) {
    return envelope(text);
  }
  // THIRD, and only on a prompt nothing else spoke on: the once-per-session
  // draft review nudge (flows/draft-nudge.ts says why a prompt and never Stop).
  const nudge = await deliverDraftNudge({
    home: ctx.config.home,
    hub: ctx.hub,
    hostSessionKey: ctx.payload.session_id,
    repoId: ctx.identity.repoId,
    now: ctx.now(),
    personReads: aPersonReads(ctx.env),
    spareMs: budget.spareMs,
  });
  return nudge.length === 0 ? "" : envelope(nudge);
};

export const handleUserPromptSubmit = async (
  ctx: HookContext,
  budget: HookBudget,
): Promise<string> => {
  // Delivers nothing, like the two fires above: the background fetch of the
  // landing branches (hooks/landing-fetch.ts), beside the prompt's own work so
  // it adds no wall clock of its own.
  const [output] = await Promise.all([deliverPromptContext(ctx, budget), requestLandingFetchFor(ctx)]);
  // A subagent's collision LAST (review L3): the queue is drained only once
  // everything else this prompt carries is in hand, so nothing slow sits
  // between emptying it and the relay leaving the hook. It still LEADS the
  // emitted text.
  const relay = await relaySubagentCollisions(ctx, budget);
  return serialize(output, relay);
};
