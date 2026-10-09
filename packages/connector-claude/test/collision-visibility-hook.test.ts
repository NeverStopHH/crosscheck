/**
 * OPT-OUT, MUTE AND ENDED SESSIONS AFTER THE FACT (review of
 * feat/collision-visible, M2). A group is recorded from a row the hub had
 * already filtered — but the record outlives the moment: a teammate who opts
 * out, is muted or ends their session later must not keep being named. The
 * statusline names only teammates the hub's presence answer still lists and
 * counts the rest (round 2, M1; test/collision-statusline-unnamed.test.ts), and
 * a relayed subagent hit names the teammate only while a fresh presence
 * answer lists them — otherwise it is relayed unnamed (round 2, H1;
 * test/collision-relay-unconfirmed.test.ts) — and loses branch and age once
 * it is older than the presence TTL.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { runHook, runStatusline } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { PRESENCE_TTL_MS } from "@crosscheck/connector-core/constants.ts";
import { TEAMMATE_DEVELOPER_ID, activeTeammateSession } from "../../connector-core/test/fixtures/hint-hub.ts";
import {
  BEHAVIOUR_TIMING,
  NICK_NOTICE,
  OVERLAP_FILE,
  SESSION_ID,
  SUBAGENT,
  UNNAMED_REFRESH_NOTICE,
  cleanupCollisionFixtures,
  collisionFixture as fixtureUntimed,
  editPayload,
  parsed,
  presentNow,
  promptPayload,
} from "./fixtures/collision-fixture.ts";
import type { CollisionFixture } from "./fixtures/collision-fixture.ts";

afterEach(cleanupCollisionFixtures);

/**
 * These tests are about WHAT is said, not how fast (batch-2 review, L15):
 * one failed 1 round in 3 at load 18 on the production 800 ms budget — the
 * same mechanism as H2 — so they take the roomy timing every behaviour test
 * of the collision hooks takes.
 */
const collisionFixture = (label: string): Promise<CollisionFixture> => fixtureUntimed(label, BEHAVIOUR_TIMING);

const statusline = (repo: string, env: Env): Promise<string> =>
  runStatusline(JSON.stringify({ session_id: SESSION_ID, cwd: repo }), env);

describe("the statusline names only teammates the hub still lists as present", () => {
  test("Nick present: the indicator leads the line", async () => {
    // Arrange
    const fix = await collisionFixture("cv-present");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE), fix.env);
    await presentNow(fix, [TEAMMATE_DEVELOPER_ID]);

    // Act
    const line = await statusline(fix.repo, fix.env);

    // Assert
    expect(line.startsWith("⚠ overlap: Nick · 1 file · ")).toBe(true);
  });

  test("Nick opted out, was muted or ended since: the hub drops him, and the indicator drops his name and keeps the count", async () => {
    // Arrange: the presence answer no longer lists him
    const fix = await collisionFixture("cv-hidden");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE), fix.env);
    await presentNow(fix, ["dev_someone_else"]);

    // Act
    const line = await statusline(fix.repo, fix.env);

    // Assert
    expect(line.startsWith("⚠ overlap: 1 teammate · 1 file · ")).toBe(true);
    expect(line).not.toContain("Nick");
  });

  test("a hub the statusline cannot read names nobody, and still counts the overlap", async () => {
    // Arrange: no presence cache, and this hub answers presence with garbage
    const fix = await collisionFixture("cv-unknown");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE), fix.env);

    // Act
    const line = await statusline(fix.repo, fix.env);

    // Assert
    expect(line.startsWith("⚠ overlap: 1 teammate · 1 file · ")).toBe(true);
    expect(line).not.toContain("Nick");
  });
});

describe("a relayed subagent hit is held to presence as it is now", () => {
  test("relayed unnamed when a fresh presence answer no longer lists the teammate", async () => {
    // Arrange
    const fix = await collisionFixture("cv-relay-hidden");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    await presentNow(fix, ["dev_someone_else"]);

    // Act
    const prompt = await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env);

    // Assert
    expect(parsed(prompt).systemMessage).toBe(UNNAMED_REFRESH_NOTICE);
    expect(prompt).not.toContain("Nick");
  });

  test("kept, branch and age included, while the teammate is present and the hit is fresh", async () => {
    // Arrange
    const fix = await collisionFixture("cv-relay-present");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    await presentNow(fix, [TEAMMATE_DEVELOPER_ID]);

    // Act
    const output = parsed(await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env));

    // Assert
    expect(output.systemMessage).toBe(NICK_NOTICE);
  });

  test("a subagent that ran past the presence TTL keeps branch and age while presence still lists the teammate (round 2, L3)", async () => {
    // Arrange: the hit's heartbeat is past the TTL by the time the relay
    // drains — a long subagent run — but a fresh answer lists Nick, on his branch
    const fix = await collisionFixture("cv-relay-long-run");
    fix.hub.setTripwireSessions([
      { ...activeTeammateSession(), lastHeartbeatAt: new Date(Date.now() - PRESENCE_TTL_MS - 60_000).toISOString() },
    ]);
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    await presentNow(fix, [TEAMMATE_DEVELOPER_ID], { branch: "feat/refresh-fix" });

    // Act
    const output = parsed(await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env));

    // Assert
    expect(output.systemMessage).toBe(NICK_NOTICE);
  });

  test("the branch it names is the one presence reports now, not the one the hit recorded", async () => {
    // Arrange
    const fix = await collisionFixture("cv-relay-moved");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    await presentNow(fix, [TEAMMATE_DEVELOPER_ID], { branch: "feat/rotation-2" });

    // Act
    const output = parsed(await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env));

    // Assert
    expect(output.systemMessage).toContain("Nick is working on refresh.ts on branch feat/rotation-2 (last active just now)");
  });
});
