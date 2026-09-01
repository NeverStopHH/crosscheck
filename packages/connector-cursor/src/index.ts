/**
 * @crosscheck/connector-cursor — the Cursor IDE connector (design §3):
 * short-lived `crosscheck cursor-hook <event>` processes over Cursor's
 * documented hooks API, the same spool, the same budgets, the same
 * fail-open-everywhere. Block 6 landed capture; Block 7 landed the
 * injection surfaces — the `sessionStart` briefing and failure-matched
 * hints via the documented `additional_context` output, everything through
 * the core renderers on registered §4.4 surfaces (src/inject/output.ts).
 */
import type { Env } from "@crosscheck/connector-core/config/paths.ts";

import { handleAfterFileEdit } from "./handlers/file-edit.ts";
import { handleBeforeSubmitPrompt } from "./handlers/before-submit-prompt.ts";
import { handleAfterShellExecution } from "./handlers/shell.ts";
import { handleCursorPostToolUse } from "./handlers/post-tool-use.ts";
import { handleCursorSessionEnd } from "./handlers/session-end.ts";
import { handleCursorSessionStart } from "./handlers/session-start.ts";
import { handleCursorStop } from "./handlers/stop.ts";
import { handlePostToolUseFailure } from "./handlers/tool-failure.ts";
import { runCursorHookWith } from "./runner.ts";
import type { CursorHookHandler } from "./runner.ts";
import type { CursorHookEvent } from "./payload.ts";

const HANDLERS: Readonly<Record<CursorHookEvent, CursorHookHandler>> = {
  sessionStart: handleCursorSessionStart,
  beforeSubmitPrompt: handleBeforeSubmitPrompt,
  afterFileEdit: handleAfterFileEdit,
  afterShellExecution: handleAfterShellExecution,
  postToolUse: handleCursorPostToolUse,
  postToolUseFailure: handlePostToolUseFailure,
  stop: handleCursorStop,
  sessionEnd: handleCursorSessionEnd,
};

/** Single entry point for every cursor hook: returns stdout text, never throws. */
export const runCursorHook = async (
  event: CursorHookEvent,
  stdin: string,
  env: Env,
): Promise<string> => runCursorHookWith(event, HANDLERS[event], stdin, env);

export {
  CURSOR_HOOK_EVENTS,
  isCursorHookEvent,
  parseCursorPayload,
  missingMappedFields,
  CursorPayloadSchema,
} from "./payload.ts";
export type { CursorHookEvent, CursorPayload } from "./payload.ts";
export { prepareCursorHook } from "./runner.ts";
export type { CursorHookContext, CursorHookHandler } from "./runner.ts";
export {
  CURSOR_DIR,
  CURSOR_HOOKS_FILE,
  CURSOR_HOOKS_VERSION,
  CURSOR_HOOK_TIMEOUT_SECONDS,
  CURSOR_MCP_FILE,
  CURSOR_NO_OP_OUTPUT,
} from "./constants.ts";
export {
  driftLedgerPath,
  readContractDrift,
  recordContractDrift,
} from "./drift.ts";
export type { DriftSummary } from "./drift.ts";
export {
  buildCursorHooksPlan,
  isOwnedCursorCommand,
  mergeCursorHooks,
  removeCursorHooks,
} from "./init/hooks-merge.ts";
export type {
  CursorHooksPlan,
  CursorRemovalResult,
} from "./init/hooks-merge.ts";
export { prepareCursorInit } from "./init/init.ts";
export type { CursorInitPlan } from "./init/init.ts";
export { CURSOR_CAPABILITY_MANIFEST } from "./capabilities.ts";
export { cursorDoctorChecks, cursorCapabilityDetail } from "./doctor.ts";
export type { CursorCheck } from "./doctor.ts";
export {
  cursorInjectionOutput,
  deliveredAdditionalContext,
} from "./inject/output.ts";
export {
  injectionLedgerPath,
  readInjectionLedger,
  recordInjectionOutcome,
} from "./inject/ledger.ts";
export type {
  InjectionOutcomeEntry,
  InjectionSummary,
} from "./inject/ledger.ts";
