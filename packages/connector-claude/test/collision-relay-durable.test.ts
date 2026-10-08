/**
 * A DRAINED RELAY ALWAYS LEAVES THE HOOK (review of feat/collision-visible,
 * round 3, F-M1). The drain used to empty the queue first and only then ask
 * presence for the answer the groups are held to — and the refresh's cache
 * write rethrows. A cache path nobody can write (EACCES, ENOSPC, EROFS, a
 * directory in its place) threw after the queue was already empty, the hook
 * returned nothing, and the groups stayed recorded as told: the person and
 * the main thread never heard of them. Probe r3a N1, the cache path made a
 * directory: subagent-return printed "", the queue was [], and the next
 * prompt was silent too.
 *
 * Now the answer is in hand BEFORE the locked drain, so a hook that throws or
 * is abandoned while it waits on presence leaves the queue for the next hook,
 * and a cache that cannot be written costs the cache, never the answer.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";

import { runHook } from "../src/index.ts";
import { presenceCachePath, repoKey } from "@crosscheck/connector-core/config/paths.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { TEAMMATE_DEVELOPER_ID } from "../../connector-core/test/fixtures/hint-hub.ts";
import {
  NICK_NOTICE,
  OVERLAP_FILE,
  REPO_ID,
  SESSION_ID,
  SUBAGENT,
  cleanupCollisionFixtures,
  collisionFixture,
  editPayload,
  parsed,
  promptPayload,
} from "./fixtures/collision-fixture.ts";
import type { CollisionFixture } from "./fixtures/collision-fixture.ts";

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

/**
 * A request timeout roomy enough that a loaded machine cannot spend the spare
 * the refresh is bounded by: only the relay's own cap can cut it.
 */
const roomyFixture = async (label: string): Promise<CollisionFixture> => {
  const fix = await collisionFixture(label);
  return { ...fix, env: { ...fix.env, CROSSCHECK_TIMEOUT_MS: "2000" } };
};

/** A presence answer that lists Nick, live now. */
const nickPresent = (fix: CollisionFixture): void => {
  fix.hub.setPresence([
    {
      sessionId: "cc_nick",
      developerId: TEAMMATE_DEVELOPER_ID,
      developerName: "Nick",
      branch: "feat/refresh-fix",
      status: "implementing",
      lastHeartbeatAt: new Date().toISOString(),
      isSelf: false,
    },
  ]);
};

describe("a drained relay always leaves the hook", () => {
  test("a presence cache that cannot be written still relays the hit, once", async () => {
    // Arrange: a subagent ran into Nick; the refresh answers, but its cache path is a directory
    const fix = await roomyFixture("rd-cachedir");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    nickPresent(fix);
    const cachePath = presenceCachePath(fix.home, repoKey(fix.hub.url, REPO_ID));
    await rm(cachePath, { force: true });
    await mkdir(`${cachePath}/blocker`, { recursive: true });

    // Act
    const returned = parsed(await runHook("subagent-return", agentReturned(fix.repo), fix.env));
    const nextPrompt = parsed(await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env));

    // Assert: told on the return, from the refresh's own answer, and not again
    expect(returned.systemMessage).toBe(NICK_NOTICE);
    expect(returned.hookSpecificOutput?.additionalContext).toContain(NICK_NOTICE);
    expect(fix.hub.calls.presence).toBeGreaterThanOrEqual(1);
    expect(nextPrompt.systemMessage).toBeUndefined();
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.collisionRelayQueue).toEqual([]);
  });

  test("the queue is still full while presence is asked: a hook that dies waiting loses nothing", async () => {
    // Arrange: the hub records the queue at the moment the relay waits on presence
    const fix = await roomyFixture("rd-order");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    nickPresent(fix);
    const queuedWhileAsked: number[] = [];
    fix.hub.setPresenceProbe(async () => {
      const state = await readSessionState(fix.home, SESSION_ID);
      queuedWhileAsked.push(state?.collisionRelayQueue?.length ?? 0);
    });

    // Act
    const returned = parsed(await runHook("subagent-return", agentReturned(fix.repo), fix.env));

    // Assert: asked once, with the queued group still on disk; drained only after
    expect(queuedWhileAsked).toEqual([1]);
    expect(returned.systemMessage).toBe(NICK_NOTICE);
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.collisionRelayQueue).toEqual([]);
  });
});
