/**
 * TOLD ONLY WHEN IT CAN BE SAID (review of feat/collision-visible, L3). A
 * group marked "told" or a relay queue drained before the hook's output is
 * on its way is a notice nobody ever sees: the budget race abandons the
 * handler, the marker stays, and the person is never told again. The relay
 * drain and the ghost claims are the LAST step of their handlers, and
 * UserPromptSubmit drains only while its spare budget lasts — the queue waits
 * for the next prompt, so a skipped drain is a later notice, never a lost
 * one. The handlers are driven directly here so the budget can be held at
 * zero without timing anything.
 *
 * PreToolUse no longer waits for the spare (batch-2 review, H2): its claim
 * tells with the ask, and a cut hook gives the claim back
 * (test/tripwire-claim-cut.test.ts). What stays here of it is the output for
 * an edit with no new ask but a group still untold.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { handlePreToolUse } from "../src/hooks/pre-tool-use.ts";
import { handleSessionStart } from "../src/hooks/session-start.ts";
import { handleUserPromptSubmit } from "../src/hooks/user-prompt-submit.ts";
import { prepareHook } from "../src/hooks/runner.ts";
import type { HookBudget, HookContext } from "../src/hooks/runner.ts";
import type { Env } from "../src/index.ts";
import {
  readSessionState,
  updateSessionState,
  withTripwireGroupAsked,
} from "@crosscheck/connector-core/state/session-state.ts";
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
  presentNow,
  promptPayload,
  sessionStartPayload,
} from "./fixtures/collision-fixture.ts";
import { TEAMMATE_DEVELOPER_ID } from "../../connector-core/test/fixtures/hint-hub.ts";

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

/** Nick's (file, work context) pair, as the tripwire's once-per key spells it. */
const NICK_ASK_KEY = JSON.stringify([OVERLAP_FILE, TEAMMATE_DEVELOPER_ID, "wc_nick"]);

describe("an edit with no new ask still tells a group never told", () => {
  test("the person gets the line — and the agent the facts with the request, no decision", async () => {
    // Arrange: the pair was asked before, and its group never told — a record
    // that had to let it go, or a state from before the claim told with the ask
    const { repo, home, env } = await collisionFixture("co-later");
    await updateSessionState(home, SESSION_ID, (fresh) => withTripwireGroupAsked(fresh, NICK_ASK_KEY));

    // Act
    const output = parsed(await handlePreToolUse(await contextFor(editPayload(repo, OVERLAP_FILE), env), SPENT));

    // Assert: no second ask, but the line the first edit could not deliver
    expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(output.systemMessage).toBe(NICK_NOTICE);
    expect(output.hookSpecificOutput?.additionalContext?.startsWith(NICK_NOTICE)).toBe(true);
  });
});

describe("the subagent relay is drained last", () => {
  test("with the spare spent, the queue waits for the next prompt instead of draining into nothing", async () => {
    // Arrange: a subagent's hit is queued, and presence still lists Nick
    const fix = await collisionFixture("co-relay");
    const { repo, home, env } = fix;
    await handlePreToolUse(await contextFor(editPayload(repo, OVERLAP_FILE, SUBAGENT), env), AMPLE);
    await presentNow(fix, [TEAMMATE_DEVELOPER_ID]);

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
