/**
 * afterShellExecution (§3.2 row 3): failure fingerprint — and nothing else.
 *
 * HONESTY ABOUT THE CONTRACT: the documented input is {command, output,
 * duration, sandbox} with NO exit code of any spelling, and the conservative
 * rule is the Claude connector's — an explicit failure marker must be
 * present; "no such field" means "not a failure", never "assume failure".
 * So on the documented shape this handler captures NOTHING, a numeric
 * `exit_code`/`exitCode` is tolerated as the marker if a real build sends
 * one (§6-q5 dogfood answers whether it does), and postToolUseFailure is the
 * event the docs actually promise a failure signal on.
 *
 * Only the `output` field enters the shared extractor — command text never
 * reaches the fingerprint (parity: the same failure output must hash
 * identically from Claude's {stderr,stdout} and from here) and is never
 * uploaded anywhere (§2.4: the Claude connector uploads no command text
 * either).
 */
import { captureFailure } from "@crosscheck/connector-core/flows/capture-targets.ts";
import { seqAt } from "@crosscheck/connector-core/capture/seq.ts";
import { allocateSeq } from "@crosscheck/connector-core/state/session-state.ts";
import { extractFailureText } from "@crosscheck/connector-core/capture/failure-text.ts";
import { UNKNOWN_DEVELOPER_ID } from "@crosscheck/connector-core/capture/records.ts";
import { flushSpool } from "@crosscheck/connector-core/spool/flush.ts";
import type { HookBudget } from "@crosscheck/connector-core/config/hook-budget.ts";

import type { CursorHookContext } from "../runner.ts";
import { requireSessionState } from "./recover.ts";

export const handleAfterShellExecution = async (
  ctx: CursorHookContext,
  budget: HookBudget,
): Promise<string> => {
  const exitValue = ctx.payload.exit_code ?? ctx.payload.exitCode;
  if (typeof exitValue !== "number" || exitValue === 0) {
    return "";
  }
  const state = await requireSessionState(ctx);
  if (state === null) {
    return "";
  }
  // ONE position, allocated before the record is serialized: this handler
  // spools exactly one fingerprint, and its locked state write (where it has
  // one) happens after that record is already on disk.
  const seq = await allocateSeq(ctx.config.home, ctx.hostSessionKey, 1);
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
    failureText: extractFailureText({ output: ctx.payload.output }),
    now: ctx.now(),
    seq: seqAt(seq, 0),
  });
  // A failure moment is exactly when a teammate wants the fingerprint fresh:
  // drain on the spare budget (the split-event rule — file-edit.ts).
  await flushSpool(
    ctx.hub,
    { sessionId: state.crosscheckSessionId, developerId: state.developerId },
    budget.spareMs(),
  );
  return "";
};
