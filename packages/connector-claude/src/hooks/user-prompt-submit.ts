/**
 * UserPromptSubmit — the injection pipeline's fast path (DESIGN.md §4).
 *
 * TWO deliveries can ride this hook, never both on one prompt:
 *
 *   1. A DEFERRED BRIEFING (flows/briefing.ts `deliverDeferredBriefing`):
 *      a session that registered late — PostToolUse's recovery, the
 *      parent-workspace shape — is owed the briefing SessionStart never got
 *      to deliver, and the first prompt pays that debt. Precedence is
 *      pinned: the briefing OUTRANKS the hint for that one prompt (the ACP
 *      injector's order — briefing on the first prompt it is ready for, the
 *      hint flow afterwards), and the hint pipeline is not even consulted,
 *      so one prompt carries at most one injection.
 *   2. Otherwise the hint: the WHOLE pipeline — meaning floor, seen-set +
 *      cap, one bounded hub call, one bounded git call, at most ONE hint,
 *      record-then-emit — is the core `selectAndRenderHint` flow since
 *      Block 5 extracted it (connector-core/src/flows/hint.ts, where the
 *      ordering and privacy arguments now live).
 *
 * This hook is the Claude-specific shell: payload fields in,
 * `hookSpecificOutput` envelope out.
 *
 * The 800 ms total budget is enforced by the runner's race
 * (USER_PROMPT_SUBMIT_BUDGET_RATIO), measured in test/hint-hook-latency.test.ts.
 * The briefing path fits the same envelope: one parallel GET block bounded by
 * the per-request timeout plus one bounded git fan-out — the SessionStart
 * measurement, inside a budget sized for exactly that shape.
 */
import { deliverDeferredBriefing } from "@crosscheck/connector-core/flows/briefing.ts";
import { selectAndRenderHint } from "@crosscheck/connector-core/flows/hint.ts";
import type { HookContext } from "./runner.ts";

const envelope = (text: string): string =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: text,
    },
  });

export const handleUserPromptSubmit = async (
  ctx: HookContext,
): Promise<string> => {
  // The deferred briefing never reads the prompt text, so it sits BEFORE the
  // hint pipeline's meaning floor and secret gate: a session owed a briefing
  // gets it whatever the first prompt says. Exactly-once and the
  // failed-assembly semantics live on the flow.
  const briefing = await deliverDeferredBriefing({
    home: ctx.config.home,
    repoKey: ctx.repoKey,
    hub: ctx.hub,
    hostSessionKey: ctx.payload.session_id,
    repoId: ctx.identity.repoId,
    agentKind: ctx.config.agentKind,
    now: ctx.now(),
  });
  if (briefing.length > 0) {
    return envelope(briefing);
  }
  const text = await selectAndRenderHint({
    home: ctx.config.home,
    repoKey: ctx.repoKey,
    hub: ctx.hub,
    hostSessionKey: ctx.payload.session_id,
    repoId: ctx.identity.repoId,
    repoRoot: ctx.identity.root,
    agentKind: ctx.config.agentKind,
    prompt: ctx.payload.prompt ?? "",
    now: ctx.now(),
  });
  if (text.length === 0) {
    return "";
  }
  return envelope(text);
};
