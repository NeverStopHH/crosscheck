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
 *      so one prompt carries at most one injection. Its ghost rows that
 *      share files are told to the PERSON too, as SessionStart's are
 *      (hooks/ghost-notice.ts; review L5).
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
 * AND ONE LINE THAT RIDES UNDER WHATEVER ELSE IS SAID (2026-10-08): how many
 * of this session's landed-change checks were cut short, once per session
 * (claimProbeCutsNote below). Not a fourth delivery competing for the slot —
 * a line about the connector's own reach, in the shape of the briefing's
 * "this briefing is incomplete" line, and it never displaces team knowledge.
 * It is APPENDED to the prompt's own text, after the hint.
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
 * when something is queued. A queue already waiting is drained BEFORE the
 * prompt's own hub calls, which then get only the budget it leaves (round 2,
 * M3): a slow hint hub can cost the hint, never the relay.
 *
 * This hook is the Claude-specific shell: payload fields in,
 * `hookSpecificOutput` envelope out.
 */
import { resolve } from "node:path";

import { aPersonReads } from "@crosscheck/connector-core/config/tripwire.ts";
import { selfSpawnCmd } from "@crosscheck/connector-core/config/runtime-isolation.ts";
import { INTENT_PROMPT_MAX_CHARS, MIN_SPARE_BOUND_TIMEOUT_MS } from "@crosscheck/connector-core/constants.ts";
import { cutWellFormed } from "@crosscheck/connector-core/briefing/cut.ts";
import {
  intentPromptPathForSlug,
  sessionSlug,
  writePrivateFile,
} from "@crosscheck/connector-core/config/paths.ts";
import { payDeferredBriefing } from "@crosscheck/connector-core/flows/briefing.ts";
import type { GhostCheckEntry } from "@crosscheck/connector-core/http/hub.ts";
import { deliverDraftNudge } from "@crosscheck/connector-core/flows/draft-nudge.ts";
import { selectAndRenderHint } from "@crosscheck/connector-core/flows/hint.ts";
import {
  hasUntoldProbeCuts,
  readSessionState,
  updateSessionState,
  withLandedProbeCutsTold,
} from "@crosscheck/connector-core/state/session-state.ts";
import { landedProbeCutsLine } from "@crosscheck/connector-core/briefing/omission.ts";
import type { RenderableCollision } from "@crosscheck/connector-core/hints/collision-notice.ts";
import type { HubContext } from "@crosscheck/connector-core/http/client.ts";
import { NO_DRAIN, agentCopy, drainCollisionRelay, hasPendingRelay, personCopy, sweptAgentCopy } from "./collision-relay.ts";
import type { RelayDrain } from "./collision-relay.ts";
import { tellPersonOfGhosts } from "./ghost-notice.ts";
import { recheckOverdueRests } from "./rest-recheck.ts";
import { hasGhostAllowance, withGhostClaimed } from "@crosscheck/connector-core/derive/ghost/gate.ts";
import { intentPromptFrom, isIntentFireSpent, withIntentFire } from "@crosscheck/connector-core/derive/intent/gate.ts";
import { resolveSummarizerTimeoutMs } from "@crosscheck/connector-core/model/runner.ts";
import { classifyPrompt } from "@crosscheck/schema";
import type { ClassifiedPrompt } from "@crosscheck/schema";
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

/** What the prompt's own delivery produced, and the ghost rows a paid briefing really shows. */
interface PromptDelivery {
  readonly output: PromptOutput | "";
  readonly shownGhosts: readonly GhostCheckEntry[];
}

const nonEmpty = (part: string): boolean => part.length > 0;

/**
 * The relay first, then the prompt's own delivery; "" when neither spoke. A
 * drained relay is ALSO the person's line (review H1a): `systemMessage` on
 * this sync hook is shown to the person, which no subagent hook's output is
 * documented to be — a person who already saw it there sees it twice, which
 * is the accepted cost of never seeing it at all. A paid briefing's ghost
 * groups follow it there (review L5), in the SAME render (round 2, L4): two
 * renders capped apart gave one `systemMessage` eight lines.
 */
const serialize = (
  output: PromptOutput | "",
  relay: RelayDrain,
  swept: readonly RenderableCollision[],
  ghosts: readonly RenderableCollision[],
  now: Date,
): string => {
  const text = [
    agentCopy(relay, now),
    sweptAgentCopy(swept, now),
    output === "" ? "" : output.hookSpecificOutput.additionalContext,
  ]
    .filter(nonEmpty)
    .join("\n\n");
  if (text.length === 0) {
    return "";
  }
  const person = personCopy(relay, now, [...swept, ...ghosts]);
  return JSON.stringify(person.length === 0 ? envelope(text) : { systemMessage: person, ...envelope(text) });
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
    ...selfSpawnCmd(INTENT_WORKER_ENTRY_PATH),
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
const maybeSpawnIntentWorker = async (ctx: HookContext, classified: ClassifiedPrompt): Promise<void> => {
  try {
    const prompt = intentPromptFrom(classified);
    if (prompt === null) {
      return;
    }
    const state = await readSessionState(ctx.config.home, ctx.payload.session_id);
    if (state === null || isIntentFireSpent(state)) {
      return;
    }
    let fired = false;
    await updateSessionState(ctx.config.home, ctx.payload.session_id, (fresh) => {
      if (isIntentFireSpent(fresh)) {
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
      ...selfSpawnCmd(GHOST_WORKER_ENTRY_PATH),
      "--session",
      ctx.payload.session_id,
    ]);
  } catch {
    // Fail open: the prompt hook's own job (briefing or hint) is untouched.
  }
};

/**
 * THE ONCE-PER-SESSION LINE ABOUT CUT LANDED-CHANGE CHECKS (2026-10-08). An
 * edit whose landed-change check was cut short prints nothing itself — the
 * stop it could not finish is about one file, and a line on every edit of a
 * slow repo is the noise the once-per-file rule exists to prevent — so
 * hooks/pre-tool-use.ts only BOOKS the cut (the session counter and
 * state/landed-probe-cuts.ts). This prompt is the session's next moment a
 * person reads, and it says how many, once.
 *
 * Here and not at SessionStart: the counter belongs to one session, and a
 * session's start comes before every edit that could fill it.
 *
 * Claimed under the state lock like every once-only marker, so two racing
 * prompts say it once; a plain read first, so a session with nothing to tell
 * pays no lock round; never in a headless run, where nobody reads it and the
 * claim would only spend it (`crosscheck doctor` counts the cuts either way).
 * Claimed BEFORE the rest of the prompt's work, while the whole budget is
 * still ahead: claimed after it, a hint that spent the budget would have the
 * race resolve with the claim still in flight, marking it told unsaid. The
 * one way it is still lost is a prompt whose own work then overruns the
 * whole race — that prompt loses everything it would have said, this line
 * with it, and the ledger doctor and status count still holds every cut.
 */
const claimProbeCutsNote = async (ctx: HookContext): Promise<string> => {
  if (!aPersonReads(ctx.env)) {
    return "";
  }
  const state = await readSessionState(ctx.config.home, ctx.payload.session_id);
  if (state === null || !hasUntoldProbeCuts(state)) {
    return "";
  }
  // A holder rather than a plain `let`, so the assignment inside the
  // callback is visible after it.
  const told: { cuts: number } = { cuts: 0 };
  const isWritten = await updateSessionState(ctx.config.home, ctx.payload.session_id, (fresh) => {
    if (!hasUntoldProbeCuts(fresh)) {
      return null;
    }
    told.cuts = fresh.landedProbeCuts ?? 0;
    return withLandedProbeCutsTold(fresh);
  });
  return isWritten && told.cuts > 0 ? landedProbeCutsLine(told.cuts) : "";
};

/**
 * What this prompt says: its own text, the cut-checks line APPENDED under it,
 * and the ghost rows a paid briefing really shows. The relay, drained before
 * this runs, leads the whole (handleUserPromptSubmit, serialize).
 */
const deliverPromptContext = async (ctx: HookContext, budget: HookBudget): Promise<PromptDelivery> => {
  // Fail open, like the two fires: a state file that cannot be read or
  // locked costs this line, never the prompt's own text.
  const note = await claimProbeCutsNote(ctx).catch(() => "");
  const own = await promptText(ctx, budget);
  const whole = [own.text, note].filter(nonEmpty).join("\n");
  return { output: whole.length === 0 ? "" : envelope(whole), shownGhosts: own.shownGhosts };
};

/** The prompt's own text — briefing, hint or nudge — and the ghost rows a paid briefing shows. */
interface PromptText {
  readonly text: string;
  readonly shownGhosts: readonly GhostCheckEntry[];
}

const spoken = (text: string): PromptText => ({ text, shownGhosts: [] });

const promptText = async (ctx: HookContext, budget: HookBudget): Promise<PromptText> => {
  // ONE CLASSIFICATION of the prompt for the whole hook — the intent fire and
  // the hint read the same one (hold-out review round 3, L4).
  const classified = classifyPrompt(ctx.payload.prompt ?? "");
  // The derived-intent fire delivers nothing and runs first, so it happens
  // on the first substantive prompt whatever else this hook goes on to emit.
  await maybeSpawnIntentWorker(ctx, classified);
  // The ghost debt, likewise: nothing is emitted here, and a session that
  // owes nothing pays one state read it had already made.
  await maybeSpawnGhostWorker(ctx);
  // The deferred briefing never reads the prompt text, so it sits BEFORE the
  // hint pipeline's meaning floor and secret gate: a session owed a briefing
  // gets it whatever the first prompt says. Exactly-once and the
  // failed-assembly semantics live on the flow.
  const paid = await payDeferredBriefing({
    home: ctx.config.home,
    repoKey: ctx.repoKey,
    hub: ctx.hub,
    hostSessionKey: ctx.payload.session_id,
    repoId: ctx.identity.repoId,
    agentKind: ctx.config.agentKind,
    now: ctx.now(),
    tellsNotices: aPersonReads(ctx.env),
  });
  if (paid.briefing.length > 0) {
    return { text: paid.briefing, shownGhosts: paid.shownGhosts };
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
    classified,
  });
  if (text.length > 0) {
    return spoken(text);
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
  return spoken(nudge);
};

/** Whether a subagent's collision is waiting for this prompt — one state read. */
const hasQueuedRelay = async (ctx: HookContext): Promise<boolean> => {
  const state = await readSessionState(ctx.config.home, ctx.payload.session_id);
  return state !== null && hasPendingRelay(state);
};

/**
 * The prompt's hub calls held to what the budget has LEFT (round 2, M3): the
 * request timeout every call reads is the configured one or the spare at the
 * moment the call starts, whichever is smaller — never past the reserve that
 * carries an already-drained relay out of the hook.
 */
const withSpareBoundHub = (ctx: HookContext, budget: HookBudget): HookContext => {
  const configured = ctx.hub.timeoutMs;
  const hub: HubContext = {
    ...ctx.hub,
    get timeoutMs(): number {
      return Math.max(MIN_SPARE_BOUND_TIMEOUT_MS, Math.min(configured, budget.spareMs()));
    },
  };
  return { ...ctx, hub };
};

export const handleUserPromptSubmit = async (
  ctx: HookContext,
  budget: HookBudget,
): Promise<string> => {
  // A subagent's collision queued BEFORE this prompt is drained FIRST (round
  // 2, M3): the drain is local — one state read and one lock — and drained
  // last, behind a hint hub answering in 390 ms of a 400 ms timeout, it found
  // no spare left on every prompt and a background subagent's collision never
  // reached anybody. The prompt's own delivery then gets only the budget that
  // is left, so the drained relay always leaves the hook.
  // Beside it, the rechecks owed for rests that are over (round 3, F-M2;
  // hooks/rest-recheck.ts) — a turn that crashed, was killed or was cut before
  // its end pays them on the next prompt — and a group either found is held
  // the same way: the prompt's own hub calls get only what is left.
  const [early, swept] = await Promise.all([
    hasQueuedRelay(ctx).then((isQueued) => (isQueued ? drainCollisionRelay(ctx, budget) : NO_DRAIN)),
    recheckOverdueRests(ctx, budget, USER_PROMPT_SUBMIT_HOOK),
  ]);
  const isDrainedEarly = early.groups.length > 0 || early.hidden > 0;
  const isHoldingTold = isDrainedEarly || swept.length > 0;
  const promptCtx = isHoldingTold ? withSpareBoundHub(ctx, budget) : ctx;
  // Delivers nothing, like the two fires above: the background fetch of the
  // landing branches (hooks/landing-fetch.ts), beside the prompt's own work so
  // it adds no wall clock of its own.
  const [delivery] = await Promise.all([deliverPromptContext(promptCtx, budget), requestLandingFetchFor(ctx)]);
  // A collision queued WHILE this prompt ran (a background subagent) is
  // drained last, and only while the spare lasts (review L3): nothing slow
  // sits between emptying the queue and the relay leaving the hook. Either
  // way the relay LEADS the emitted text.
  const relay = isDrainedEarly ? early : await drainCollisionRelay(ctx, budget);
  // A paid briefing's ghost rows are claimed told after that, as SessionStart
  // claims its own (review L5): one lock write, the last thing before output,
  // and not gated on the spare — it is this prompt's own delivery.
  const ghosts = await tellPersonOfGhosts(ctx, delivery.shownGhosts);
  return serialize(delivery.output, relay, swept, ghosts, ctx.now());
};

/** This hook, as the loss ledger names it. */
const USER_PROMPT_SUBMIT_HOOK = "user-prompt-submit";
