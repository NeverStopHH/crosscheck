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
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import {
  crosscheckHome,
  repoKey,
} from "@crosscheck/connector-core/config/paths.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import type { RepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import type { HubContext } from "@crosscheck/connector-core/http/client.ts";
import {
  recordCaptureLoss,
  recordHookTimeout,
} from "@crosscheck/connector-core/state/loss-ledger.ts";
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
 * budget; beforeSubmitPrompt, stop and sessionEnd at their Claude siblings'
 * ratios.
 */
const BUDGET_RATIOS: Readonly<Record<CursorHookEvent, number>> = {
  sessionStart: SESSION_START_BUDGET_RATIO,
  // The prompt event runs at Claude's UserPromptSubmit ratio, which is the
  // sibling it is measured against (test/budget.test.ts): it is synchronous
  // on every submit, so the budget is the user's own felt latency.
  beforeSubmitPrompt: USER_PROMPT_SUBMIT_BUDGET_RATIO,
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
 * WHOSE LOSS A CURSOR EVENT WITH NO RESOLVED REPO IS (review M4). The
 * conversation's state file names the repo outright when an earlier hook
 * registered it — keyed, no other repo charged. Otherwise unkeyed (every
 * repo) only when a connected repo sits above the workspace root, the cwd,
 * CURSOR_PROJECT_DIR or the touched file (config/connected-repo.ts); a
 * folderless window or an unconnected checkout loses nothing any connected
 * repo would have captured, and charging them all over-reported for nothing.
 */
const cursorLossOwner = async (
  env: Env,
  payload: CursorPayload | null,
): Promise<{ readonly key: string | null } | null> => {
  const conversationId = safeHostSessionId(payload?.conversation_id ?? "");
  if (conversationId !== null) {
    const state = await readSessionState(crosscheckHome(env), cursorHostSessionKey(conversationId));
    if (state !== null) {
      return { key: repoKey(state.hubUrl, state.repoId) };
    }
  }
  const dirs = [payload?.workspace_roots?.[0], payload?.cwd, env["CURSOR_PROJECT_DIR"]].filter(
    (dir): dir is string => typeof dir === "string" && dir.length > 0,
  );
  const files = payload?.file_path === undefined ? [] : [payload.file_path];
  const owned = await mayBeConnectedRepo(env, dirs[0] ?? ROOT_DIR, dirs, files);
  return owned ? { key: null } : null;
};

/** Where relative candidates resolve when the payload names no directory at all. */
const ROOT_DIR = "/";

/**
 * THE EVENTS WHOSE ABANDONMENT CAN LOSE CAPTURE (review M4), the Claude
 * runner's split on this host: beforeSubmitPrompt derives intent (§4.8.7)
 * and sessionEnd ends and drains with the records left on disk (§4.8.4).
 */
const CURSOR_CAPTURE_EVENTS: ReadonlySet<CursorHookEvent> = new Set([
  "sessionStart",
  "afterFileEdit",
  "afterShellExecution",
  "postToolUse",
  "postToolUseFailure",
  "stop",
]);

const unresolvedCursorOwner = async (
  env: Env,
  stdin: string,
): Promise<{ readonly home: string; readonly key: string | null } | null> => {
  const owner = await cursorLossOwner(env, parseCursorPayload(stdin));
  return owner === null ? null : { home: crosscheckHome(env), key: owner.key };
};

/**
 * ONE DRIFTED PAYLOAD, BOOKED TWICE (docs/1.0/loss-accounting.md §3 row 19).
 * The drift ledger keeps the field names for doctor's "Cursor renamed
 * something"; the capture-loss ledger keeps the fact that capture got nothing
 * from this event, which is what reaches the hub's coverage — keyed or
 * unkeyed by `cursorLossOwner`, and not at all where no connected repo could
 * have captured it (review M4).
 */
const recordDrift = async (
  home: string,
  event: CursorHookEvent,
  missing: readonly string[],
  env: Env,
  payload: CursorPayload | null,
): Promise<void> => {
  await recordContractDrift(home, event, missing);
  const owner = await cursorLossOwner(env, payload);
  if (owner === null) {
    return;
  }
  await recordCaptureLoss(home, {
    kind: "host_contract_drift",
    count: 1,
    key: owner.key,
    detail: event,
    now: new Date(),
  });
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
    await recordDrift(home, event, [UNPARSEABLE_MARKER], env, null);
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
    await recordDrift(home, event, missing, env, payload);
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
    await recordDrift(home, event, ["conversation_id"], env, payload);
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

/** Where an abandoned hook's loss is booked: its repo once prepare resolved one. */
interface ResolvedLossKey {
  value: { readonly home: string; readonly key: string } | null;
}

const prepareAndRun = async (
  event: CursorHookEvent,
  handler: CursorHookHandler,
  stdin: string,
  env: Env,
  budget: HookBudget,
  resolved: ResolvedLossKey,
): Promise<string> => {
  const ctx = await prepareCursorHook(event, stdin, env);
  if (ctx === null) {
    return "";
  }
  resolved.value = { home: ctx.config.home, key: ctx.repoKey };
  return handler(ctx, budget);
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
    const resolved: ResolvedLossKey = { value: null };
    const outcome = await raceHookBudget(
      prepareAndRun(event, handler, stdin, env, hookBudget(deadlineMs, timeoutMs), resolved),
      budgetMs,
    );
    // The Claude runner's rule, same race (docs/1.0/loss-accounting.md §3
    // row 14): a handler the budget abandoned may not have captured, so it is
    // booked after the race — for capture events only, keyed when prepare
    // resolved the repo, else by `cursorLossOwner` (review M4).
    if (outcome.timedOut && CURSOR_CAPTURE_EVENTS.has(event)) {
      const owner = resolved.value ?? (await unresolvedCursorOwner(env, stdin));
      if (owner !== null) {
        await recordHookTimeout(owner.home, event, owner.key, new Date());
      }
    }
    return outcome.output.length === 0 ? CURSOR_NO_OP_OUTPUT : outcome.output;
  } catch {
    return CURSOR_NO_OP_OUTPUT;
  }
};
