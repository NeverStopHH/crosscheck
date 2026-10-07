/**
 * EVERY TEAMMATE THE TRIPWIRE ANSWER NAMES (review of feat/collision-visible,
 * M4). The hook used to read `sessions[0]` and mark the FILE asked, so a
 * second teammate on the same file — at once, or one who started on it later
 * in the session — was never told to anybody. Now every returned session is a
 * group the person may be told about, and the agent's ask is once per (file,
 * teammate work context).
 */
import { afterEach, describe, expect, test } from "bun:test";

import { runHook } from "../src/index.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { activeTeammateSession } from "../../connector-core/test/fixtures/hint-hub.ts";
import {
  NICK_NOTICE,
  OVERLAP_FILE,
  SESSION_ID,
  cleanupCollisionFixtures,
  collisionFixture,
  editPayload,
  kenSession,
  parsed,
} from "./fixtures/collision-fixture.ts";

const KEN_NOTICE =
  "crosscheck: Ken is working on refresh.ts on branch feat/ken-rotation (last active just now) — " +
  "talk before you both change it";

afterEach(cleanupCollisionFixtures);

describe("two teammates on one file", () => {
  test("both are told to the person at once; the agent is asked about the first", async () => {
    // Arrange
    const { repo, hub, env } = await collisionFixture("ct-both");
    hub.setTripwireSessions([activeTeammateSession(), kenSession()]);

    // Act
    const output = parsed(await runHook("pre-tool-use", editPayload(repo, OVERLAP_FILE), env));

    // Assert
    expect(output.systemMessage).toBe([NICK_NOTICE, KEN_NOTICE].join("\n"));
    expect(output.hookSpecificOutput?.permissionDecisionReason).toContain("Nick has an active session");
  });

  test("the next edit of the same file asks the agent about the second, and tells the person nothing new", async () => {
    // Arrange
    const { repo, hub, env } = await collisionFixture("ct-second-ask");
    hub.setTripwireSessions([activeTeammateSession(), kenSession()]);
    await runHook("pre-tool-use", editPayload(repo, OVERLAP_FILE), env);

    // Act
    const second = parsed(await runHook("pre-tool-use", editPayload(repo, OVERLAP_FILE), env));
    const third = await runHook("pre-tool-use", editPayload(repo, OVERLAP_FILE), env);

    // Assert
    expect(second.hookSpecificOutput?.permissionDecisionReason).toContain("Ken has an active session");
    expect(second.systemMessage).toBeUndefined();
    expect(third).toBe("");
  });

  test("the same teammate's work listed twice in one answer — two windows — is one line (round 2, L7)", async () => {
    // Arrange: two of Nick's sessions on the same work context
    const { repo, hub, env } = await collisionFixture("ct-twice");
    hub.setTripwireSessions([activeTeammateSession(), { ...activeTeammateSession(), sessionId: "cc_nick_2" }]);

    // Act
    const output = parsed(await runHook("pre-tool-use", editPayload(repo, OVERLAP_FILE), env));

    // Assert
    expect(output.systemMessage).toBe(NICK_NOTICE);
  });

  test("a teammate who starts on an already-asked file later is told when they appear", async () => {
    // Arrange: Nick alone first
    const { repo, home, hub, env } = await collisionFixture("ct-later");
    await runHook("pre-tool-use", editPayload(repo, OVERLAP_FILE), env);
    hub.setTripwireSessions([activeTeammateSession(), kenSession()]);

    // Act
    const later = parsed(await runHook("pre-tool-use", editPayload(repo, OVERLAP_FILE), env));

    // Assert
    expect(later.systemMessage).toBe(KEN_NOTICE);
    expect(later.hookSpecificOutput?.permissionDecisionReason).toContain("Ken has an active session");
    const state = await readSessionState(home, SESSION_ID);
    expect(state?.collisionNotices?.map((group) => group.name)).toEqual(["Nick", "Ken"]);
  });
});
