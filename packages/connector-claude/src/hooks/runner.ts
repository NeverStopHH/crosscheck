import {
  POST_TOOL_USE_BUDGET_RATIO,
  POST_TOOL_USE_FAILURE_BUDGET_RATIO,
  PRE_TOOL_USE_BUDGET_RATIO,
  SESSION_END_BUDGET_RATIO,
  SESSION_START_BUDGET_RATIO,
  STOP_BUDGET_RATIO,
  SUBAGENT_RETURN_BUDGET_RATIO,
  SUBAGENT_STOP_BUDGET_RATIO,
  TURN_END_BUDGET_RATIO,
  USER_PROMPT_SUBMIT_BUDGET_RATIO,
} from "@crosscheck/connector-core/constants.ts";
import {
  hookBudget,
  raceHookBudget,
  resolveHookBudget,
} from "@crosscheck/connector-core/config/hook-budget.ts";
import type { HookBudget } from "@crosscheck/connector-core/config/hook-budget.ts";
import {
  isDisabled,
  isSummarizerChild,
  loadReportableConfig,
} from "@crosscheck/connector-core/config/config.ts";
import type { ResolvedConfig } from "@crosscheck/connector-core/config/config.ts";
import {
  findConnectedRepoRootForPaths,
  mayBeConnectedRepo,
} from "@crosscheck/connector-core/config/connected-repo.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { crosscheckHome, repoKey } from "@crosscheck/connector-core/config/paths.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import type { RepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import type { HubContext } from "@crosscheck/connector-core/http/client.ts";
import { recordHookFired } from "@crosscheck/connector-core/state/fired-markers.ts";
import { recordHookTimeout } from "@crosscheck/connector-core/state/loss-ledger.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { briefingSkippedLine } from "@crosscheck/connector-core/briefing/omission.ts";
import { recordBriefingOmission } from "@crosscheck/connector-core/state/briefing-omissions.ts";
import { bookLandedProbeCut } from "@crosscheck/connector-core/state/landed-probe-cuts.ts";
import { extractFilePaths, isEditTool, parseHookPayload } from "../capture/tool-events.ts";
import type { HookPayload } from "../capture/tool-events.ts";
import { sessionStartContext } from "./session-start-output.ts";
import { hasNothingToRelay } from "./subagent-return.ts";
import { hasNothingToRecheck } from "./turn-end.ts";

export type HookName =
  | "session-start"
  | "post-tool-use"
  | "post-tool-use-failure"
  | "session-end"
  | "user-prompt-submit"
  | "pre-tool-use"
  | "stop"
  | "subagent-stop"
  | "subagent-return"
  | "turn-end";

export interface HookContext {
  readonly payload: HookPayload;
  readonly identity: RepoIdentity;
  readonly config: ResolvedConfig;
  readonly hub: HubContext;
  readonly repoKey: string;
  readonly now: () => Date;
  /**
   * The environment the hook was invoked with — NOT process.env, which in
   * tests belongs to the test runner. The one consumer is the Stop hook,
   * which forwards it — minus the parent session's own markers — into the
   * detached summarizer worker it spawns (core model/worker-env.ts: the
   * nested claude needs the developer's whole login environment, USER
   * included).
   */
  readonly env: Env;
}

/**
 * The budget family MOVED to core for Block 6
 * (@crosscheck/connector-core/config/hook-budget.ts) — the Cursor connector's
 * hook processes run under the identical race and cannot import from this
 * package. Re-exported here reference-identically so existing import sites
 * (the hook handlers, test/hook-reserve.test.ts) keep working; the one thing
 * that stays local is BUDGET_RATIOS — which Claude event maps to which ratio
 * is host policy.
 */
export { hookBudget } from "@crosscheck/connector-core/config/hook-budget.ts";
export type { HookBudget } from "@crosscheck/connector-core/config/hook-budget.ts";

export type HookHandler = (
  ctx: HookContext,
  budget: HookBudget,
) => Promise<string>;

const BUDGET_RATIOS: Readonly<Record<HookName, number>> = {
  "session-start": SESSION_START_BUDGET_RATIO,
  "post-tool-use": POST_TOOL_USE_BUDGET_RATIO,
  "post-tool-use-failure": POST_TOOL_USE_FAILURE_BUDGET_RATIO,
  "session-end": SESSION_END_BUDGET_RATIO,
  "user-prompt-submit": USER_PROMPT_SUBMIT_BUDGET_RATIO,
  "pre-tool-use": PRE_TOOL_USE_BUDGET_RATIO,
  stop: STOP_BUDGET_RATIO,
  "subagent-stop": SUBAGENT_STOP_BUDGET_RATIO,
  "subagent-return": SUBAGENT_RETURN_BUDGET_RATIO,
  "turn-end": TURN_END_BUDGET_RATIO,
};

interface ResolvedHookRepo {
  readonly identity: RepoIdentity;
  readonly config: ResolvedConfig;
}

/**
 * The repo this hook reports for: cwd first, touched file second, the
 * session's own state file last (`stateDerivedHookRepo` below — the rung
 * that gives an already-registered parent-workspace session its prompt
 * surface back).
 *
 * The cwd path carries the same trust gate as the fallback since finding
 * #11 (`loadReportableConfig`): under a user-level install the hooks fire
 * in EVERY directory, so a stored login must not stand in for the missing
 * committed config — only CROSSCHECK_HUB_URL (explicit operator override)
 * or the repo's own .crosscheck.json makes a repo reportable. The FALLBACK
 * is trial finding #9: an editor whose workspace root is the PARENT of the
 * repo fires hooks with a cwd that resolves to nothing, and every session
 * in it was silently invisible. When cwd resolution yields no reportable
 * repo, the TOUCHED FILE's path is walked up to its own repo
 * (config/connected-repo.ts) — and the trust rule (DESIGN.md §2.1) holds
 * by construction, stricter still: the walk answers only a repo root whose
 * committed .crosscheck.json exists — env override included — the config
 * is re-checked at the RESOLVED identity's root (symlinks, worktrees), and
 * a payload with no file paths (SessionStart, prompts, Stop) has nothing
 * to derive from and stays silent — which is why registration on this path
 * happens on the first connected-file touch, through PostToolUse's
 * existing recovery.
 */
const resolveHookRepo = async (
  payload: HookPayload,
  env: Env,
): Promise<ResolvedHookRepo | null> => {
  const identity = await resolveRepoIdentity(payload.cwd);
  if (identity !== null) {
    const config = await loadReportableConfig({ env, repoRoot: identity.root });
    if (config !== null) {
      return { identity, config };
    }
  }
  const derivedRoot = await findConnectedRepoRootForPaths(
    payload.cwd,
    extractFilePaths(payload.tool_input),
  );
  if (derivedRoot !== null) {
    const derived = await resolveRepoIdentity(derivedRoot);
    if (derived !== null) {
      // loadReportableConfig, NOT bare loadConfig: this rung must also honour
      // the finding-#11 gate AND its key-origin pin, or a planted
      // .crosscheck.json at the touched file's repo redirects the stored key
      // exactly where rung 1's pin refused it.
      const config = await loadReportableConfig({ env, repoRoot: derived.root });
      if (config !== null) {
        return { identity: derived, config };
      }
    }
  }
  return stateDerivedHookRepo(payload, env);
};

/**
 * The LAST rung, for hooks that carry neither a resolvable cwd nor file
 * paths: a session ALREADY REGISTERED from this workspace — PostToolUse's
 * file-derived recovery wrote its state file — keeps firing prompts and
 * lifecycle hooks with the same unresolvable parent cwd, and rungs 1 and 2
 * left every one of them silent, so the session had no prompt surface at
 * all: no deferred briefing, no hints (the finding-#9 briefing-parity gap,
 * test/briefing-parity.test.ts).
 *
 * Trust is narrowed here, not widened: a state file exists only because a
 * PREVIOUS hook passed rung 1 or rung 2 for this very session, and nothing
 * is taken on faith from it — the identity is re-resolved at its repoRoot
 * and must still answer the SAME repo id (a moved, deleted or re-remoted
 * checkout reads as silence, never as a rebind), and the config is
 * re-checked at the resolved root exactly as rung 1 would — the finding-#11
 * gate included, so a .crosscheck.json deleted mid-session reads as silence
 * too. A session id with no state file — the unconnected-repo pin's shape —
 * resolves nothing, so "silent forever" stays true where it must.
 */
const stateDerivedHookRepo = async (
  payload: HookPayload,
  env: Env,
): Promise<ResolvedHookRepo | null> => {
  const state = await readSessionState(crosscheckHome(env), payload.session_id);
  if (state === null) {
    return null;
  }
  const identity = await resolveRepoIdentity(state.repoRoot);
  if (identity === null || identity.repoId !== state.repoId) {
    return null;
  }
  const config = await loadReportableConfig({ env, repoRoot: identity.root });
  return config === null ? null : { identity, config };
};

/**
 * Resolves everything a hook needs, or null when the connector must stay
 * silent (disabled, not a git repo, no hub configured).
 */
export const prepareHook = async (
  stdin: string,
  env: Env,
): Promise<HookContext | null> => {
  if (isDisabled(env)) {
    return null;
  }
  const payload = parseHookPayload(stdin);
  if (payload === null) {
    return null;
  }
  const resolved = await resolveHookRepo(payload, env);
  if (resolved === null) {
    return null;
  }
  const { identity, config } = resolved;
  const now = (): Date => new Date();
  const key = repoKey(config.hubUrl, identity.repoId);
  return {
    payload,
    identity,
    config,
    repoKey: key,
    now,
    env,
    hub: {
      hubUrl: config.hubUrl,
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
      home: config.home,
      repoKey: key,
      now,
    },
  };
};

/**
 * `onResolved` exists so the caller can learn WHICH repo this hook resolved
 * to without re-running `prepareHook` (which re-reads config and re-resolves
 * git identity). It fires only when the hook is actually going to do
 * something: a disabled connector, an unparseable payload or an unreportable
 * repo return null above it and record nothing, which is right — a hook that
 * stayed silent by design did not "fire" in any sense a doctor cares about.
 */
const prepareAndRun = async (
  handler: HookHandler,
  stdin: string,
  env: Env,
  budget: HookBudget,
  onResolved: (ctx: HookContext) => void,
): Promise<string> => {
  const ctx = await prepareHook(stdin, env);
  if (ctx === null) {
    return "";
  }
  onResolved(ctx);
  return handler(ctx, budget);
};

/**
 * THE HOOKS WHOSE ABANDONMENT CAN LOSE CAPTURE (review M4). SessionStart
 * registers the session and spools its work context; PostToolUse spools the
 * targets; PostToolUseFailure the fingerprint; Stop and SubagentStop the git
 * lane (SubagentStop over the subagent's own root). The rest
 * capture nothing a coverage question reads: PreToolUse spools the
 * tripwire's ask and UserPromptSubmit its hint deliveries (informational,
 * loss-accounting §3 row 25), and SessionEnd's end and drain leave the
 * records on disk (§4.8.4) — a slow hub cutting those is no loss, and booking
 * it made a slow hub read `telemetry_lost`.
 */
const CAPTURE_HOOKS: ReadonlySet<HookName> = new Set([
  "session-start",
  "post-tool-use",
  "post-tool-use-failure",
  "stop",
  "subagent-stop",
]);

interface LossOwner {
  readonly home: string;
  readonly key: string | null;
}

/**
 * WHERE A CAPTURE HOOK THE BUDGET CUT BEFORE PREPARE RESOLVED ITS REPO IS
 * BOOKED (review M4). Its session's state file names the repo outright when
 * an earlier hook registered it — keyed, no other repo charged. Otherwise
 * unkeyed (every repo) only when a connected repo sits above its cwd or a
 * touched file (config/connected-repo.ts mayBeConnectedRepo); in an
 * unconnected checkout no run of the hook would have captured for anyone,
 * and charging every connected repo there over-reported for nothing.
 */
const unresolvedOwner = async (stdin: string, env: Env): Promise<LossOwner | null> => {
  const payload = parseHookPayload(stdin);
  if (payload === null) {
    return null;
  }
  const home = crosscheckHome(env);
  const state = await readSessionState(home, payload.session_id);
  if (state !== null) {
    return { home, key: repoKey(state.hubUrl, state.repoId) };
  }
  const owned = await mayBeConnectedRepo(env, payload.cwd, [payload.cwd], extractFilePaths(payload.tool_input));
  return owned ? { home, key: null } : null;
};

/**
 * THE HOOKS WHOSE ANSWER IS THE BRIEFING, and how each wraps one line of
 * context. Only these speak when they lose their answer: a PostToolUse that
 * printed something would land in the reader's context unasked.
 */
const BRIEFING_OUTPUTS: Partial<Readonly<Record<HookName, (text: string) => string>>> = {
  "session-start": sessionStartContext,
};

/**
 * A BRIEFING HOOK THAT LOST ITS BRIEFING SAYS SO (2026-10-08) — the budget
 * won the race, or the handler threw — and books the omission for doctor
 * (state/briefing-omissions.ts). Before, both answered "", so the person
 * read an empty session as a quiet repo and nothing told them otherwise.
 *
 * Owned exactly like a capture loss (`unresolvedOwner`, review M4): a repo
 * the hook resolved, a session state naming one, or a connected repo above
 * the cwd. Anywhere else the hook would have been silent anyway — under a
 * user-level install it fires in every directory, and a line there would be
 * noise — so null, and the caller keeps its old answer.
 */
const skippedBriefing = async (
  name: HookName,
  reason: "budget" | "error",
  resolvedOwner: LossOwner | null,
  stdin: string,
  env: Env,
): Promise<string | null> => {
  const output = BRIEFING_OUTPUTS[name];
  if (output === undefined) {
    return null;
  }
  const owner = resolvedOwner ?? (await unresolvedOwner(stdin, env));
  if (owner === null) {
    return null;
  }
  await recordBriefingOmission(owner.home, { key: owner.key, reason, now: new Date() });
  return output(briefingSkippedLine(reason));
};

/**
 * A PRE-EDIT HOOK THE BUDGET CUT TOOK ITS LANDED-CHANGE CHECK WITH IT
 * (2026-10-08). Under load the steps before the probe — the state read, the
 * tool window's lock, the edited file's root — can spend most of the race,
 * and then the race abandons the handler before its probe comes back or
 * before it books what came back: no stop, and, unbooked, no trace either.
 * The edit tool's cut is booked here, after the race, with reason `budget`,
 * through the once-per-call door the handler uses (state/landed-probe-cuts.ts
 * bookLandedProbeCut), so a handler that booked just before the race
 * resolved is not booked twice. Owned like a capture loss (`unresolvedOwner`);
 * a tool that edits nothing had no check to lose. Fail open: the answer was
 * already "" and stays it.
 */
const bookCutEditCheck = async (resolvedOwner: LossOwner | null, stdin: string, env: Env): Promise<void> => {
  const payload = parseHookPayload(stdin);
  if (payload === null || !isEditTool(payload.tool_name)) {
    return;
  }
  const owner = resolvedOwner ?? (await unresolvedOwner(stdin, env));
  if (owner === null) {
    return;
  }
  await bookLandedProbeCut({
    home: owner.home,
    sessionId: payload.session_id,
    toolUseId: payload.tool_use_id ?? null,
    key: owner.key,
    reason: "budget",
    now: new Date(),
  }).catch(() => undefined);
};

/**
 * The one place hooks are allowed to fail: everything is caught, nothing is
 * written to stderr, and the caller always exits 0 (spec §E). The budget covers
 * preparation too — resolving repo identity spawns several git processes, and a
 * slow git would otherwise blow the documented budget many times over. Failing
 * is allowed, failing SILENTLY is not, for the one hook whose answer is the
 * briefing: a SessionStart the budget cut or a throw ended answers the line
 * that says so (`skippedBriefing`, 2026-10-08), never an empty session.
 *
 * FIRST, before the budget, before any file or git is touched: a hook
 * running inside the Tier-1 summarizer's own nested `claude -p` (the
 * child marker, config/config.ts isSummarizerChild) returns silence. Trial
 * finding #14 — the nested claude ran crosscheck's globally installed hooks
 * and minted phantom sessions; a Stop inside it could have fired the
 * summarizer again. The lean argv keeps hooks out of that process too, but
 * this exit does not depend on which flags a Claude Code version honours.
 * It sits here and not in prepareHook beside isDisabled on purpose: that
 * rung already pays budget resolution (a config read); this one must cost
 * nothing — microseconds on every ordinary hook, no budget regression.
 */
export const runHookWith = async (
  name: HookName,
  handler: HookHandler,
  stdin: string,
  env: Env,
): Promise<string> => {
  if (isSummarizerChild(env)) {
    return "";
  }
  // The subagent-return hook fires on EVERY Agent/Task call in the main
  // thread, and nearly every one has nothing to relay: answered from the
  // payload and one state read, BEFORE the budget's config read and the repo
  // identity's git spawns, and without a fired marker (round 2, M2;
  // hooks/subagent-return.ts).
  if (name === "subagent-return" && (await hasNothingToRelay(stdin, env))) {
    return "";
  }
  // The turn-end hook fires at the end of EVERY turn, and nearly every turn
  // has no file resting: answered the same way (round 3, F-M2;
  // hooks/turn-end.ts).
  if (name === "turn-end" && (await hasNothingToRecheck(stdin, env))) {
    return "";
  }
  // A holder rather than a plain `let`, so the assignment inside the
  // callback is visible to the narrowing below — and outside the `try`, so
  // a hook that threw can still say which repo lost its briefing.
  const resolved: { value: { home: string; key: string } | null } = {
    value: null,
  };
  try {
    const { budgetMs, timeoutMs } = await resolveHookBudget(
      BUDGET_RATIOS[name],
      env,
    );
    // The handler's deadline is taken a fraction BEFORE the race timer starts,
    // so what the handler believes it has left is never more than the truth.
    const deadlineMs = Date.now() + budgetMs;
    const outcome = await raceHookBudget(
      prepareAndRun(
        handler,
        stdin,
        env,
        hookBudget(deadlineMs, timeoutMs),
        (ctx) => {
          resolved.value = { home: ctx.config.home, key: ctx.repoKey };
        },
      ),
      budgetMs,
    );
    // THE BUDGET WON, SO THE CAPTURE MAY NOT HAVE HAPPENED
    // (docs/1.0/loss-accounting.md §3 row 14): the binary exits on the ""
    // the race answered, abandoning whatever the handler had not yet
    // written. Booked here, after the race, for the reason the fired marker
    // below is — and keyed to the repo when prepare got that far, unkeyed
    // (charged to every repo) when the budget beat repo identity.
    if (outcome.timedOut && CAPTURE_HOOKS.has(name)) {
      const owner = resolved.value ?? (await unresolvedOwner(stdin, env));
      if (owner !== null) {
        await recordHookTimeout(owner.home, name, owner.key, new Date());
      }
    }
    if (outcome.timedOut && name === "pre-tool-use") {
      await bookCutEditCheck(resolved.value, stdin, env);
    }
    // AFTER the race, on purpose (trial finding M2, and the one budget risk
    // this row carries). Inside the raced promise this write would compete
    // with the handler for the deadline and could cost a SessionStart its
    // briefing; worse, the race resolving underneath it would abandon it
    // half-done. Out here it is one atomic `writePrivateFile` of an object
    // with at most six keys — no readdir, no scan — on a hook that has
    // already produced its answer, and `recordHookFired` swallows every
    // error of its own, so a read-only home costs the marker and nothing else.
    if (resolved.value !== null) {
      await recordHookFired(
        resolved.value.home,
        resolved.value.key,
        name,
        new Date(),
      );
    }
    return outcome.timedOut
      ? ((await skippedBriefing(name, "budget", resolved.value, stdin, env)) ?? outcome.output)
      : outcome.output;
  } catch {
    // Still the one place a hook may fail — but a briefing hook that failed
    // says so in the session instead of leaving it looking quiet.
    return (await skippedBriefing(name, "error", resolved.value, stdin, env).catch(() => null)) ?? "";
  }
};
