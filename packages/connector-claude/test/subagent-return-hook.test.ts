/**
 * THE SAME TURN, NOT THE NEXT PROMPT (review H1b). A subagent's collision used
 * to wait for the person's NEXT prompt before the main thread heard of it —
 * after the reply that should have mentioned it. The sync PostToolUse hook on
 * the subagent tools drains the queue the moment a foreground subagent
 * returns: the person sees the line, and the main thread's agent gets the
 * facts and the one request next to the tool result, before it writes its
 * reply. No hub call — one state read and one locked drain.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { runHook } from "../src/index.ts";
import {
  COLLISION_RELAY_SENTENCE,
  SUBAGENT_RELAY_HEADER,
  tripwireCollision,
} from "@crosscheck/connector-core/hints/collision-notice.ts";
import { COLLISION_NOTICE_MAX_LINES } from "@crosscheck/connector-core/constants.ts";
import {
  readSessionState,
  updateSessionState,
  withCollisionNotices,
  withQueuedCollisionRelays,
} from "@crosscheck/connector-core/state/session-state.ts";
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
import { TEAMMATE_DEVELOPER_ID } from "../../connector-core/test/fixtures/hint-hub.ts";

/** Two past the person's line cap. */
const SEVEN = 7;

afterEach(cleanupCollisionFixtures);

/** What Claude Code hands PostToolUse when a foreground Agent call completes. */
const agentReturned = (repo: string, extra: Record<string, string> = {}): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd: repo,
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_agent_01",
    tool_input: { description: "Refactor the refresh path", prompt: "…", subagent_type: "general-purpose" },
    tool_response: { status: "completed", agentId: "a4d2c8f1e0b3a297" },
    ...extra,
  });

const hubCalls = (calls: object): number =>
  Object.values(calls).reduce<number>((total, count) => total + Number(count), 0);

describe("a foreground subagent's return", () => {
  test("hands the main thread its queued collision in the same turn — the person's line and the agent's facts", async () => {
    // Arrange: a subagent ran into Nick's work, and presence still lists him
    const fix = await collisionFixture("sr-drain");
    const { repo, home, hub, env } = fix;
    await runHook("pre-tool-use", editPayload(repo, OVERLAP_FILE, SUBAGENT), env);
    await presentNow(fix, [TEAMMATE_DEVELOPER_ID]);
    const before = hubCalls(hub.calls);

    // Act
    const output = parsed(await runHook("subagent-return", agentReturned(repo), env));

    // Assert
    expect(output.systemMessage).toBe(NICK_NOTICE);
    expect(output.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
    expect(output.hookSpecificOutput?.additionalContext).toBe(
      [SUBAGENT_RELAY_HEADER, NICK_NOTICE, COLLISION_RELAY_SENTENCE].join("\n"),
    );
    expect(hubCalls(hub.calls)).toBe(before);
    const state = await readSessionState(home, SESSION_ID);
    expect(state?.collisionRelayQueue).toEqual([]);
  });

  test("leaves nothing for the next prompt to repeat", async () => {
    // Arrange
    const { repo, env } = await collisionFixture("sr-once");
    await runHook("pre-tool-use", editPayload(repo, OVERLAP_FILE, SUBAGENT), env);
    await runHook("subagent-return", agentReturned(repo), env);

    // Act
    const prompt = await runHook("user-prompt-submit", promptPayload(repo), env);

    // Assert
    expect(prompt).not.toContain(NICK_NOTICE);
  });

  test("with nothing queued, says nothing", async () => {
    // Arrange
    const { repo, env } = await collisionFixture("sr-quiet");

    // Act
    const output = await runHook("subagent-return", agentReturned(repo), env);

    // Assert
    expect(output).toBe("");
  });

  test("seven queued groups: the person reads five and a count, the agent is handed all seven (round 2, L10)", async () => {
    // Arrange: seven teammates a subagent ran into, all still present
    const fix = await collisionFixture("sr-seven");
    const groups = Array.from({ length: SEVEN }, (_, index) =>
      tripwireCollision(
        {
          sessionId: `cc_${String(index)}`,
          developerId: `dev_${String(index)}`,
          developerName: `T${String(index)}`,
          branch: "feat/refresh-fix",
          status: "implementing",
          lastHeartbeatAt: new Date().toISOString(),
          workContextId: `wc_${String(index)}`,
          workContextTitle: "t",
        },
        `src/file${String(index)}.ts`,
      ),
    );
    await updateSessionState(fix.home, SESSION_ID, (fresh) =>
      withQueuedCollisionRelays(withCollisionNotices(fresh, groups), groups.map((group) => group.key)),
    );
    await presentNow(fix, groups.map((group) => group.developerId));

    // Act
    const output = parsed(await runHook("subagent-return", agentReturned(fix.repo), fix.env));

    // Assert
    const person = (output.systemMessage ?? "").split("\n");
    expect(person).toHaveLength(COLLISION_NOTICE_MAX_LINES + 1);
    expect(person.at(-1)).toBe(`crosscheck: +${String(SEVEN - COLLISION_NOTICE_MAX_LINES)} more teammate overlaps not shown`);
    const agent = output.hookSpecificOutput?.additionalContext ?? "";
    for (const group of groups) {
      expect(agent).toContain(`crosscheck: ${group.name} is working on`);
    }
    expect(agent).not.toContain("more teammate overlap");
  });

  test("a subagent's OWN subagent returning leaves the queue for the main thread", async () => {
    // Arrange: a nested Agent call fires its PostToolUse inside the subagent
    const { repo, home, env } = await collisionFixture("sr-nested");
    await runHook("pre-tool-use", editPayload(repo, OVERLAP_FILE, SUBAGENT), env);

    // Act
    const nested = await runHook("subagent-return", agentReturned(repo, SUBAGENT), env);

    // Assert
    expect(nested).toBe("");
    const state = await readSessionState(home, SESSION_ID);
    expect(state?.collisionRelayQueue).toHaveLength(1);
  });
});
