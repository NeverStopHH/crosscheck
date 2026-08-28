/**
 * beforeSubmitPrompt — CAPTURE ONLY, and the eighth event this connector
 * registers.
 *
 * §3.2 refused to register it, for two reasons that were both true and are
 * both about channels this handler never uses: the event can BLOCK, and it
 * has no context-injection output. Nothing here injects and nothing here
 * blocks. What changed is that Ken works in Cursor and nothing was derived
 * for him at all, and this is the only Cursor event that carries the prompt
 * (docs: its input is `prompt` plus the submitted file list, re-read
 * 2026-08-28; the file list is never parsed and its field name is on the
 * privacy suite's banned list, so it is not spelled here either).
 *
 * THE OUTPUT IS ALWAYS NON-BLOCKING. The documented output is
 * `{continue, user_message}` and the ONLY power it has is to stop the user's
 * prompt. crosscheck never hard-blocks a tool call or a prompt (the
 * escalation ladder's first rung: inform, annotate, ask — never block), so
 * this handler answers CURSOR_NO_OP_OUTPUT unconditionally: no `continue`
 * key, no `user_message`, on every path including the ones that throw. The
 * handler suite pins the absence, the way the `stop` handler's suite pins
 * that `followup_message` is never emitted.
 *
 * WHAT IT DOES: the derived-intent fire, once per session (derive/triggers.ts
 * says how the exactly-once is enforced) — one state read, and on the first
 * substantive prompt one lock round, one 0600 file write and one unref'd
 * spawn. No hub call and no model wait, so the budget cost is a process
 * cold-start plus a state read, measured as a sibling of Claude's own
 * UserPromptSubmit race (test/budget.test.ts).
 *
 * NO RECOVERY REGISTRATION here, and that is the Stop hook's rule applied:
 * a prompt is not worth registering a session for. A conversation whose
 * sessionStart never ran (a cloud agent, where sessionStart is documented
 * unavailable) simply has no state yet, the fire does not happen, and the
 * first connected file touch registers through the existing recovery path.
 *
 * PRIVACY: the prompt is read, measured, and written to exactly one 0600
 * file that the detached worker unlinks in `finally`. It reaches no spool
 * record, no session state, no log line and no hub request — pinned in
 * test/privacy.test.ts, which names the one file it is allowed to be in.
 */
import { flushSpool } from "@crosscheck/connector-core/spool/flush.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import type { HookBudget } from "@crosscheck/connector-core/config/hook-budget.ts";

import type { CursorHookContext } from "../runner.ts";
import { maybeSpawnCursorIntentWorker } from "../derive/triggers.ts";

export const handleBeforeSubmitPrompt = async (
  ctx: CursorHookContext,
  budget: HookBudget,
): Promise<string> => {
  const state = await readSessionState(ctx.config.home, ctx.hostSessionKey);
  if (state === null) {
    return "";
  }
  await maybeSpawnCursorIntentWorker(ctx);
  // Maintenance on the spare budget, like every other handler: earlier
  // records ship now instead of waiting for the next tool use.
  await flushSpool(
    ctx.hub,
    { sessionId: state.crosscheckSessionId, developerId: state.developerId },
    budget.spareMs(),
  );
  return "";
};
