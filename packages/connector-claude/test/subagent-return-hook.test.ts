/**
 * THE SAME TURN, NOT THE NEXT PROMPT (review H1b). A subagent's collision used
 * to wait for the person's NEXT prompt before the main thread heard of it —
 * after the reply that should have mentioned it. The sync PostToolUse hook on
 * the subagent tools drains the queue the moment a foreground subagent
 * returns: the person sees the line, and the main thread's agent gets the
 * facts and the one request next to the tool result, before it writes its
 * reply. With a fresh presence answer cached, no hub call — one state read
 * and one locked drain (the one bounded refresh without one is pinned in
 * test/collision-relay-unconfirmed.test.ts).
 */
import { afterEach, describe, expect, test } from "bun:test";

import { runHook } from "../src/index.ts";
import { prepareHook } from "../src/hooks/runner.ts";
import { handleSubagentReturn } from "../src/hooks/subagent-return.ts";
import {
  COLLISION_RELAY_SENTENCE,
  COUNT_ONLY_RELAY_SENTENCE,
  SUBAGENT_RELAY_HEADER,
  collisionKey,
  tripwireCollision,
} from "@crosscheck/connector-core/hints/collision-notice.ts";
import { COLLISION_NOTICE_MAX_LINES, MAX_COLLISION_NOTICES } from "@crosscheck/connector-core/constants.ts";
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
import { CANDIDATE_CONTEXT_ID, TEAMMATE_DEVELOPER_ID } from "../../connector-core/test/fixtures/hint-hub.ts";

/** Two past the person's line cap. */
const SEVEN = 7;

/** A budget with time to spare, so only the payload decides. */
const AMPLE_SPARE_MS = 60_000;

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

  test("queued groups the record had to let go are still counted to both copies (round 2, L6)", async () => {
    // Arrange: Nick queued, two more the 32-group cap had to drop
    const fix = await collisionFixture("sr-dropped");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    await updateSessionState(fix.home, SESSION_ID, (fresh) => ({ ...fresh, collisionRelayDropped: 2 }));
    await presentNow(fix, [TEAMMATE_DEVELOPER_ID]);

    // Act
    const output = parsed(await runHook("subagent-return", agentReturned(fix.repo), fix.env));

    // Assert
    const more = "crosscheck: +2 more teammate overlaps not shown";
    expect(output.systemMessage).toBe([NICK_NOTICE, more].join("\n"));
    expect(output.hookSpecificOutput?.additionalContext).toBe(
      [SUBAGENT_RELAY_HEADER, NICK_NOTICE, more, COLLISION_RELAY_SENTENCE].join("\n"),
    );
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.collisionRelayDropped).toBe(0);
  });

  test("a queue key whose group the record no longer holds is counted, not relayed as nothing (round 2, L6)", async () => {
    // Arrange: an older writer left a key with no group behind it
    const fix = await collisionFixture("sr-orphan");
    await updateSessionState(fix.home, SESSION_ID, (fresh) => ({
      ...fresh,
      collisionRelayQueue: [JSON.stringify(["dev_gone", "wc_gone"])],
    }));

    // Act
    const output = parsed(await runHook("subagent-return", agentReturned(fix.repo), fix.env));

    // Assert: a count with nothing named above it says what it is (round 3, F-L2)
    expect(output.systemMessage).toBe(
      "crosscheck: a subagent ran into 1 teammate overlap whose details were not kept — talk to your team before you merge",
    );
  });

  test("a drop tally with an empty queue is still owned up to (round 2, L6)", async () => {
    // Arrange
    const fix = await collisionFixture("sr-tally-only");
    await updateSessionState(fix.home, SESSION_ID, (fresh) => ({ ...fresh, collisionRelayDropped: 2 }));

    // Act
    const output = parsed(await runHook("subagent-return", agentReturned(fix.repo), fix.env));

    // Assert: a count names nobody, so presence is not asked — and both copies say what a count can (round 3, F-L2)
    const counted =
      "crosscheck: a subagent ran into 2 teammate overlaps whose details were not kept — talk to your team before you merge";
    expect(output.systemMessage).toBe(counted);
    expect(output.hookSpecificOutput?.additionalContext).toBe(
      [SUBAGENT_RELAY_HEADER, counted, COUNT_ONLY_RELAY_SENTENCE].join("\n"),
    );
    expect(fix.hub.calls.presence).toBe(0);
  });

  test("a subagent's hit on a record full of queued groups keeps its own facts for the drain (round 2, L6)", async () => {
    // Arrange: 32 groups already queued for the main thread
    const fix = await collisionFixture("sr-full");
    const queued = Array.from({ length: MAX_COLLISION_NOTICES }, (_, index) =>
      tripwireCollision(
        {
          sessionId: `cc_q${String(index)}`,
          developerId: `dev_q${String(index)}`,
          developerName: `Q${String(index)}`,
          branch: "feat/q",
          status: "implementing",
          lastHeartbeatAt: new Date().toISOString(),
          workContextId: `wc_q${String(index)}`,
          workContextTitle: "t",
        },
        `src/q${String(index)}.ts`,
      ),
    );
    await updateSessionState(fix.home, SESSION_ID, (fresh) =>
      withCollisionNotices(withQueuedCollisionRelays(fresh, queued.map((group) => group.key)), queued),
    );

    // Act: a subagent runs into Nick
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);

    // Assert: Nick's facts are kept beside his queued key, and the oldest queued group is counted
    const state = await readSessionState(fix.home, SESSION_ID);
    const nickKey = collisionKey(TEAMMATE_DEVELOPER_ID, CANDIDATE_CONTEXT_ID);
    expect(state?.collisionNotices?.some((group) => group.key === nickKey && group.name === "Nick")).toBe(true);
    expect(state?.collisionRelayQueue).toContain(nickKey);
    expect(state?.collisionRelayDropped).toBe(1);
  });

  test("the drain itself leaves the queue for the main thread on a subagent's payload, past the runner's shortcut (reviewer mutation R8)", async () => {
    // Arrange: the runner answers an `agent_id` fire before any handler runs
    // (round 2, M2), so the handler is driven directly — the drain's own
    // guard is what stands between a nested return and the main thread's queue
    const fix = await collisionFixture("sr-drain-guard");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    const ctx = await prepareHook(agentReturned(fix.repo, SUBAGENT), fix.env);

    // Act
    const output = ctx === null ? "no context" : await handleSubagentReturn(ctx, { spareMs: () => AMPLE_SPARE_MS });

    // Assert
    expect(output).toBe("");
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.collisionRelayQueue).toHaveLength(1);
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
