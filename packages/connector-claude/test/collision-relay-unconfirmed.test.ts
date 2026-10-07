/**
 * A QUEUED HIT IS NEVER TURNED INTO NOTHING (review of feat/collision-visible,
 * round 2, H1). The relay used to drop a subagent's queued group whole when a
 * FRESH presence answer no longer listed the teammate — and presence drops a
 * teammate whose session simply ENDED, not only one who opted out or was
 * muted. The queue was already drained and the group marked told, so the
 * person was never told at all; with a stale cache the very same hit WAS
 * relayed. Now a teammate a fresh presence answer lists is named, and every
 * other queued group is relayed unnamed — the file, never the name, the
 * branch or the age. Probe r2 C2: a subagent edits refresh.ts while Nick is on
 * it, then Nick ends his session before the subagent returns.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { runHook } from "../src/index.ts";
import {
  COLLISION_RELAY_SENTENCE,
  SUBAGENT_RELAY_HEADER,
} from "@crosscheck/connector-core/hints/collision-notice.ts";
import { PRESENCE_CACHE_TTL_MS } from "@crosscheck/connector-core/constants.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { TEAMMATE_DEVELOPER_ID } from "../../connector-core/test/fixtures/hint-hub.ts";
import {
  NICK_NOTICE,
  OVERLAP_FILE,
  SESSION_ID,
  SUBAGENT,
  UNNAMED_REFRESH_NOTICE,
  cleanupCollisionFixtures,
  collisionFixture,
  editPayload,
  parsed,
  presentNow,
  promptPayload,
} from "./fixtures/collision-fixture.ts";

afterEach(cleanupCollisionFixtures);

/** What Claude Code hands PostToolUse when a foreground Agent call completes. */
const agentReturned = (repo: string): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd: repo,
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_input: {},
    tool_response: { status: "completed" },
  });

/** Nothing on either copy says who, or where. */
const expectNobodyNamed = (text: string): void => {
  expect(text).not.toContain("Nick");
  expect(text).not.toContain("feat/refresh-fix");
  expect(text).not.toContain("last active");
};

describe("a subagent's hit whose teammate presence no longer confirms is relayed unnamed", () => {
  test("Nick ends his session before the subagent returns: the person still hears of refresh.ts", async () => {
    // Arrange: a subagent ran into Nick's work; then a fresh answer without him
    const fix = await collisionFixture("ru-ended");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    await presentNow(fix, []);

    // Act
    const output = parsed(await runHook("subagent-return", agentReturned(fix.repo), fix.env));

    // Assert
    expect(output.systemMessage).toBe(UNNAMED_REFRESH_NOTICE);
    expect(output.hookSpecificOutput?.additionalContext).toBe(
      [SUBAGENT_RELAY_HEADER, UNNAMED_REFRESH_NOTICE, COLLISION_RELAY_SENTENCE].join("\n"),
    );
    expectNobodyNamed(JSON.stringify(output));
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.collisionRelayQueue).toEqual([]);
  });

  test("a teammate who opted out or was muted since is relayed unnamed too", async () => {
    // Arrange: a fresh answer that lists somebody else
    const fix = await collisionFixture("ru-hidden");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    await presentNow(fix, ["dev_someone_else"]);

    // Act
    const output = parsed(await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env));

    // Assert
    expect(output.systemMessage).toBe(UNNAMED_REFRESH_NOTICE);
    expectNobodyNamed(JSON.stringify(output));
  });

  test("a STALE cache that still lists the teammate does not name them — the answer is the same whatever its age", async () => {
    // Arrange: the cache lists Nick, but it was fetched past its TTL
    const fix = await collisionFixture("ru-stale");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    await presentNow(fix, [TEAMMATE_DEVELOPER_ID], { fetchedAt: new Date(Date.now() - PRESENCE_CACHE_TTL_MS - 5_000) });

    // Act
    const output = parsed(await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env));

    // Assert
    expect(output.systemMessage).toBe(UNNAMED_REFRESH_NOTICE);
    expectNobodyNamed(JSON.stringify(output));
  });

  test("no presence cache at all: the hit is still relayed, unnamed", async () => {
    // Arrange
    const fix = await collisionFixture("ru-nocache");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);

    // Act
    const output = parsed(await runHook("subagent-return", agentReturned(fix.repo), fix.env));

    // Assert
    expect(output.systemMessage).toBe(UNNAMED_REFRESH_NOTICE);
  });

  test("a fresh answer that lists the teammate names them", async () => {
    // Arrange
    const fix = await collisionFixture("ru-named");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    await presentNow(fix, [TEAMMATE_DEVELOPER_ID]);

    // Act
    const output = parsed(await runHook("subagent-return", agentReturned(fix.repo), fix.env));

    // Assert
    expect(output.systemMessage).toBe(NICK_NOTICE);
  });
});
