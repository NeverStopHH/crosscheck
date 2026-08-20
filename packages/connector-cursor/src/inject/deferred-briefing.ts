/**
 * The cursor deferred-briefing slot (§3.3 briefing parity — the Claude
 * user-prompt-submit's sibling): a conversation that registered LATE through
 * `requireSessionState`'s recovery is owed the briefing sessionStart never
 * got to deliver, and the next injection-capable hook — postToolUse or
 * postToolUseFailure; Cursor has no prompt hook — pays that debt through the
 * SAME core `deliverDeferredBriefing` flow and renderers every other
 * connector uses. Exactly-once, the failed-assembly semantics and the
 * first-wins repo guard all live on the flow (flows/briefing.ts).
 *
 * TWO functions because the debt check and the payment straddle recovery:
 * `owedBriefingBefore` must read the state BEFORE `requireSessionState` can
 * stamp it, so the recovery invocation itself never pays — it already spent
 * a register round trip, and the deferred slot exists precisely so assembly
 * runs on a hook with its full budget (the Claude shape: stamp on
 * PostToolUse, deliver on the NEXT hook). A racing sibling that reads the
 * stamped flag in the same window is harmless: the flow's check-and-set
 * spends it exactly once.
 */
import { deliverDeferredBriefing } from "@crosscheck/connector-core/flows/briefing.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { CURSOR_BACKGROUND_AGENT_KIND } from "@crosscheck/connector-core/state/host-session-key.ts";

import type { CursorHookContext } from "../runner.ts";
import { recordInjectionOutcome } from "./ledger.ts";

/**
 * True when this conversation ALREADY owed a briefing when the hook began —
 * read before any recovery can run, which is what keeps the recovery
 * invocation itself silent. One local JSON read; no HTTP.
 */
export const owedBriefingBefore = async (
  ctx: CursorHookContext,
): Promise<boolean> => {
  const state = await readSessionState(ctx.config.home, ctx.hostSessionKey);
  return state?.briefingPending === true;
};

/**
 * Pays the debt through the shared flow and returns the rendered briefing
 * ("" = silence: not owed after all, a sibling won the claim, or assembly
 * came back empty — the flow's semantics, unchanged here). A delivery is
 * counted in the injection ledger like every other injection; the
 * indistinguishable silent faces are not, deliberately — a raced sibling's
 * loss is not a suppression event.
 */
export const deliverOwedBriefing = async (
  ctx: CursorHookContext,
): Promise<string> => {
  // Background agents get no injection output (§3.2 row 1) — the same
  // future-proofing gate as the hint attempt's: the flag rides only on the
  // session events today, so on tool events this is belt-and-braces.
  if (ctx.config.agentKind === CURSOR_BACKGROUND_AGENT_KIND) {
    return "";
  }
  const text = await deliverDeferredBriefing({
    home: ctx.config.home,
    repoKey: ctx.repoKey,
    hub: ctx.hub,
    hostSessionKey: ctx.hostSessionKey,
    repoId: ctx.identity.repoId,
    agentKind: ctx.config.agentKind,
    now: ctx.now(),
  });
  if (text.length > 0) {
    await recordInjectionOutcome(ctx.config.home, {
      kind: "briefing",
      outcome: "delivered",
      event: ctx.event,
    });
  }
  return text;
};
