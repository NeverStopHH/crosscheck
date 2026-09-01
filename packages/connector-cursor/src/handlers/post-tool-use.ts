/**
 * postToolUse (§3.2 row 5): heartbeat (throttled in core, no status — a
 * generic tool use proves liveness, not building; the Bash-carries-no-status
 * rule), spool flush on the spare budget — and failure detection from the
 * DOCUMENTED tool_output encoding: a JSON-stringified result payload whose
 * example carries `exitCode`/`stdout`. postToolUse fires on successful TOOL
 * execution, and a shell tool that ran a command which itself failed lands
 * here with a non-zero embedded exitCode — an explicit marker, so the
 * conservative rule is satisfied. Whether failed commands reach this event
 * at all or only postToolUseFailure is §6 open question 4; both paths
 * produce the same fingerprint from the same text, and the hub dedups on
 * (work_context, kind, value), so overlap costs nothing.
 *
 * Block 7: a DETECTED failure also runs the failure-matched hint attempt
 * (inject/hint.ts — the shared `selectAndRenderHint` flow with the failure
 * text as the ephemeral query), and a delivered hint rides out on this
 * event's DOCUMENTED `additional_context` output, "injected after the tool
 * result". The hint runs BEFORE the maintenance flush — it is the thing the
 * developer may actually see, the Claude ordering rule — and a successful
 * tool result attempts nothing: no failure, no query, no HTTP.
 *
 * Block 9: this event ALSO pays the ghost debt (derive/triggers.ts). Cursor
 * has no single "next prompt" event that always runs, so the debt is paid by
 * whichever of `postToolUse` and `stop` fires first — a check-and-set under
 * the state lock, so two of them racing still spawn one worker. Until this
 * landed, `set_intent` in Cursor set `ghostPending` and nothing ever paid it.
 *
 * Briefing parity: a conversation that registered LATE (requireSessionState's
 * recovery) is owed the briefing sessionStart never delivered, and THIS is
 * the hook that pays it (inject/deferred-briefing.ts) — on the invocation
 * AFTER the recovery, outranking the hint for that one response: one
 * injection per response, the briefing because it is the bigger loss (the
 * Claude user-prompt-submit's pinned precedence). Capture is untouched by
 * the precedence — a detected failure is fingerprinted whether or not the
 * briefing takes the injection slot.
 */
import { captureFailure } from "@crosscheck/connector-core/flows/capture-targets.ts";
import { heartbeatMaybe } from "@crosscheck/connector-core/flows/heartbeat.ts";
import { extractFailureText } from "@crosscheck/connector-core/capture/failure-text.ts";
import { UNKNOWN_DEVELOPER_ID } from "@crosscheck/connector-core/capture/records.ts";
import { flushSpool } from "@crosscheck/connector-core/spool/flush.ts";
import { updateSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import type { HookBudget } from "@crosscheck/connector-core/config/hook-budget.ts";

import type { CursorHookContext } from "../runner.ts";
import {
  deliverOwedBriefing,
  owedBriefingBefore,
} from "../inject/deferred-briefing.ts";
import { attemptFailureHint } from "../inject/hint.ts";
import { cursorInjectionOutput } from "../inject/output.ts";
import { maybeSpawnCursorGhostWorker } from "../derive/triggers.ts";
import { requireSessionState } from "./recover.ts";

/**
 * The documented tool_output string, parsed tolerantly: not a string, not
 * JSON, or not an object → null (and null never counts as a failure).
 */
const parseToolOutput = (
  toolOutput: string | undefined,
): Record<string, unknown> | null => {
  if (toolOutput === undefined) {
    return null;
  }
  try {
    const parsed = JSON.parse(toolOutput) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/**
 * Conservative failure detection on the parsed result — an EXPLICIT marker
 * must be present (the Claude isFailureResponse discipline; what counts as
 * a failure stays host-side, per capture/failure-text.ts).
 */
const isFailingToolOutput = (record: Record<string, unknown>): boolean => {
  if (record["is_error"] === true || record["isError"] === true) {
    return true;
  }
  if (record["success"] === false) {
    return true;
  }
  return ["exitCode", "exit_code"].some((field) => {
    const value = record[field];
    return typeof value === "number" && value !== 0;
  });
};

export const handleCursorPostToolUse = async (
  ctx: CursorHookContext,
  budget: HookBudget,
): Promise<string> => {
  // Read BEFORE recovery can stamp the debt: the recovery invocation itself
  // never pays (inject/deferred-briefing.ts carries the budget argument).
  const owedBefore = await owedBriefingBefore(ctx);
  const state = await requireSessionState(ctx);
  if (state === null) {
    return "";
  }
  // The GHOST DEBT, paid here or on `stop`, whichever fires first
  // (derive/triggers.ts states why Cursor needs both). It emits nothing, so
  // it runs before the injection decisions and cannot change them; a session
  // owing nothing pays one state read.
  await maybeSpawnCursorGhostWorker(ctx);
  // The deferred briefing first — it is what the developer may actually see,
  // and whether it delivered decides if the hint pipeline is consulted at all.
  const briefingText = owedBefore ? await deliverOwedBriefing(ctx) : "";
  const now = ctx.now();
  const parsedOutput = parseToolOutput(ctx.payload.tool_output);
  let hintText = "";
  if (parsedOutput !== null && isFailingToolOutput(parsedOutput)) {
    // The parsed record's text fields (stdout/stderr/output/error) through
    // the shared extractor — identical spelling to every other connector.
    // ONE extraction feeds both the fingerprint and the ephemeral query.
    const failureText = extractFailureText(parsedOutput);
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
      now,
    });
    // Precedence, pinned: a delivered briefing takes this response's one
    // injection slot — the hint pipeline is not even consulted (briefing-
    // parity.test.ts counts the candidates GET at zero). Capture above ran
    // regardless.
    if (briefingText.length === 0) {
      hintText = await attemptFailureHint(ctx, failureText);
    }
  }
  // Maintenance on the spare budget; the heartbeat after it is another hub
  // call and the state write is what keeps this session's spool safe.
  await flushSpool(
    ctx.hub,
    { sessionId: state.crosscheckSessionId, developerId: state.developerId },
    budget.spareMs(),
  );
  // The heartbeat runs AFTER the hint is in hand, so it may spend the spare
  // budget only — clamped like the deferred ender (session-start.ts): handed
  // the raw request timeout it can eat exactly the reserve, and the runner's
  // race then discards the delivered text it exists to carry out
  // (budget.test.ts pins both halves: skip at zero, clamp when hung).
  const roomMs = budget.spareMs();
  const didHeartbeat =
    roomMs <= 0
      ? false
      : await heartbeatMaybe({
          hub: { ...ctx.hub, timeoutMs: Math.min(ctx.hub.timeoutMs, roomMs) },
          crosscheckSessionId: state.crosscheckSessionId,
          lastHeartbeatAt: state.lastHeartbeatAt,
          now,
        });
  if (didHeartbeat) {
    await updateSessionState(ctx.config.home, ctx.hostSessionKey, (fresh) => ({
      ...fresh,
      lastHeartbeatAt: now.toISOString(),
    }));
  }
  const text = briefingText.length === 0 ? hintText : briefingText;
  return text.length === 0 ? "" : cursorInjectionOutput(text);
};
