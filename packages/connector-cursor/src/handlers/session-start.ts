/**
 * sessionStart (§3.2 row 1): register through the shared flow — state
 * BEFORE any append (reap's aliveness invariant lives in the flow) — record
 * the observed cursor_version for doctor, then maintenance on the spare
 * budget exactly like Claude's SessionStart: flush what earlier sessions
 * left, reap what nothing owns.
 *
 * NO briefing yet: `additional_context` is Block 7's injection surface;
 * Block 6 renders nothing (§4.4 — this package registers no render
 * surfaces, and the registry meta-test would flag any it forgot).
 * is_background_agent chose the agent kind at config load (runner.ts):
 * cursor-background registers like any session and will get no injection
 * output when Block 7 lands.
 */
import { endSession } from "@crosscheck/connector-core/http/hub.ts";
import {
  fallbackWorkContextTitle,
  registerSessionFlow,
} from "@crosscheck/connector-core/flows/register-session.ts";
import { flushSpool } from "@crosscheck/connector-core/spool/flush.ts";
import { reapSpool } from "@crosscheck/connector-core/spool/reap.ts";
import type { DeferredEnder } from "@crosscheck/connector-core/spool/reap.ts";
import { updateSyncState } from "@crosscheck/connector-core/state/sync-state.ts";
import type { HookBudget } from "@crosscheck/connector-core/config/hook-budget.ts";

import type { CursorHookContext } from "../runner.ts";

const INITIAL_STATUS = "analyzing";

/**
 * The deferred SessionEnd reap may spend — `spareMs`, never the raw
 * remainder, for the reason measured in the Claude connector: a call started
 * inside the reserve finishes after the budget race has resolved and takes
 * the hook's own point with it (HOOK_RESERVE_RATIO's history).
 */
const deferredEnder =
  (ctx: CursorHookContext, budget: HookBudget): DeferredEnder =>
  async (crosscheckSessionId: string): Promise<boolean> => {
    const roomMs = budget.spareMs();
    if (roomMs <= 0) {
      return false;
    }
    const result = await endSession(
      { ...ctx.hub, timeoutMs: Math.min(ctx.hub.timeoutMs, roomMs) },
      crosscheckSessionId,
    );
    return result.ok;
  };

export const handleCursorSessionStart = async (
  ctx: CursorHookContext,
  budget: HookBudget,
): Promise<string> => {
  const now = ctx.now();
  const { crosscheckSessionId, developerId } = await registerSessionFlow({
    home: ctx.config.home,
    repoKey: ctx.repoKey,
    hub: ctx.hub,
    agentKind: ctx.config.agentKind,
    hostSessionKey: ctx.hostSessionKey,
    repoId: ctx.identity.repoId,
    repoRoot: ctx.identity.root,
    branch: ctx.identity.branch,
    baseCommit: ctx.identity.baseCommit,
    hubUrl: ctx.config.hubUrl,
    fallbackDeveloperId: ctx.config.developerId,
    // Cursor supplies no session title, and none is synthesized from
    // conversation content (§2.4 privacy posture — same as ACP).
    title: fallbackWorkContextTitle(ctx.identity.branch, ctx.identity.repoId),
    status: INITIAL_STATUS,
    now,
  });

  // The observed Cursor build, for doctor's ≥1.7 evidence (design §3.2).
  // Best-effort like every sync-state write.
  if (ctx.payload.cursor_version !== undefined) {
    await updateSyncState(ctx.config.home, ctx.repoKey, {
      cursorVersion: ctx.payload.cursor_version,
    });
  }

  // Maintenance on the spare budget, the Claude SessionStart order: flush
  // first so a session whose records just reached the hub is reaped in the
  // same pass. Our own state file exists by now, so reap can never remove
  // the file this session keeps appending to.
  await flushSpool(
    ctx.hub,
    { sessionId: crosscheckSessionId, developerId },
    budget.spareMs(),
  );
  await reapSpool(ctx.config.home, ctx.repoKey, now, deferredEnder(ctx, budget));
  return "";
};
