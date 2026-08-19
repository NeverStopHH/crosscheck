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
  loadConfig,
} from "@crosscheck/connector-core/config/config.ts";
import type { ResolvedConfig } from "@crosscheck/connector-core/config/config.ts";
import { findConnectedRepoRootForPaths } from "@crosscheck/connector-core/config/connected-repo.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import { readRepoConfig } from "@crosscheck/connector-core/config/repo-config.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import type { RepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import type { HubContext } from "@crosscheck/connector-core/http/client.ts";
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
   * which must forward selected variables (summarizer override, PATH) into
   * the detached worker it spawns.
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
 * The repo this hook reports for: cwd first, touched file second.
 *
 * The cwd path is untouched shipped behavior. The FALLBACK is trial finding
 * #9: an editor whose workspace root is the PARENT of the repo fires hooks
 * with a cwd that resolves to nothing, and every session in it was silently
 * invisible. When cwd resolution yields no reportable repo, the TOUCHED
 * FILE's path is walked up to its own repo (config/connected-repo.ts) —
 * and the trust rule (DESIGN.md §2.1) holds by construction, stricter than
 * the cwd path, not looser: the walk answers only a repo root whose
 * committed .crosscheck.json exists, the config is re-checked at the
 * RESOLVED identity's root (symlinks, worktrees), and a payload with no
 * file paths (SessionStart, prompts, Stop) has nothing to derive from and
 * stays silent — which is why registration on this path happens on the
 * first connected-file touch, through PostToolUse's existing recovery.
 */
const resolveHookRepo = async (
  payload: HookPayload,
  env: Env,
): Promise<ResolvedHookRepo | null> => {
  const identity = await resolveRepoIdentity(payload.cwd);
  if (identity !== null) {
    const config = await loadConfig({ env, repoRoot: identity.root });
    if (config !== null) {
      return { identity, config };
    }
  }
  const derivedRoot = await findConnectedRepoRootForPaths(
    payload.cwd,
    extractFilePaths(payload.tool_input),
  );
  if (derivedRoot === null) {
    return null;
  }
  const derived = await resolveRepoIdentity(derivedRoot);
  if (derived === null || (await readRepoConfig(derived.root)) === null) {
    return null;
  }
  const config = await loadConfig({ env, repoRoot: derived.root });
  return config === null ? null : { identity: derived, config };
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

const prepareAndRun = async (
  handler: HookHandler,
  stdin: string,
  env: Env,
  budget: HookBudget,
): Promise<string> => {
  const ctx = await prepareHook(stdin, env);
  return ctx === null ? "" : handler(ctx, budget);
};

/**
 * The one place hooks are allowed to fail: everything is caught, nothing is
 * written to stderr, and the caller always exits 0 (spec §E). The budget covers
 * preparation too — resolving repo identity spawns several git processes, and a
 * slow git would otherwise blow the documented budget many times over.
 */
export const runHookWith = async (
  name: HookName,
  handler: HookHandler,
  stdin: string,
  env: Env,
): Promise<string> => {
  try {
    const { budgetMs, timeoutMs } = await resolveHookBudget(
      BUDGET_RATIOS[name],
      env,
    );
    // The handler's deadline is taken a fraction BEFORE the race timer starts,
    // so what the handler believes it has left is never more than the truth.
    const deadlineMs = Date.now() + budgetMs;
    return await withBudget(
      prepareAndRun(handler, stdin, env, hookBudget(deadlineMs, timeoutMs)),
      budgetMs,
    );
  } catch {
    return "";
  }
};
