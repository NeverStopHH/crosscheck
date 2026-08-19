/**
 * The cursor-hook process shell — the Claude connector's runner shape with
 * renamed events (design §3.1): short-lived process, JSON on stdin, JSON on
 * stdout, exit 0 always, everything under the shared budget race
 * (connector-core/config/hook-budget.ts — one implementation, same constants
 * family).
 *
 * FAIL-OPEN LADDER, in order, each rung silent:
 *   disabled → empty stdin → unparseable payload (drift-counted: Cursor
 *   sends JSON, so non-JSON on a registered hook is contract news) →
 *   missing mapped fields (drift-counted, §10 risk 5's named-death rule) →
 *   no workspace root (drift-counted — CURSOR_PROJECT_DIR is documented
 *   always-present) → not a git repo (normal non-install) → no config
 *   (no login on this machine — exactly how cloud agents running project
 *   hooks stay silent, no special-casing) → handler.
 *
 * Every rung answers CURSOR_NO_OP_OUTPUT: valid JSON, no directives — never
 * `permission`, never `followup_message`, never `continue` (§3.2).
 */
import {
  POST_TOOL_USE_BUDGET_RATIO,
  SESSION_END_BUDGET_RATIO,
  SESSION_START_BUDGET_RATIO,
  STOP_BUDGET_RATIO,
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
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import {
  crosscheckHome,
  repoKey,
} from "@crosscheck/connector-core/config/paths.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import type { RepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import type { HubContext } from "@crosscheck/connector-core/http/client.ts";
import {
  CURSOR_AGENT_KIND,
  CURSOR_BACKGROUND_AGENT_KIND,
  cursorHostSessionKey,
} from "@crosscheck/connector-core/state/host-session-key.ts";

import { CURSOR_NO_OP_OUTPUT } from "./constants.ts";
import { recordContractDrift } from "./drift.ts";
import {
  missingMappedFields,
  parseCursorPayload,
} from "./payload.ts";
import type { CursorHookEvent, CursorPayload } from "./payload.ts";

export interface CursorHookContext {
  readonly event: CursorHookEvent;
  readonly payload: CursorPayload;
  /** `cur-<conversation_id>` — minted once, used everywhere (§1.3). */
  readonly hostSessionKey: string;
  readonly identity: RepoIdentity;
  readonly config: ResolvedConfig;
  readonly hub: HubContext;
  readonly repoKey: string;
  readonly now: () => Date;
  readonly env: Env;
}

export type CursorHookHandler = (
  ctx: CursorHookContext,
  budget: HookBudget,
) => Promise<string>;

/**
 * Which event spends which ratio is host policy (the Claude runner's
 * BUDGET_RATIOS split): sessionStart hosts register + maintenance like
 * Claude's SessionStart; the three tool-shaped events run at the tool
 * budget; stop and sessionEnd at their Claude siblings' ratios.
 */
const BUDGET_RATIOS: Readonly<Record<CursorHookEvent, number>> = {
  sessionStart: SESSION_START_BUDGET_RATIO,
  afterFileEdit: POST_TOOL_USE_BUDGET_RATIO,
  afterShellExecution: POST_TOOL_USE_BUDGET_RATIO,
  postToolUse: POST_TOOL_USE_BUDGET_RATIO,
  postToolUseFailure: POST_TOOL_USE_BUDGET_RATIO,
  stop: STOP_BUDGET_RATIO,
  sessionEnd: SESSION_END_BUDGET_RATIO,
};

/** Marker the drift ledger uses for stdin that was not JSON at all. */
const UNPARSEABLE_MARKER = "(unparseable)";

/**
 * Resolves everything a handler needs, or null when the connector must stay
 * silent. Drift-counting happens HERE — the one choke point every payload
 * passes — so no handler can forget the tripwire.
 */
export const prepareCursorHook = async (
  event: CursorHookEvent,
  stdin: string,
  env: Env,
): Promise<CursorHookContext | null> => {
  if (isDisabled(env)) {
    return null;
  }
  // Empty stdin is a human poking the binary, not Cursor: silence, no drift.
  if (stdin.trim().length === 0) {
    return null;
  }
  const home = crosscheckHome(env);
  const payload = parseCursorPayload(stdin);
  if (payload === null) {
    await recordContractDrift(home, event, [UNPARSEABLE_MARKER]);
    return null;
  }
  const missing = [...missingMappedFields(event, payload)];
  // CURSOR_PROJECT_DIR is the documented backstop for workspace_roots — only
  // both absent is drift (payload.ts spells the rule).
  const workspaceRoot =
    payload.workspace_roots?.[0] ?? env["CURSOR_PROJECT_DIR"];
  if (workspaceRoot === undefined) {
    missing.push("workspace_roots");
  }
  if (missing.length > 0 || workspaceRoot === undefined) {
    await recordContractDrift(home, event, missing);
    return null;
  }
  const identity = await resolveRepoIdentity(workspaceRoot);
  if (identity === null) {
    return null;
  }
  const config = await loadConfig({
    env,
    repoRoot: identity.root,
    defaultAgentKind:
      payload.is_background_agent === true
        ? CURSOR_BACKGROUND_AGENT_KIND
        : CURSOR_AGENT_KIND,
  });
  if (config === null) {
    return null;
  }
  const now = (): Date => new Date();
  const key = repoKey(config.hubUrl, identity.repoId);
  return {
    event,
    payload,
    // conversation_id is non-empty here: missingMappedFields requires it
    // for every event.
    hostSessionKey: cursorHostSessionKey(payload.conversation_id ?? ""),
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
  event: CursorHookEvent,
  handler: CursorHookHandler,
  stdin: string,
  env: Env,
  budget: HookBudget,
): Promise<string> => {
  const ctx = await prepareCursorHook(event, stdin, env);
  return ctx === null ? "" : handler(ctx, budget);
};

/**
 * The one place cursor hooks are allowed to fail: everything is caught, and
 * the answer is ALWAYS valid no-directive JSON on exit 0 — Cursor treats
 * exit 2 as a block and other non-zero exits as hook failures worth logging;
 * this connector is never either.
 */
export const runCursorHookWith = async (
  event: CursorHookEvent,
  handler: CursorHookHandler,
  stdin: string,
  env: Env,
): Promise<string> => {
  try {
    const { budgetMs, timeoutMs } = await resolveHookBudget(
      BUDGET_RATIOS[event],
      env,
    );
    // Deadline taken a fraction BEFORE the race timer starts, so what the
    // handler believes it has left is never more than the truth.
    const deadlineMs = Date.now() + budgetMs;
    const out = await withBudget(
      prepareAndRun(event, handler, stdin, env, hookBudget(deadlineMs, timeoutMs)),
      budgetMs,
    );
    return out.length === 0 ? CURSOR_NO_OP_OUTPUT : out;
  } catch {
    return CURSOR_NO_OP_OUTPUT;
  }
};
