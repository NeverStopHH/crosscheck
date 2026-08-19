/**
 * UserPromptSubmit — the injection pipeline's fast path (DESIGN.md §4).
 *
 * The WHOLE pipeline — meaning floor, seen-set + cap, one bounded hub call,
 * one bounded git call, at most ONE hint, record-then-emit — is the core
 * `selectAndRenderHint` flow since Block 5 extracted it
 * (connector-core/src/flows/hint.ts, where the ordering and privacy
 * arguments now live). This hook is the Claude-specific shell: payload
 * fields in, `hookSpecificOutput` envelope out.
 *
 * The 800 ms total budget is enforced by the runner's race
 * (USER_PROMPT_SUBMIT_BUDGET_RATIO), measured in test/hint-hook-latency.test.ts.
 */
import { selectAndRenderHint } from "@crosscheck/connector-core/flows/hint.ts";
import type { HookContext } from "./runner.ts";

export const handleUserPromptSubmit = async (
  ctx: HookContext,
): Promise<string> => {
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
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: text,
    },
  });
};
