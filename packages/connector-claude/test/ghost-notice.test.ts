/**
 * A GHOST GROUP IS TOLD ONLY WHEN IT WAS RECORDED AS TOLD (review of
 * feat/collision-visible, round 2: reviewer mutation R10 told every shown
 * group when the briefing's write failed, and no test noticed). A group the
 * state never recorded as told would be told again by the next SessionStart
 * — the nag the once-per-session rule exists to stop — so a failed write
 * tells nobody.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { tellPersonOfGhosts } from "../src/hooks/ghost-notice.ts";
import { prepareHook } from "../src/hooks/runner.ts";
import { sessionStatePath } from "@crosscheck/connector-core/config/paths.ts";
import type { GhostCheckEntry } from "@crosscheck/connector-core/http/hub.ts";
import {
  MIKE_FILES,
  SESSION_ID,
  cleanupCollisionFixtures,
  collisionFixture,
  mikeGhostRow,
  sessionStartPayload,
} from "./fixtures/collision-fixture.ts";

afterEach(cleanupCollisionFixtures);

const mike = (): GhostCheckEntry => mikeGhostRow(MIKE_FILES, 3) as unknown as GhostCheckEntry;

describe("the briefing's ghost notice", () => {
  test("with the record written, the new group is the one to tell", async () => {
    // Arrange
    const fix = await collisionFixture("gn-written");
    const ctx = await prepareHook(sessionStartPayload(fix.repo, "startup"), fix.env);

    // Act
    const told = ctx === null ? [] : await tellPersonOfGhosts(ctx, [mike()]);

    // Assert
    expect(told.map((group) => group.name)).toEqual(["Mike"]);
  });

  test("a write that could not happen tells nobody (reviewer mutation R10)", async () => {
    // Arrange: the session's state file is gone, so nothing can be recorded
    const fix = await collisionFixture("gn-unwritten");
    const ctx = await prepareHook(sessionStartPayload(fix.repo, "startup"), fix.env);
    await rm(sessionStatePath(fix.home, SESSION_ID), { force: true });

    // Act
    const told = ctx === null ? ["no ctx"] : await tellPersonOfGhosts(ctx, [mike()]);

    // Assert
    expect(ctx).not.toBeNull();
    expect(told).toEqual([]);
  });
});
