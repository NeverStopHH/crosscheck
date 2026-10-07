/**
 * OPT-OUT, MUTE AND ENDED SESSIONS AFTER THE FACT (review of
 * feat/collision-visible, M2). A group is recorded from a row the hub had
 * already filtered — but the record outlives the moment: a teammate who opts
 * out, is muted or ends their session later must not keep being named. The
 * statusline names only teammates the hub's presence answer still lists, and
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

  test("Nick opted out, was muted or ended since: the hub drops him, and so does the indicator", async () => {
    // Arrange: the presence answer no longer lists him
    const fix = await collisionFixture("cv-hidden");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE), fix.env);
    await presentNow(fix, ["dev_someone_else"]);

    // Act
    const line = await statusline(fix.repo, fix.env);

    // Assert
    expect(line).not.toContain("overlap");
    expect(line).not.toContain("Nick");
  });

  test("a hub the statusline cannot read names nobody", async () => {
    // Arrange: no presence cache, and this hub answers presence with garbage
    const fix = await collisionFixture("cv-unknown");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE), fix.env);

    // Act
    const line = await statusline(fix.repo, fix.env);

    // Assert
    expect(line).not.toContain("overlap");
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

  test("older than the presence TTL, it names the teammate and the file only — no branch, no age", async () => {
    // Arrange: the row's heartbeat is past the TTL by the time the relay drains
    const fix = await collisionFixture("cv-relay-stale");
    fix.hub.setTripwireSessions([
      { ...activeTeammateSession(), lastHeartbeatAt: new Date(Date.now() - PRESENCE_TTL_MS - 60_000).toISOString() },
    ]);
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    await presentNow(fix, [TEAMMATE_DEVELOPER_ID]);

    // Act
    const output = parsed(await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env));

    // Assert
    expect(output.systemMessage).toBe("crosscheck: Nick is working on refresh.ts — talk before you both change it");
  });
});
