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
 *   always-present) → conversation id with nothing printable after the
 *   shared shape rule (drift-counted as conversation_id) → no reportable
 *   repo from the workspace root NOR from the touched file's path
 *   (resolveCursorRepo — the path-derived fallback, trial finding #9;
 *   normal non-install) → no config
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
  isSummarizerChild,
  loadReportableConfig,
} from "@crosscheck/connector-core/config/config.ts";
import type { ResolvedConfig } from "@crosscheck/connector-core/config/config.ts";
import { findConnectedRepoRootForPaths } from "@crosscheck/connector-core/config/connected-repo.ts";
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
  safeHostSessionId,
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

interface ResolvedCursorRepo {
  readonly identity: RepoIdentity;
  readonly config: ResolvedConfig;
}

/**
 * The repo this hook reports for: workspace root first, touched file second.
 *
 * The fallback is trial finding #9 — THE Cursor incident: a workspace
 * rooted at the PARENT folder of the repo (~/dev above ~/dev/monorepo)
 * makes every panel session invisible, because workspace-root resolution
 * finds no repo there while terminal sessions (cwd inside the repo) report
 * fine. When the workspace root says nothing, the edited file's own path is
 * walked up to its repo (core config/connected-repo.ts). The trust rule
 * (DESIGN.md §2.1) holds by construction — stricter than root resolution,
 * not looser: only a repo whose root carries the committed .crosscheck.json
 * resolves, re-checked at the resolved identity's root; events without a
 * file path (sessionStart, stop, shell) have nothing to derive from and
 * stay silent, so registration happens on the first connected-file touch
 * through the handlers' existing recovery (handlers/recover.ts).
 */
const resolveCursorRepo = async (
  payload: CursorPayload,
  workspaceRoot: string,
  env: Env,
  agentKind: string,
): Promise<ResolvedCursorRepo | null> => {
  const identity = await resolveRepoIdentity(workspaceRoot);
  if (identity !== null) {
    // The finding-#11 gate: under a user-level hooks.json (~/.cursor/) this
    // runs in every workspace, so a stored login must not stand in for the
    // missing committed config (core config.ts `loadReportableConfig`).
    const config = await loadReportableConfig({
      env,
      repoRoot: identity.root,
      defaultAgentKind: agentKind,
    });
    if (config !== null) {
      return { identity, config };
    }
  }
  const derivedRoot = await findConnectedRepoRootForPaths(
    payload.cwd ?? workspaceRoot,
    payload.file_path === undefined ? [] : [payload.file_path],
  );
  if (derivedRoot === null) {
    return null;
  }
  const derived = await resolveRepoIdentity(derivedRoot);
  if (derived === null) {
    return null;
  }
  // loadReportableConfig, NOT bare loadConfig: this rung must also honour the
  // finding-#11 gate AND its key-origin pin (core config.ts), or a planted
  // .crosscheck.json at the touched file's repo redirects the stored key
  // exactly where the workspace-root rung's pin refused it.
  const config = await loadReportableConfig({
    env,
    repoRoot: derived.root,
    defaultAgentKind: agentKind,
  });
  return config === null ? null : { identity: derived, config };
};

/**
 * Resolves everything a handler needs, or null when the connector must stay
 * silent. Drift-counting happens HERE — the one choke point every payload
 * passes — so no handler can forget the tripwire.
 *
 * VERIFY: grep -rln "await recordContractDrift" packages/connector-cursor/src | sort
 * PRINTS: packages/connector-cursor/src/runner.ts
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
  // The conversation id is host-minted, not charset-guaranteed: the shared
  // shape rule (host-session-key.ts) strips unprintables and digest-folds
  // oversized ids BEFORE the id can enter filenames, `cc_`/`wc_` ids or log
  // lines — an unshaped giant id used to throw ENAMETOOLONG out of every
  // state write and kill the session's capture with nothing counted. An id
  // with nothing printable left cannot key anything: named drift, silence.
  const conversationId = safeHostSessionId(payload.conversation_id ?? "");
  if (conversationId === null) {
    await recordContractDrift(home, event, ["conversation_id"]);
    return null;
  }
  const agentKind =
    payload.is_background_agent === true
      ? CURSOR_BACKGROUND_AGENT_KIND
      : CURSOR_AGENT_KIND;
  const resolved = await resolveCursorRepo(payload, workspaceRoot, env, agentKind);
  if (resolved === null) {
    return null;
  }
  const { identity, config } = resolved;
  const now = (): Date => new Date();
  const key = repoKey(config.hubUrl, identity.repoId);
  return {
    event,
    payload,
    hostSessionKey: cursorHostSessionKey(conversationId),
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
 *
 * The Tier-1 summarizer's child marker (core config.ts isSummarizerChild)
 * is honoured here too, before the budget: a nested `claude -p` does not
 * run Cursor hooks today, but a marker that only SOME entries honour is the
 * marker the next entry forgets — the Claude runner's rule, same rung.
 */
export const runCursorHookWith = async (
  event: CursorHookEvent,
  handler: CursorHookHandler,
  stdin: string,
  env: Env,
): Promise<string> => {
  if (isSummarizerChild(env)) {
    return CURSOR_NO_OP_OUTPUT;
  }
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
