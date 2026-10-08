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
 *
 * WHAT IS ASSERTED IS WORK, NOT WALL TIME (round 3, F-L9). These tests used
 * to read the hook's clock: whether the budget race let the line out, and
 * how long the hook took. On a loaded machine both went red with the fix in
 * place. They now pin the two facts the fix is made of, each of which flips
 * outright under its defect at any load: the queue is EMPTY by the time the
 * hint hub is asked, and a hint call held to a 50 ms spare never delivers an
 * answer that takes 390 ms — under a request timeout roomy enough that only
 * the spare bound can be what cut it.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { runHook } from "../src/index.ts";
import { prepareHook } from "../src/hooks/runner.ts";
import { handleUserPromptSubmit } from "../src/hooks/user-prompt-submit.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import {
  CANDIDATE_BODY,
  TEAMMATE_DEVELOPER_ID,
  rejectedApproachCandidate,
} from "../../connector-core/test/fixtures/hint-hub.ts";
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
} from "./fixtures/collision-fixture.ts";
import type { CollisionFixture } from "./fixtures/collision-fixture.ts";

afterEach(cleanupCollisionFixtures);

/** The probe's worst answer: inside the default request timeout, past what a drain-last left. */
const SLOW_HINT_MS = 390;

/** A hub that holds the hint call far past every bound in play. */
const BLACKHOLED_MS = 10_000;

/** What the fake budget leaves after the drain: well under the hint hub's latency. */
const SPARE_MS = 50;

/**
 * A request timeout the hint's 390 ms answer fits inside with room to spare,
 * so a call NOT held to the spare gets its answer whatever the load, and a
 * relay is never lost to the budget race on a busy machine — and short
 * enough that the blackholed hub's call, cut at the spare, ends well inside
 * bun's own per-test timeout.
 */
const ROOMY_TIMEOUT_MS = "1000";

/** The hint's canned prompt: the one the rejected-approach candidate matches. */
const HINT_PROMPT = "why does src/auth/refresh.ts still 500 after the key rotation";

const hintPrompt = (repo: string): string =>
  JSON.stringify({ session_id: SESSION_ID, cwd: repo, hook_event_name: "UserPromptSubmit", prompt: HINT_PROMPT });

/** A subagent's hit queued for the main thread, Nick still present, under the roomy timeout. */
const queuedFixture = async (label: string): Promise<CollisionFixture> => {
  const fix = await collisionFixture(label);
  const roomy = { ...fix, env: { ...fix.env, CROSSCHECK_TIMEOUT_MS: ROOMY_TIMEOUT_MS } };
  await runHook("pre-tool-use", editPayload(roomy.repo, OVERLAP_FILE, SUBAGENT), roomy.env);
  await presentNow(roomy, [TEAMMATE_DEVELOPER_ID]);
  return roomy;
};

describe("a queued relay is drained before the prompt's hub calls", () => {
  test.each([
    ["390 ms, inside its timeout", SLOW_HINT_MS],
    ["blackholed", BLACKHOLED_MS],
  ] as const)("a hint hub answering %s is asked only once the queue is empty, and the relay is out", async (_label, latency) => {
    // Arrange: the hint hub records the queue at the moment it is asked
    const fix = await queuedFixture(`rs-${String(latency)}`);
    fix.hub.latency.candidates = latency;
    const queuedWhenAsked: number[] = [];
    fix.hub.setCandidatesProbe(async () => {
      const state = await readSessionState(fix.home, SESSION_ID);
      queuedWhenAsked.push(state?.collisionRelayQueue?.length ?? 0);
    });

    // Act
    const output = parsed(await runHook("user-prompt-submit", hintPrompt(fix.repo), fix.env));

    // Assert: drained first, so a slow or dead hint hub has nothing left to starve
    expect(queuedWhenAsked).toEqual([0]);
    expect(output.systemMessage).toBe(NICK_NOTICE);
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.collisionRelayQueue).toEqual([]);
  });

  test("after the drain, the hint's hub call is cut at the spare the budget has left, not at its own timeout", async () => {
    // Arrange: a queued relay, a hint hub that WOULD deliver a hint after
    // 390 ms, and a budget with only SPARE_MS left once the drain is done
    const fix = await queuedFixture("rs-spare-bound");
    fix.hub.setCandidates([rejectedApproachCandidate()]);
    fix.hub.latency.candidates = SLOW_HINT_MS;
    const ctx = await prepareHook(hintPrompt(fix.repo), fix.env);

    // Act
    const output = parsed(ctx === null ? "" : await handleUserPromptSubmit(ctx, { spareMs: () => SPARE_MS }));

    // Assert: the relay is out, the hint was asked for, and its 390 ms answer
    // never arrived — the call gave up at the spare, inside a 1 s timeout
    expect(output.systemMessage).toBe(NICK_NOTICE);
    expect(fix.hub.calls.candidates).toBe(1);
    expect(output.hookSpecificOutput?.additionalContext ?? "").not.toContain(CANDIDATE_BODY);
  });

  test("the same hint, with time to spare, IS delivered — so its absence above is the bound's doing", async () => {
    // Arrange
    const fix = await queuedFixture("rs-spare-control");
    fix.hub.setCandidates([rejectedApproachCandidate()]);
    fix.hub.latency.candidates = SLOW_HINT_MS;
    const ctx = await prepareHook(hintPrompt(fix.repo), fix.env);

    // Act: a spare far past the hint's latency
    const output = parsed(ctx === null ? "" : await handleUserPromptSubmit(ctx, { spareMs: () => 60_000 }));

    // Assert
    expect(output.systemMessage).toBe(NICK_NOTICE);
    expect(output.hookSpecificOutput?.additionalContext ?? "").toContain(CANDIDATE_BODY);
  });
});
