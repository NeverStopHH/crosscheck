/**
 * TOLD ONLY WHEN IT CAN BE SAID (review of feat/collision-visible, L3). A
 * group marked "told" or a relay queue drained before the hook's output is
 * on its way is a notice nobody ever sees: the budget race abandons the
 * handler, the marker stays, and the person is never told again. Each claim
 * is now the LAST step of its handler, and PreToolUse and UserPromptSubmit
 * make it only while their spare budget lasts — the hub is asked again on the
 * next edit and the queue waits for the next prompt, so a skipped claim is a
 * later notice, never a lost one. The handlers are driven directly here so
 * the budget can be held at zero without timing anything.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { handlePreToolUse } from "../src/hooks/pre-tool-use.ts";
import { handleSessionStart } from "../src/hooks/session-start.ts";
import { handleUserPromptSubmit } from "../src/hooks/user-prompt-submit.ts";
import { prepareHook } from "../src/hooks/runner.ts";
import type { HookBudget, HookContext } from "../src/hooks/runner.ts";
import type { Env } from "../src/index.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import {
  MIKE_FILES,
  NICK_NOTICE,
  OVERLAP_FILE,
  SESSION_ID,
  SUBAGENT,
  cleanupCollisionFixtures,
  collisionFixture,
  editPayload,
  ghostFixture,
  mikeGhostRow,
  parsed,
  promptPayload,
  sessionStartPayload,
} from "./fixtures/collision-fixture.ts";

const SPENT: HookBudget = { spareMs: () => 0 };
const AMPLE: HookBudget = { spareMs: () => 60_000 };

afterEach(cleanupCollisionFixtures);

const contextFor = async (stdin: string, env: Env): Promise<HookContext> => {
  const ctx = await prepareHook(stdin, env);
  if (ctx === null) {
    throw new Error("the fixture did not resolve a reportable repo");
  }
  return ctx;
};

describe("the tripwire's notice is claimed last", () => {
  test("with the spare spent, the ask still goes out and the group is NOT marked told", async () => {
    // Arrange
    const { repo, home, env } = await collisionFixture("co-spent");
    const ctx = await contextFor(editPayload(repo, OVERLAP_FILE), env);

    // Act
    const output = parsed(await handlePreToolUse(ctx, SPENT));

    // Assert
    expect(output.hookSpecificOutput?.permissionDecision).toBe("ask");
    expect(output.systemMessage).toBeUndefined();
    const state = await readSessionState(home, SESSION_ID);
    expect(state?.collisionNotices ?? []).toEqual([]);
  });

  test("the next edit, with time to say it, tells the person — and hands the agent the facts with the request", async () => {
    // Arrange: the first edit asked the agent but had no time to tell the person
    const { repo, env } = await collisionFixture("co-later");
    await handlePreToolUse(await contextFor(editPayload(repo, OVERLAP_FILE), env), SPENT);

    // Act
    const output = parsed(await handlePreToolUse(await contextFor(editPayload(repo, OVERLAP_FILE), env), AMPLE));

    // Assert: no second ask, but the line the first edit could not deliver
    expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(output.systemMessage).toBe(NICK_NOTICE);
    expect(output.hookSpecificOutput?.additionalContext?.startsWith(NICK_NOTICE)).toBe(true);
  });
});

describe("the subagent relay is drained last", () => {
  test("with the spare spent, the queue waits for the next prompt instead of draining into nothing", async () => {
    // Arrange: a subagent's hit is queued
    const { repo, home, env } = await collisionFixture("co-relay");
    await handlePreToolUse(await contextFor(editPayload(repo, OVERLAP_FILE, SUBAGENT), env), AMPLE);

    // Act
    const spent = await handleUserPromptSubmit(await contextFor(promptPayload(repo), env), SPENT);
    const queued = await readSessionState(home, SESSION_ID);
    const next = parsed(await handleUserPromptSubmit(await contextFor(promptPayload(repo), env), AMPLE));

    // Assert
    expect(spent).not.toContain(NICK_NOTICE);
    expect(queued?.collisionRelayQueue).toHaveLength(1);
    expect(next.hookSpecificOutput?.additionalContext).toContain(NICK_NOTICE);
  });
});

describe("the briefing's ghost notice is claimed after the maintenance", () => {
  test("a SessionStart whose maintenance spent the spare still tells the person — the claim is the hook's own step", async () => {
    // Arrange
    const { repo, home, env } = await ghostFixture("co-ghost", [mikeGhostRow(MIKE_FILES, 3)]);
    const ctx = await contextFor(sessionStartPayload(repo, "startup"), env);

    // Act
    const output = parsed(await handleSessionStart(ctx, SPENT));

    // Assert
    expect(output.systemMessage).toContain("Mike is working on 3 files you also touched");
    const state = await readSessionState(home, SESSION_ID);
    expect(state?.collisionNotices).toHaveLength(1);
  });
});
