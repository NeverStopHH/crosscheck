/**
 * sessionStart (§3.2 row 1 + §3.3 briefing): register through the shared
 * flow — state BEFORE any append (reap's aliveness invariant lives in the
 * flow) — record the observed cursor_version for doctor, assemble the
 * briefing through the SAME core flow as the Claude SessionStart, then
 * maintenance on the spare budget: flush what earlier sessions left, reap
 * what nothing owns.
 *
 * INJECTION ORDER IS THE CLAUDE ORDER: everything the developer actually
 * sees — the session, the work context, the briefing — is in hand before
 * any maintenance, and every hub call the maintenance can make is held to
 * `spareMs` (the reserve is what carries the briefing out of the hook; the
 * measurements live on HOOK_RESERVE_RATIO). The briefing itself is
 * `assembleBriefing`: six parallel hub GETs each bounded by the per-request
 * timeout, fail-open per section — a hung hub costs sections, never the
 * hook. budget.test.ts measures that degraded path; the per-request
 * timeouts carry those bounds, and the race backstop itself is pinned
 * deterministically in connector-claude/test/hook-budget.test.ts (held by
 * a mutation-check entry).
 *
 * `additional_context` is the documented sessionStart output; the emitted
 * stdout is `cursorInjectionOutput` — the registered §4.4 surface module —
 * and empty briefings stay silent (`{}`). `is_background_agent: true`
 * registers like any session and gets NO injection output (§3.2 row 1);
 * the suppression is counted in the injection ledger, like the empty case,
 * so the dogfood checklist reads facts.
 */
import { UNKNOWN_DEVELOPER_ID } from "@crosscheck/connector-core/capture/records.ts";
import type { Producer } from "@crosscheck/connector-core/capture/records.ts";
import { endSession } from "@crosscheck/connector-core/http/hub.ts";
import {
  assembleBriefing,
  recordBriefingDeliveries,
} from "@crosscheck/connector-core/flows/briefing.ts";
import {
  fallbackWorkContextTitle,
  registerSessionFlow,
} from "@crosscheck/connector-core/flows/register-session.ts";
import { flushSpool } from "@crosscheck/connector-core/spool/flush.ts";
import {
  hasSpendablePendingEnd,
  reapSpool,
} from "@crosscheck/connector-core/spool/reap.ts";
import type { DeferredEnder } from "@crosscheck/connector-core/spool/reap.ts";
import { CURSOR_BACKGROUND_AGENT_KIND } from "@crosscheck/connector-core/state/host-session-key.ts";
import { updateSyncState } from "@crosscheck/connector-core/state/sync-state.ts";
import type { HookBudget } from "@crosscheck/connector-core/config/hook-budget.ts";

import type { CursorHookContext } from "../runner.ts";
import { recordInjectionOutcome } from "../inject/ledger.ts";
import { cursorInjectionOutput } from "../inject/output.ts";

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

  // The briefing, BEFORE maintenance (the Claude order — see the header).
  // Background agents skip assembly entirely: no injection output means the
  // six GETs would be spent on a briefing nobody may see.
  const isBackground = ctx.config.agentKind === CURSOR_BACKGROUND_AGENT_KIND;
  const briefing = isBackground
    ? ""
    : await deliverBriefing(ctx, crosscheckSessionId, developerId, now);
  if (isBackground) {
    await recordInjectionOutcome(ctx.config.home, {
      kind: "briefing",
      outcome: "suppressed",
      event: ctx.event,
      reason: "background",
    });
  }

  // Maintenance on the spare budget, the Claude SessionStart order: flush
  // first so a session whose records just reached the hub is reaped in the
  // same pass. Our own state file exists by now, so reap can never remove
  // the file this session keeps appending to. One request timeout is held
  // back from the drain when a deferred end is spendable this run — the
  // starvation livelock and the probe's rules live on hasSpendablePendingEnd
  // (spool/reap.ts) and the Claude hook's identical call site.
  const endHoldbackMs = (await hasSpendablePendingEnd(
    ctx.config.home,
    ctx.repoKey,
    now,
  ))
    ? ctx.hub.timeoutMs
    : 0;
  await flushSpool(
    ctx.hub,
    { sessionId: crosscheckSessionId, developerId },
    budget.spareMs() - endHoldbackMs,
  );
  await reapSpool(ctx.config.home, ctx.repoKey, now, deferredEnder(ctx, budget));

  return briefing.length === 0 ? "" : cursorInjectionOutput(briefing);
};

/**
 * Assemble through the shared flow (no landed rider — landed detection is
 * the Claude connector's; a connector without it simply omits the rider),
 * record the solved-pointer deliveries the EMITTED text really shows
 * (spool append then state then emit — flows/briefing.ts carries the
 * ordering argument; the deterministic delivery id is what makes a
 * restarted session's replay a hub-side `duplicate`, never a double), and
 * count the outcome in the injection ledger.
 */
const deliverBriefing = async (
  ctx: CursorHookContext,
  crosscheckSessionId: string,
  developerId: string | null,
  now: Date,
): Promise<string> => {
  const assembled = await assembleBriefing({
    hub: ctx.hub,
    repoId: ctx.identity.repoId,
    repoRoot: ctx.identity.root,
    selfDeveloperId: developerId,
    now,
  });
  const producer: Producer = {
    developerId: developerId ?? UNKNOWN_DEVELOPER_ID,
    agentKind: ctx.config.agentKind,
    sessionId: crosscheckSessionId,
  };
  await recordBriefingDeliveries({
    home: ctx.config.home,
    repoKey: ctx.repoKey,
    hostSessionKey: ctx.hostSessionKey,
    crosscheckSessionId,
    producer,
    shownSolvedIds: assembled.shownSolvedIds,
    now,
  });
  await recordInjectionOutcome(ctx.config.home, {
    kind: "briefing",
    outcome: assembled.briefing.length === 0 ? "suppressed" : "delivered",
    event: ctx.event,
    ...(assembled.briefing.length === 0 ? { reason: "empty" } : {}),
  });
  return assembled.briefing;
};
