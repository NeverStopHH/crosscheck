/**
 * REPEAT EDITS OF A COLLISION FILE COST NOTHING FOR A WHILE (review of
 * feat/collision-visible, round 2, L1). Every edit of a file a teammate was
 * on asked the tripwire hub again and rewrote the session state — probe r2 D:
 * five more edits of an already-asked file, five hub calls — for an answer
 * that could only repeat itself. Once an answer is fully dealt with (every
 * teammate on the file asked about, every group told), the file rests for
 * TRIPWIRE_RECHECK_TTL_MS: no hub call, no write. After the window the hub is
 * asked again, because a teammate who STARTS on the file is new on it.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { runHook } from "../src/index.ts";
import { handlePreToolUse } from "../src/hooks/pre-tool-use.ts";
import { prepareHook } from "../src/hooks/runner.ts";
import { sessionStatePath } from "@crosscheck/connector-core/config/paths.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { activeTeammateSession } from "../../connector-core/test/fixtures/hint-hub.ts";
import {
  OVERLAP_FILE,
  SESSION_ID,
  cleanupCollisionFixtures,
  collisionFixture,
  editPayload,
  kenSession,
  parsed,
  pastRecheckWindow,
} from "./fixtures/collision-fixture.ts";

afterEach(cleanupCollisionFixtures);

const REPEATS = 5;

const stateText = async (home: string): Promise<string> => Bun.file(sessionStatePath(home, SESSION_ID)).text();

describe("an edit of a file whose live answer was fully dealt with (round 2, L1)", () => {
  test("five more edits inside the window make no hub call and write nothing", async () => {
    // Arrange: Nick asked about and told on the first edit
    const fix = await collisionFixture("tt-repeat");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE), fix.env);
    const calls = fix.hub.calls.tripwire;
    const before = await stateText(fix.home);

    // Act
    const outputs = [];
    for (let edit = 0; edit < REPEATS; edit += 1) {
      outputs.push(await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE), fix.env));
    }

    // Assert
    expect(outputs).toEqual(Array.from({ length: REPEATS }, () => ""));
    expect(fix.hub.calls.tripwire).toBe(calls);
    expect(await stateText(fix.home)).toBe(before);
  });

  test("after the window the hub is asked again, and a teammate new on the file is told", async () => {
    // Arrange
    const fix = await collisionFixture("tt-after");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE), fix.env);
    fix.hub.setTripwireSessions([activeTeammateSession(), kenSession()]);
    await pastRecheckWindow(fix.home);
    const calls = fix.hub.calls.tripwire;

    // Act
    const later = parsed(await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE), fix.env));

    // Assert
    expect(fix.hub.calls.tripwire).toBe(calls + 1);
    expect(later.systemMessage).toContain("Ken is working on refresh.ts");
  });

  test("after the window, the same answer tells nobody and rests the file again", async () => {
    // Arrange
    const fix = await collisionFixture("tt-same");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE), fix.env);
    await pastRecheckWindow(fix.home);
    const calls = fix.hub.calls.tripwire;

    // Act
    const again = await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE), fix.env);
    const rested = await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE), fix.env);

    // Assert: one hub call for the two edits
    expect(again).toBe("");
    expect(rested).toBe("");
    expect(fix.hub.calls.tripwire).toBe(calls + 1);
  });

  test("an answer with a teammate still not asked about does not rest the file", async () => {
    // Arrange: Nick and Ken; the first edit asks about Nick and tells both
    const fix = await collisionFixture("tt-unasked");
    fix.hub.setTripwireSessions([activeTeammateSession(), kenSession()]);
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE), fix.env);
    const rested = (await readSessionState(fix.home, SESSION_ID))?.tripwireCheckedFiles ?? [];

    // Act: the next edit must still reach the hub, to ask about Ken
    const second = parsed(await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE), fix.env));

    // Assert
    expect(rested).toEqual([]);
    expect(second.hookSpecificOutput?.permissionDecisionReason).toContain("Ken has an active session");
  });

  test("a tell the spare could not pay for does not rest the file", async () => {
    // Arrange
    const fix = await collisionFixture("tt-spent");
    const ctx = await prepareHook(editPayload(fix.repo, OVERLAP_FILE), fix.env);

    // Act
    if (ctx !== null) {
      await handlePreToolUse(ctx, { spareMs: () => 0 });
    }

    // Assert
    expect(ctx).not.toBeNull();
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.tripwireCheckedFiles ?? []).toEqual([]);
  });
});
