import {
  HOOK_RESERVE_RATIO,
  POST_TOOL_USE_BUDGET_RATIO,
  SESSION_END_BUDGET_RATIO,
  SESSION_START_BUDGET_RATIO,
} from "../constants.ts";
import {
  isDisabled,
  loadConfig,
  readStoredConfig,
  resolveTimeoutMs,
} from "../config/config.ts";
import type { ResolvedConfig } from "../config/config.ts";
import type { Env } from "../config/paths.ts";
import { crosscheckHome, repoKey } from "../config/paths.ts";
import { resolveRepoIdentity } from "../git/repo-identity.ts";
import type { RepoIdentity } from "../git/repo-identity.ts";
import type { HubContext } from "../http/client.ts";
import { parseHookPayload } from "../capture/tool-events.ts";
import type { HookPayload } from "../capture/tool-events.ts";

export type HookName = "session-start" | "post-tool-use" | "session-end";

export interface HookContext {
  readonly payload: HookPayload;
  readonly identity: RepoIdentity;
  readonly config: ResolvedConfig;
  readonly hub: HubContext;
  readonly repoKey: string;
  readonly now: () => Date;
}

/**
 * How much of the hosting hook's TOTAL budget maintenance may still spend, read
 * at the moment of the call — the same budget `withBudget` below enforces by
 * abandoning the hook.
 *
 * One grade, deliberately. `spareMs` is what may go to work the developer never
 * sees — draining the spool, ending a deferred session — and it already holds
 * the reserve back. There is no accessor for the rest: a hook's own essential
 * step is bounded by the per-request timeout and by the total-budget race, and
 * every time maintenance was handed the raw remainder instead it finished after
 * the race had already resolved and took the hook's whole point down with it
 * (see HOOK_RESERVE_RATIO for both measurements).
 */
export interface HookBudget {
  readonly spareMs: () => number;
}

export type HookHandler = (
  ctx: HookContext,
  budget: HookBudget,
) => Promise<string>;

const BUDGET_RATIOS: Readonly<Record<HookName, number>> = {
  "session-start": SESSION_START_BUDGET_RATIO,
  "post-tool-use": POST_TOOL_USE_BUDGET_RATIO,
  "session-end": SESSION_END_BUDGET_RATIO,
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
  const identity = await resolveRepoIdentity(payload.cwd);
  if (identity === null) {
    return null;
  }
  const config = await loadConfig({ env, repoRoot: identity.root });
  if (config === null) {
    return null;
  }
  const now = (): Date => new Date();
  const key = repoKey(config.hubUrl, identity.repoId);
  return {
    payload,
    identity,
    config,
    repoKey: key,
    now,
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

/** Total-hook budget: a slow hub must never hold the developer's session. */
const withBudget = async (
  work: Promise<string>,
  budgetMs: number,
): Promise<string> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(""), budgetMs);
  });
  try {
    return await Promise.race([work, budget]);
  } finally {
    clearTimeout(timer);
  }
};

interface ResolvedBudget {
  readonly budgetMs: number;
  /** Per-request timeout: the longest a single hub call can run. */
  readonly timeoutMs: number;
}

/**
 * The budget has to be known before repo identity spawns git, so it comes from
 * the environment plus the stored config — one small file read — rather than
 * from the fully resolved config.
 */
const resolveBudget = async (
  name: HookName,
  env: Env,
): Promise<ResolvedBudget> => {
  const stored = await readStoredConfig(crosscheckHome(env));
  const timeoutMs = resolveTimeoutMs(env, stored);
  return { budgetMs: timeoutMs * BUDGET_RATIOS[name], timeoutMs };
};

const hookBudget = (deadlineMs: number, timeoutMs: number): HookBudget => ({
  spareMs: () =>
    Math.max(0, deadlineMs - Date.now() - timeoutMs * HOOK_RESERVE_RATIO),
});

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
    const { budgetMs, timeoutMs } = await resolveBudget(name, env);
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
