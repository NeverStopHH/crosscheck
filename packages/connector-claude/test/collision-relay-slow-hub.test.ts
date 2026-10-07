/**
 * A SLOW HINT HUB NO LONGER STARVES THE RELAY (review of
 * feat/collision-visible, round 2, M3). UserPromptSubmit drained a
 * subagent's queued collision LAST, and only with spare budget left: probe
 * "starve" measured a hint hub answering in 390 ms — inside its 400 ms
 * timeout — leave no spare on three prompts running, and a blackholed hub
 * never relayed a background subagent's collision at all. A queued relay is
 * now drained FIRST (it is local), and the hint's hub call gets only the
 * budget the drain leaves, so the hook answers inside its budget with the
 * relay in it.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { runHook } from "../src/index.ts";
import { prepareHook } from "../src/hooks/runner.ts";
import { handleUserPromptSubmit } from "../src/hooks/user-prompt-submit.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { TEAMMATE_DEVELOPER_ID } from "../../connector-core/test/fixtures/hint-hub.ts";
import {
  NICK_NOTICE,
  OVERLAP_FILE,
  SESSION_ID,
  SUBAGENT,
  cleanupCollisionFixtures,
  collisionFixture,
  editPayload,
  parsed,
  presentNow,
  promptPayload,
} from "./fixtures/collision-fixture.ts";

afterEach(cleanupCollisionFixtures);

/** The probe's worst answer: inside the request timeout, past what a drain-last left. */
const SLOW_HINT_MS = 390;

/** A hub that holds the hint call far past every bound in play. */
const BLACKHOLED_MS = 10_000;

describe("a queued relay is drained before the prompt's hub calls", () => {
  test.each([
    ["390 ms, inside its timeout", SLOW_HINT_MS],
    ["blackholed", BLACKHOLED_MS],
  ] as const)("a hint hub answering %s still lets the queued relay out on the first prompt", async (_label, latency) => {
    // Arrange: a subagent's hit is queued, Nick still present; then the hint hub slows down
    const fix = await collisionFixture(`rs-${String(latency)}`);
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    await presentNow(fix, [TEAMMATE_DEVELOPER_ID]);
    fix.hub.latency.candidates = latency;

    // Act: the budget race returns "" if the hook runs past it, so a line here is a line in time
    const output = parsed(await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env));

    // Assert
    expect(output.systemMessage).toBe(NICK_NOTICE);
    expect(fix.hub.calls.candidates).toBe(1);
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.collisionRelayQueue).toEqual([]);
  });

  test("after the drain, the hint's hub call is cut at the spare the budget has left, not at its own timeout", async () => {
    // Arrange: a queued relay, a hint hub at the probe's latency, and a budget
    // with only SPARE_MS left once the drain is done
    const fix = await collisionFixture("rs-spare-bound");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    await presentNow(fix, [TEAMMATE_DEVELOPER_ID]);
    fix.hub.latency.candidates = SLOW_HINT_MS;
    const ctx = await prepareHook(promptPayload(fix.repo), fix.env);
    const started = Date.now();

    // Act
    const output = parsed(ctx === null ? "" : await handleUserPromptSubmit(ctx, { spareMs: () => SPARE_MS }));

    // Assert: the relay is out, and the hint call did not hold the hook for its 390 ms
    expect(output.systemMessage).toBe(NICK_NOTICE);
    expect(Date.now() - started).toBeLessThan(SLOW_HINT_MS - SPARE_MS);
  });
});

/** What the fake budget leaves after the drain: well under the hint hub's latency. */
const SPARE_MS = 50;
