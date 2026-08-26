/**
 * PostToolUseFailure — the event where a FAILURE actually arrives.
 *
 * WHY THIS EXISTS AT ALL, and it is a defect rather than a feature: this
 * connector's only failure-capture path lived inside PostToolUse, behind
 * `isFailureResponse(tool_response)`. Claude Code's hooks reference says
 * PostToolUse "runs immediately after a tool completes successfully" and
 * directs failures to PostToolUseFailure, which `crosscheck init` never
 * registered — so a failing `bun test` produced no `error_fingerprint`
 * target on this host, and the strongest signal collective memory has
 * (VISION.md §1: content identity between two failures) had no input on the
 * connector most people run. PostToolUse keeps its own check: it costs
 * nothing, and a tool that "succeeds" while reporting `success: false`
 * still lands there.
 *
 * SYNC, unlike PostToolUse. PostToolUse is registered `async: true` because
 * it returns nothing, and an async hook's response is ignored — this one
 * carries `additionalContext`. Its budget is therefore the keystroke-grade
 * one (POST_TOOL_USE_FAILURE_BUDGET_RATIO — the same 800 ms as
 * UserPromptSubmit and PreToolUse) rather than PostToolUse's maintenance
 * budget: it runs inside the agent's turn, and a slow hub must cost that
 * turn nothing.
 *
 * NO RECOVERY REGISTRATION HERE, deliberately. PostToolUse recovers a
 * session that was installed mid-flight, and that path already runs on every
 * successful tool call; repeating it here would put a hub round trip and a
 * work-context write on the failure path for a session that is about to get
 * one anyway. No state file means silence.
 *
 * ORDER: capture first, inject second. The fingerprint is spooled before the
 * probe, so a hub that is down or slow costs the hint, never the capture —
 * and the capture is what makes THIS failure findable for the next person.
 */
import { captureFailure } from "@crosscheck/connector-core/flows/capture-targets.ts";
import { extractFailureText } from "@crosscheck/connector-core/capture/failure-text.ts";
import { UNKNOWN_DEVELOPER_ID } from "@crosscheck/connector-core/capture/records.ts";
import type { Producer } from "@crosscheck/connector-core/capture/records.ts";
import { selectAndRenderSolvedHint } from "@crosscheck/connector-core/flows/solved-hint.ts";
import { flushSpool } from "@crosscheck/connector-core/spool/flush.ts";
import {
  readSessionState,
  updateSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { HookBudget, HookContext } from "./runner.ts";

export const handlePostToolUseFailure = async (
  ctx: HookContext,
  budget: HookBudget,
): Promise<string> => {
  // An abort is not a broken build. The reference is precise about what this
  // flag covers — "true when the failure reached Claude Code as an abort
  // rather than as an error the tool reported" — and equally precise that it
  // is not the whole abort story: cancelling a RUNNING tool fires no failure
  // event at all, its interruption arriving as a tool RESULT on PostToolUse.
  // That half is guarded there, by the `interrupted` marker isFailureResponse
  // reads (capture/tool-events.ts).
  if (ctx.payload.is_interrupt === true) {
    return "";
  }
  const state = await readSessionState(ctx.config.home, ctx.payload.session_id);
  if (state === null) {
    return "";
  }
  // FIRST WINS across connected repos, the PostToolUse rule verbatim: a
  // failure resolving to a DIFFERENT repo belongs to a session bound
  // elsewhere, so it is dropped and COUNTED rather than captured here.
  if (state.repoId !== ctx.identity.repoId) {
    await updateSessionState(ctx.config.home, ctx.payload.session_id, (fresh) => ({
      ...fresh,
      foreignRepoDrops: fresh.foreignRepoDrops + 1,
    }));
    return "";
  }
  const now = ctx.now();
  const producer: Producer = {
    developerId: state.developerId ?? UNKNOWN_DEVELOPER_ID,
    agentKind: ctx.config.agentKind,
    sessionId: state.crosscheckSessionId,
  };
  // ONE extraction, the shared one: `error` is a top-level string here, and
  // `extractFailureText` reads a bare string as itself — so a Claude failure
  // and an ACP or Cursor one carrying the same bytes fingerprint
  // identically, which is the whole cross-agent match story.
  const fingerprint = await captureFailure({
    home: ctx.config.home,
    repoKey: ctx.repoKey,
    hostSessionKey: ctx.payload.session_id,
    workContextId: state.workContextId,
    producer,
    failureText: extractFailureText(ctx.payload.error),
    now,
  });
  // Null means `fingerprint()` refused the text — no signal, or a secret in
  // it (drop, never a redacted derivative). Nothing was spooled and there is
  // nothing to probe with.
  const hint =
    fingerprint === null
      ? ""
      : await selectAndRenderSolvedHint({
          home: ctx.config.home,
          repoKey: ctx.repoKey,
          hub: ctx.hub,
          hostSessionKey: ctx.payload.session_id,
          repoId: state.repoId,
          agentKind: ctx.config.agentKind,
          fingerprint,
          now,
        });
  // A failure is exactly when a teammate wants this fingerprint fresh on the
  // hub — drain on the SPARE budget, which already holds one request timeout
  // back so the drain can never eat the injection.
  await flushSpool(
    ctx.hub,
    { sessionId: state.crosscheckSessionId, developerId: state.developerId },
    budget.spareMs(),
  );
  if (hint.length === 0) {
    return "";
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUseFailure",
      additionalContext: hint,
    },
  });
};
