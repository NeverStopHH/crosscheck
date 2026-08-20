/**
 * Briefing parity for LATE registrations, the CURSOR half (races review
 * finding 1): a conversation that registers through `requireSessionState`'s
 * recovery — hooks installed mid-conversation, or a conversation REOPENED
 * after its sessionEnd (the recover.ts header's two live shapes) — never ran
 * a sessionStart here, so nothing ever delivered its briefing: exactly the
 * loss class the Claude connector closed in test/briefing-parity.test.ts,
 * open on this connector until now.
 *
 * The same house pattern closes it (ACP inject/injector.ts: "the cached
 * briefing on the first prompt it is ready for, the hint flow afterwards"):
 * recovery records the debt in `briefingPending`, and the NEXT
 * additional_context-capable hook — postToolUse or postToolUseFailure;
 * Cursor has no prompt hook — pays it through the same core
 * `deliverDeferredBriefing` flow and renderers, exactly once, outranking the
 * hint for that one response. The recovery invocation itself never pays: it
 * already spent a register round trip, and the deferred slot exists so the
 * briefing is assembled on a hook with its full budget (the Claude pattern —
 * stamp on PostToolUse, deliver on the next hook).
 *
 * Everything here drives the real hook entry point against the SAME shared
 * parity hub the Claude suite uses; only the hub is canned.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { cursorHostSessionKey } from "@crosscheck/connector-core/state/host-session-key.ts";

import { runCursorHook } from "../src/index.ts";
import { deliveredAdditionalContext } from "../src/inject/output.ts";
import {
  POST_TOOL_USE_FAILING_COMMAND,
  POST_TOOL_USE_FAILURE_INPUT,
  POST_TOOL_USE_INPUT,
  SESSION_START_INPUT,
} from "./fixtures/cursor-contract/payloads.ts";
import { CANDIDATE_BODY } from "../../connector-core/test/fixtures/hint-hub.ts";
import { startParityHub } from "../../connector-core/test/fixtures/parity-hub.ts";
import type { ParityHub } from "../../connector-core/test/fixtures/parity-hub.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REMOTE = "git@github.com:acme/api.git";
/** The one line only the BRIEFING renderer opens its presence section with. */
const BRIEFING_HEADER = "Teammate sessions active now:";
const TEAMMATE_NAME = "Mona";

const paths: string[] = [];
const stops: Array<() => void> = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
  for (const stop of stops) {
    stop();
  }
  stops.length = 0;
});

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly hub: ParityHub;
  readonly env: Record<string, string>;
}

const fixture = async (label: string): Promise<Fixture> => {
  const repo = await makeRepo(label, { remote: REMOTE });
  const home = await makeHome(label);
  paths.push(repo, home);
  const hub = startParityHub(TEAMMATE_NAME);
  stops.push(hub.stop);
  return {
    repo,
    home,
    hub,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.url,
      CROSSCHECK_API_KEY: "test-key",
    },
  };
};

const withConversation = (
  base: Record<string, unknown>,
  conv: string,
  repo: string,
): string =>
  JSON.stringify({
    ...base,
    conversation_id: conv,
    session_id: conv,
    workspace_roots: [repo],
  });

/**
 * The late-registration shape: the FIRST hook this conversation ever fires
 * is a tool event — no sessionStart ran, `requireSessionState` rebuilds the
 * session through the recovery register. A successful tool output keeps the
 * invocation itself injection-free, so what the recovery does and does not
 * emit is pinned in isolation.
 */
const registerLate = async (fixed: Fixture, conv: string): Promise<void> => {
  const stdout = await runCursorHook(
    "postToolUse",
    withConversation(POST_TOOL_USE_INPUT, conv, fixed.repo),
    fixed.env,
  );
  // The recovery invocation stays silent — the debt is recorded, not paid.
  expect(stdout).toBe("{}");
  const state = await readSessionState(fixed.home, cursorHostSessionKey(conv));
  if (state === null) {
    throw new Error("recovery did not publish session state");
  }
  expect(state.briefingPending).toBe(true);
};

describe("a cursor conversation that registered late, through recovery", () => {
  test("the next tool event carries the briefing and outranks the hint", async () => {
    // Arrange: recovery-registered conversation; the hub offers BOTH a
    // presence briefing and an injectable hint candidate for this failure.
    const fixed = await fixture("cur-parity-deliver");
    const conv = "conv-parity-deliver";
    await registerLate(fixed, conv);

    // Act: a FAILING tool result — the hint pipeline's own trigger.
    const stdout = await runCursorHook(
      "postToolUse",
      withConversation(POST_TOOL_USE_FAILING_COMMAND, conv, fixed.repo),
      fixed.env,
    );

    // Assert — the briefing, through the core renderer
    const context = deliveredAdditionalContext(stdout);
    expect(context).toContain(BRIEFING_HEADER);
    expect(context).toContain(TEAMMATE_NAME);
    // — and NOT the hint: precedence is pinned, one injection per response,
    // the hint flow was never even asked for candidates.
    expect(context).not.toContain(CANDIDATE_BODY);
    expect(fixed.hub.calls.candidates).toBe(0);
    // — the debt is spent
    const state = await readSessionState(fixed.home, cursorHostSessionKey(conv));
    expect(state?.briefingPending).toBe(false);
  });

  test("the briefing arrives exactly once — the next failure gets the hint", async () => {
    // Arrange
    const fixed = await fixture("cur-parity-once");
    const conv = "conv-parity-once";
    await registerLate(fixed, conv);
    const first = await runCursorHook(
      "postToolUse",
      withConversation(POST_TOOL_USE_FAILING_COMMAND, conv, fixed.repo),
      fixed.env,
    );
    expect(deliveredAdditionalContext(first)).toContain(BRIEFING_HEADER);

    // Act: the SAME conversation fails again
    const second = await runCursorHook(
      "postToolUse",
      withConversation(POST_TOOL_USE_FAILING_COMMAND, conv, fixed.repo),
      fixed.env,
    );

    // Assert: no second briefing — the hint path is back in charge
    const context = deliveredAdditionalContext(second);
    expect(context).not.toContain(BRIEFING_HEADER);
    expect(context).toContain(CANDIDATE_BODY);
    expect(fixed.hub.calls.candidates).toBe(1);
  });

  test("postToolUseFailure pays the debt too — the other injecting surface", async () => {
    // Arrange: same debt, but the next event is the DOCUMENTED failure
    // signal rather than a postToolUse with an embedded exitCode.
    const fixed = await fixture("cur-parity-failure");
    const conv = "conv-parity-failure";
    await registerLate(fixed, conv);

    // Act
    const stdout = await runCursorHook(
      "postToolUseFailure",
      withConversation(POST_TOOL_USE_FAILURE_INPUT, conv, fixed.repo),
      fixed.env,
    );

    // Assert: the briefing outranks the failure-matched hint here exactly as
    // it does on postToolUse — one injection, no candidates call.
    const context = deliveredAdditionalContext(stdout);
    expect(context).toContain(BRIEFING_HEADER);
    expect(context).toContain(TEAMMATE_NAME);
    expect(context).not.toContain(CANDIDATE_BODY);
    expect(fixed.hub.calls.candidates).toBe(0);
  });

  test("a sessionStart-registered conversation owes no deferred briefing", async () => {
    // Arrange: the NORMAL path — sessionStart delivered the briefing in-hook.
    const fixed = await fixture("cur-parity-normal");
    const conv = "conv-parity-normal";
    const startStdout = await runCursorHook(
      "sessionStart",
      withConversation(SESSION_START_INPUT, conv, fixed.repo),
      fixed.env,
    );
    expect(deliveredAdditionalContext(startStdout)).toContain(BRIEFING_HEADER);
    const registered = await readSessionState(
      fixed.home,
      cursorHostSessionKey(conv),
    );
    expect(registered?.briefingPending).toBe(false);

    // Act: a failing tool result on the briefed conversation
    const stdout = await runCursorHook(
      "postToolUse",
      withConversation(POST_TOOL_USE_FAILING_COMMAND, conv, fixed.repo),
      fixed.env,
    );

    // Assert: the failure path is the hint path, exactly as before
    const context = deliveredAdditionalContext(stdout);
    expect(context).not.toContain(BRIEFING_HEADER);
    expect(context).toContain(CANDIDATE_BODY);
    expect(fixed.hub.calls.candidates).toBe(1);
  });
});
