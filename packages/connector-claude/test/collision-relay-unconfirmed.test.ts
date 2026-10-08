/**
 * A QUEUED HIT IS NEVER TURNED INTO NOTHING, AND IS UNNAMED ONLY ON CONTRARY
 * EVIDENCE (review of feat/collision-visible, round 2, H1 as refined). The
 * relay used to drop a subagent's queued group whole when a FRESH presence
 * answer no longer listed the teammate — and presence drops a teammate whose
 * session simply ENDED, not only one who opted out or was muted — after the
 * queue was drained and the group marked told. Now:
 *
 *   - a presence answer that OMITS the teammate relays the file unnamed;
 *   - an answer that lists them names them, with the branch it reports;
 *   - with no fresh answer cached the relay asks ONCE, bounded
 *     (RELAY_PRESENCE_REFRESH_MS), through the statusline's own call and
 *     cache — a subagent that ran past the 10 s cache in a session with no
 *     statusline (every IDE session) would otherwise have no answer at all;
 *   - when that refresh fails or runs out, the teammate is named as the
 *     tripwire's own answer named them at the edit.
 *
 * The outcome depends on the answer alone: a stale cache decides nothing.
 * Probe r2 C2: a subagent edits refresh.ts while Nick is on it, then Nick
 * ends his session before the subagent returns.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { runHook } from "../src/index.ts";
import {
  COLLISION_RELAY_SENTENCE,
  SUBAGENT_RELAY_HEADER,
} from "@crosscheck/connector-core/hints/collision-notice.ts";
import { PRESENCE_CACHE_TTL_MS } from "@crosscheck/connector-core/constants.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import { isCacheFresh, readPresenceCache } from "@crosscheck/connector-core/state/presence-cache.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { TEAMMATE_DEVELOPER_ID } from "../../connector-core/test/fixtures/hint-hub.ts";
import {
  NICK_NOTICE,
  OVERLAP_FILE,
  REPO_ID,
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

/** Nothing on either copy says who, or where. */
const expectNobodyNamed = (text: string): void => {
  expect(text).not.toContain("Nick");
  expect(text).not.toContain("feat/refresh-fix");
  expect(text).not.toContain("last active");
};

/** A presence row the refresh can answer with. */
const presenceRow = (developerId: string, branch: string): Record<string, unknown> => ({
  sessionId: `cc_${developerId}`,
  developerId,
  developerName: developerId,
  branch,
  status: "implementing",
  lastHeartbeatAt: new Date().toISOString(),
  isSelf: false,
});

/** A cache fetched past its TTL: no answer, only a memory of one. */
const STALE = (): Date => new Date(Date.now() - PRESENCE_CACHE_TTL_MS - 5_000);

/**
 * A request timeout roomy enough that only the relay's own cap can cut the
 * refresh: at the default 400 ms the spare the refresh is bounded by is what
 * the hook's own preparation leaves of one timeout, and a loaded machine
 * spends it — the answer then arrives after the relay stopped waiting.
 */
const ROOMY_TIMEOUT_MS = "2000";

/** The collision fixture under the roomy request timeout. */
const roomyFixture = async (label: string): Promise<CollisionFixture> => {
  const fix = await collisionFixture(label);
  return { ...fix, env: { ...fix.env, CROSSCHECK_TIMEOUT_MS: ROOMY_TIMEOUT_MS } };
};

/** Far past RELAY_PRESENCE_REFRESH_MS, inside the roomy request timeout. */
const SLOW_PRESENCE_MS = 1_500;

/** The cap plus the hook's own work, well under the slow presence answer. */
const WITHIN_CAP_MS = 800;

describe("a FRESH presence answer decides, with no hub call", () => {
  test("Nick ends his session before the subagent returns: the answer omits him, and the file is still relayed", async () => {
    // Arrange: a subagent ran into Nick's work; then a fresh answer without him
    const fix = await roomyFixture("ru-ended");
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
    expect(fix.hub.calls.presence).toBe(0);
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.collisionRelayQueue).toEqual([]);
  });

  test("a teammate who opted out or was muted since is relayed unnamed too", async () => {
    // Arrange: a fresh answer that lists somebody else
    const fix = await roomyFixture("ru-hidden");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    await presentNow(fix, ["dev_someone_else"]);

    // Act
    const output = parsed(await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env));

    // Assert
    expect(output.systemMessage).toBe(UNNAMED_REFRESH_NOTICE);
    expectNobodyNamed(JSON.stringify(output));
  });

  test("a fresh answer that lists the teammate names them", async () => {
    // Arrange
    const fix = await roomyFixture("ru-named");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    await presentNow(fix, [TEAMMATE_DEVELOPER_ID]);

    // Act
    const output = parsed(await runHook("subagent-return", agentReturned(fix.repo), fix.env));

    // Assert
    expect(output.systemMessage).toBe(NICK_NOTICE);
    expect(fix.hub.calls.presence).toBe(0);
  });
});

describe("with no fresh answer, the relay asks presence once", () => {
  test("a refresh that lists the teammate names them, with the branch it reports, and refreshes the cache", async () => {
    // Arrange: no cache; the hub's presence answer lists Nick on another branch
    const fix = await roomyFixture("ru-refresh-named");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    fix.hub.setPresence([presenceRow(TEAMMATE_DEVELOPER_ID, "feat/rotation-2")]);

    // Act
    const output = parsed(await runHook("subagent-return", agentReturned(fix.repo), fix.env));

    // Assert
    expect(output.systemMessage).toContain("Nick is working on refresh.ts on branch feat/rotation-2 (last active just now)");
    expect(fix.hub.calls.presence).toBe(1);
    const cache = await readPresenceCache(fix.home, repoKey(fix.hub.url, REPO_ID));
    expect(cache !== null && isCacheFresh(cache, new Date())).toBe(true);
  });

  test("a refresh that answers without the teammate anonymises", async () => {
    // Arrange
    const fix = await roomyFixture("ru-refresh-omits");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    fix.hub.setPresence([presenceRow("dev_someone_else", "feat/other")]);

    // Act
    const output = parsed(await runHook("subagent-return", agentReturned(fix.repo), fix.env));

    // Assert
    expect(output.systemMessage).toBe(UNNAMED_REFRESH_NOTICE);
    expectNobodyNamed(JSON.stringify(output));
  });

  test("a STALE cache that omits the teammate, plus a failing refresh, still names them as the tripwire did", async () => {
    // Arrange: an old answer without Nick, and a hub whose presence answer cannot be read
    const fix = await roomyFixture("ru-stale-failing");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    await presentNow(fix, [], { fetchedAt: STALE() });

    // Act
    const output = parsed(await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env));

    // Assert: the stale cache decided nothing; no answer means the hit's own name
    expect(output.systemMessage).toBe(NICK_NOTICE);
    expect(fix.hub.calls.presence).toBe(1);
  });

  test("a STALE cache that lists the teammate decides nothing either: the refresh's answer does", async () => {
    // Arrange: an old answer WITH Nick, and a refresh that answers without him
    const fix = await roomyFixture("ru-stale-contrary");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    await presentNow(fix, [TEAMMATE_DEVELOPER_ID], { fetchedAt: STALE() });
    fix.hub.setPresence([]);

    // Act
    const output = parsed(await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env));

    // Assert
    expect(output.systemMessage).toBe(UNNAMED_REFRESH_NOTICE);
  });

  test("no cache and a failing refresh: the hit is relayed, named as the tripwire named it", async () => {
    // Arrange
    const fix = await roomyFixture("ru-nocache");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);

    // Act
    const output = parsed(await runHook("subagent-return", agentReturned(fix.repo), fix.env));

    // Assert
    expect(output.systemMessage).toBe(NICK_NOTICE);
  });

  test("a refresh slower than its cap is no answer: named from the hit, without waiting for presence", async () => {
    // Arrange: a roomy request timeout, so only the relay's own cap can cut the call
    const fix = await roomyFixture("ru-refresh-slow");
    const env = { ...fix.env, CROSSCHECK_TIMEOUT_MS: ROOMY_TIMEOUT_MS };
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), env);
    fix.hub.setPresence([presenceRow("dev_someone_else", "feat/other")]);
    fix.hub.latency.presence = SLOW_PRESENCE_MS;
    const started = Date.now();

    // Act
    const output = parsed(await runHook("subagent-return", agentReturned(fix.repo), env));

    // Assert
    expect(output.systemMessage).toBe(NICK_NOTICE);
    expect(Date.now() - started).toBeLessThan(WITHIN_CAP_MS);
  });
});
