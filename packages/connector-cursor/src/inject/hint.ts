/**
 * The failure-matched hint attempt (design §3.3 + §6 open q4) — ONE
 * implementation shared by both failure-signal handlers, so whichever event
 * a real Cursor build fires (`postToolUse` with an embedded exitCode, or
 * `postToolUseFailure` with `error_message`) runs the identical pipeline:
 * the core `selectAndRenderHint` flow, which IS the Claude connector's
 * UserPromptSubmit path — same selector, same 1-per-call structure, same
 * MAX_HINTS_PER_SESSION cap, same persisted seen-set, same echo-exclusion
 * body hash, same deterministic `hint_deliveries` row. Parity is not a
 * checklist here; it is the same function.
 *
 * THE QUERY IS THE FAILURE TEXT, ephemerally (Block 4's privacy pin
 * extends): Cursor has no injectable prompt-time event — `beforeSubmitPrompt`
 * documents no context output (§3.2) — so the failure text the handler
 * already extracted for the fingerprint doubles as the search query. It is
 * passed in memory, sliced inside the flow for the hub call, and never
 * stored, spooled, or logged; the ledger row carries outcome slugs only.
 *
 * FAST PATH ONLY: no attempt without a detected failure (a successful tool
 * result has no query and buys no hub call), and the flow's own gates run
 * before any HTTP — meaning floor, session cap, seen-set. The per-request
 * hub timeout bounds the one candidates call; the runner's budget race is
 * the backstop (budget.test.ts measures it against a hub slower than every
 * budget).
 */
import { selectAndRenderHint } from "@crosscheck/connector-core/flows/hint.ts";
import { CURSOR_BACKGROUND_AGENT_KIND } from "@crosscheck/connector-core/state/host-session-key.ts";

import type { CursorHookContext } from "../runner.ts";
import { recordInjectionOutcome } from "./ledger.ts";

/**
 * Runs the shared hint flow for a detected failure and returns the rendered
 * text ("" = silence). The flow reads its own fresh session state under the
 * state lock — no snapshot is passed in, so a concurrent capture write can
 * never be clobbered by a stale one. Records the outcome in the injection
 * ledger with the carrying event — the §6-q4 instrument ("which event
 * delivered?").
 */
export const attemptFailureHint = async (
  ctx: CursorHookContext,
  failureText: string,
): Promise<string> => {
  // Background agents get no injection output (§3.2 row 1). The flag rides
  // only on the session events today, so this gate is future-proofing: if
  // Cursor ever adds it to tool payloads, the config picks it up here.
  if (ctx.config.agentKind === CURSOR_BACKGROUND_AGENT_KIND) {
    return "";
  }
  const text = await selectAndRenderHint({
    home: ctx.config.home,
    repoKey: ctx.repoKey,
    hub: ctx.hub,
    hostSessionKey: ctx.hostSessionKey,
    repoId: ctx.identity.repoId,
    repoRoot: ctx.identity.root,
    agentKind: ctx.config.agentKind,
    // EPHEMERAL query — never stored, never logged (see the header).
    prompt: failureText,
    now: ctx.now(),
  });
  await recordInjectionOutcome(ctx.config.home, {
    kind: "hint",
    outcome: text.length === 0 ? "suppressed" : "delivered",
    event: ctx.event,
    ...(text.length === 0 ? { reason: "silence" } : {}),
  });
  return text;
};
