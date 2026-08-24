import {
  POST_TOOL_USE_BUDGET_RATIO,
  PRE_TOOL_USE_BUDGET_RATIO,
  SESSION_END_BUDGET_RATIO,
  SESSION_START_BUDGET_RATIO,
  STOP_BUDGET_RATIO,
  USER_PROMPT_SUBMIT_BUDGET_RATIO,
} from "@crosscheck/connector-core/constants.ts";
import {
  hookBudget,
  resolveHookBudget,
  withBudget,
} from "@crosscheck/connector-core/config/hook-budget.ts";
import type { HookBudget } from "@crosscheck/connector-core/config/hook-budget.ts";
import {
  isDisabled,
  isSummarizerChild,
  loadReportableConfig,
} from "@crosscheck/connector-core/config/config.ts";
import type { ResolvedConfig } from "@crosscheck/connector-core/config/config.ts";
import { findConnectedRepoRootForPaths } from "@crosscheck/connector-core/config/connected-repo.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { crosscheckHome, repoKey } from "@crosscheck/connector-core/config/paths.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import type { RepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import type { HubContext } from "@crosscheck/connector-core/http/client.ts";
import { recordHookFired } from "@crosscheck/connector-core/state/fired-markers.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { extractFilePaths, parseHookPayload } from "../capture/tool-events.ts";
import type { HookPayload } from "../capture/tool-events.ts";

export type HookName =
  | "session-start"
  | "post-tool-use"
  | "session-end"
  | "user-prompt-submit"
  | "pre-tool-use"
  | "stop";

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
   * detached summarizer worker it spawns (summarizer/worker-env.ts: the
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
  "session-end": SESSION_END_BUDGET_RATIO,
  "user-prompt-submit": USER_PROMPT_SUBMIT_BUDGET_RATIO,
  "pre-tool-use": PRE_TOOL_USE_BUDGET_RATIO,
  stop: STOP_BUDGET_RATIO,
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
 * The one place hooks are allowed to fail: everything is caught, nothing is
 * written to stderr, and the caller always exits 0 (spec §E). The budget covers
 * preparation too — resolving repo identity spawns several git processes, and a
 * slow git would otherwise blow the documented budget many times over.
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
  try {
    const { budgetMs, timeoutMs } = await resolveHookBudget(
      BUDGET_RATIOS[name],
      env,
    );
    // The handler's deadline is taken a fraction BEFORE the race timer starts,
    // so what the handler believes it has left is never more than the truth.
    const deadlineMs = Date.now() + budgetMs;
    // A holder rather than a plain `let`, so the assignment inside the
    // callback is visible to the narrowing below.
    const resolved: { value: { home: string; key: string } | null } = {
      value: null,
    };
    const output = await withBudget(
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
    return output;
  } catch {
    return "";
  }
};
