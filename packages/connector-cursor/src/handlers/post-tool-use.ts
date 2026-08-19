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
 * The hint delivery this event will carry (`additional_context`) is
 * Block 7's.
 */
import { captureFailure } from "@crosscheck/connector-core/flows/capture-targets.ts";
import { heartbeatMaybe } from "@crosscheck/connector-core/flows/heartbeat.ts";
import { extractFailureText } from "@crosscheck/connector-core/capture/failure-text.ts";
import { UNKNOWN_DEVELOPER_ID } from "@crosscheck/connector-core/capture/records.ts";
import { flushSpool } from "@crosscheck/connector-core/spool/flush.ts";
import { updateSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import type { HookBudget } from "@crosscheck/connector-core/config/hook-budget.ts";

import type { CursorHookContext } from "../runner.ts";
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
  const state = await requireSessionState(ctx);
  if (state === null) {
    return "";
  }
  const now = ctx.now();
  const parsedOutput = parseToolOutput(ctx.payload.tool_output);
  if (parsedOutput !== null && isFailingToolOutput(parsedOutput)) {
    // The parsed record's text fields (stdout/stderr/output/error) through
    // the shared extractor — identical spelling to every other connector.
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
      failureText: extractFailureText(parsedOutput),
      now,
    });
  }
  // Maintenance on the spare budget; the heartbeat after it is another hub
  // call and the state write is what keeps this session's spool safe.
  await flushSpool(
    ctx.hub,
    { sessionId: state.crosscheckSessionId, developerId: state.developerId },
    budget.spareMs(),
  );
  const didHeartbeat = await heartbeatMaybe({
    hub: ctx.hub,
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
  return "";
};
