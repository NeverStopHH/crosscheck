/**
 * postToolUseFailure (§3.2 row 4): the event the documented contract
 * actually promises a failure signal on — `error_message`, always present.
 * Same fingerprint path as every other host: the shared extractor, the
 * shared `fingerprint()` (which itself refuses secrets and no-signal text),
 * one `error_fingerprint` target.
 *
 * NOT captured, deliberately:
 *   - `is_interrupt: true` — the user cancelled; a cancellation is not a
 *     build failure (the ACP mapping's cancelled/refusal rule);
 *   - `failure_type: "permission_denied"` — a policy outcome, not a build
 *     failure; fingerprinting denials would teach the team's memory that
 *     hooks are broken code.
 *
 * Block 7, the open-q4 tolerant half: the same failure ALSO runs the
 * failure-matched hint attempt, and a delivered hint is emitted as
 * `additional_context` — a field this event's documented output does NOT
 * list (it lists none), emitted in the shared response shape anyway
 * because §6 q4 is precisely "does the failure land here or in postToolUse,
 * and where does the hint attach?". A build that ignores the field degrades
 * silently — capture is untouched — and the injection ledger records which
 * event delivered, so the manual dogfood reads the answer off `doctor`
 * instead of guessing. If BOTH events fire for one failure — sequentially
 * OR concurrently — the seen-set claim in the shared flow is a locked
 * check-and-set (first writer wins, flows/hint.ts recordDelivery), so the
 * second attempt is silent: never a double delivery. The concurrent case is
 * pinned in test/injection.test.ts.
 */
import { captureFailure } from "@crosscheck/connector-core/flows/capture-targets.ts";
import { extractFailureText } from "@crosscheck/connector-core/capture/failure-text.ts";
import { UNKNOWN_DEVELOPER_ID } from "@crosscheck/connector-core/capture/records.ts";
import { flushSpool } from "@crosscheck/connector-core/spool/flush.ts";
import type { HookBudget } from "@crosscheck/connector-core/config/hook-budget.ts";

import type { CursorHookContext } from "../runner.ts";
import { attemptFailureHint } from "../inject/hint.ts";
import { cursorInjectionOutput } from "../inject/output.ts";
import { requireSessionState } from "./recover.ts";

const PERMISSION_DENIED = "permission_denied";

export const handlePostToolUseFailure = async (
  ctx: CursorHookContext,
  budget: HookBudget,
): Promise<string> => {
  if (ctx.payload.is_interrupt === true) {
    return "";
  }
  if (ctx.payload.failure_type === PERMISSION_DENIED) {
    return "";
  }
  const state = await requireSessionState(ctx);
  if (state === null) {
    return "";
  }
  // ONE extraction feeds both the fingerprint and the ephemeral query.
  const failureText = extractFailureText({ error: ctx.payload.error_message });
  await captureFailure({
    home: ctx.config.home,
    repoKey: ctx.repoKey,
    hostSessionKey: ctx.hostSessionKey,
    workContextId: state.workContextId,
    producer: {
      developerId: state.developerId ?? UNKNOWN_DEVELOPER_ID,
      agentKind: ctx.config.agentKind,
      sessionId: state.crosscheckSessionId,
    },
    failureText,
    now: ctx.now(),
  });
  const hintText = await attemptFailureHint(ctx, failureText);
  // A failure moment is exactly when a teammate wants the fingerprint fresh:
  // drain on the spare budget (the split-event rule — file-edit.ts).
  await flushSpool(
    ctx.hub,
    { sessionId: state.crosscheckSessionId, developerId: state.developerId },
    budget.spareMs(),
  );
  return hintText.length === 0 ? "" : cursorInjectionOutput(hintText);
};
