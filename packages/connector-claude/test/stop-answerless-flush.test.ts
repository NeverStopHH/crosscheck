/**
 * THE HOOKS NOBODY WAITS FOR WAIT OUT A SLOW HUB (release gate on
 * ubuntu-latest, 2026-10-13). Stop and SubagentStop are wired async and
 * answer nothing, yet their drain held every records request to the 400 ms a
 * waiting host needs: a hub that stored a resumed life's re-filing past that
 * bound was abandoned, and the files stayed off every teammate's tripwire.
 * Their flush — and the sweep a healed life is owed, which runs inside them —
 * now gives a request the room left in the hook's envelope (core
 * spool/flush.ts `isAnswerless`), and a budget without a reserve says so
 * (core config/hook-budget.ts).
 *
 * WHAT IS ASSERTED IS WORK, NOT WALL TIME: the hub answers 300 ms late under a
 * 100 ms request bound, so a flush held to the bound delivers nothing at any
 * load, and one given the room delivers everything.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { readSpoolLines, repoKey } from "@crosscheck/connector-core/index.ts";
import { updateSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { sweepIfLifeMoved } from "../src/hooks/git-lane.ts";
import { prepareHook } from "../src/hooks/runner.ts";
import type { HookBudget, HookContext } from "../src/hooks/runner.ts";
import { handleStop } from "../src/hooks/stop.ts";
import { handleSubagentStop } from "../src/hooks/subagent-stop.ts";
import { OVERLAP_FILE, REPO_ID, SESSION_ID, SUBAGENT, cleanupCollisionFixtures, collisionFixture, editPayload } from "./fixtures/collision-fixture.ts";
import type { CollisionFixture } from "./fixtures/collision-fixture.ts";

afterEach(cleanupCollisionFixtures);

/** The request bound the hook context carries. */
const REQUEST_BOUND_MS = "100";
/** How late the hub answers a records POST: past the bound, inside the room. */
const SLOW_RECORDS_MS = 300;
/** The room the hook's envelope leaves the drain. */
const ROOM_MS = 4000;

const ANSWERLESS: HookBudget = { spareMs: () => ROOM_MS, isAnswerless: true };
const WAITED_FOR: HookBudget = { spareMs: () => ROOM_MS };

const slowFixture = async (label: string): Promise<CollisionFixture> => {
  const fix = await collisionFixture(label, { requestTimeoutMs: REQUEST_BOUND_MS });
  fix.hub.latency.records = SLOW_RECORDS_MS;
  return fix;
};

const contextFor = async (fix: CollisionFixture, payload: Record<string, unknown>): Promise<HookContext> => {
  const ctx = await prepareHook(JSON.stringify({ session_id: SESSION_ID, cwd: fix.repo, ...payload }), fix.env);
  if (ctx === null) {
    throw new Error("the fixture did not resolve a reportable repo");
  }
  return ctx;
};

const pending = async (fix: CollisionFixture): Promise<number> =>
  (await readSpoolLines(fix.home, repoKey(fix.hub.url, REPO_ID))).length;

describe("Stop and SubagentStop give a records request the room left in their envelope", () => {
  test("a Stop whose lane filed the turn's files delivers them past the request bound", async () => {
    // Arrange: two dirty files the Stop's lane will file
    const fix = await slowFixture("af-stop");
    const ctx = await contextFor(fix, { hook_event_name: "Stop" });

    // Act
    await handleStop(ctx, ANSWERLESS);

    // Assert
    expect(await pending(fix)).toBe(0);
  });

  test("a SubagentStop delivers its lane's files past the request bound", async () => {
    // Arrange
    const fix = await slowFixture("af-subagent");
    const ctx = await contextFor(fix, { hook_event_name: "SubagentStop", ...SUBAGENT });

    // Act
    await handleSubagentStop(ctx, ANSWERLESS);

    // Assert
    expect(await pending(fix)).toBe(0);
  });

  test("the sweep a healed life is owed delivers what it filed past the request bound", async () => {
    // Arrange: the lane last swept under the life before a heal
    const fix = await slowFixture("af-heal");
    await updateSessionState(fix.home, SESSION_ID, (fresh) => ({
      ...fresh,
      gitLaneSweptLife: `${fresh.crosscheckSessionId}-before-the-heal`,
    }));
    const ctx = await prepareHook(editPayload(fix.repo, OVERLAP_FILE), fix.env);
    if (ctx === null) {
      throw new Error("the fixture did not resolve a reportable repo");
    }

    // Act
    const swept = await sweepIfLifeMoved(ctx, ANSWERLESS);

    // Assert
    expect(swept).toBe(true);
    expect(await pending(fix)).toBe(0);
  });

  test("a hook a host waits for keeps the bound: the same Stop leaves the files on disk for the next hook", async () => {
    // Arrange
    const fix = await slowFixture("af-control");
    const ctx = await contextFor(fix, { hook_event_name: "Stop" });

    // Act
    await handleStop(ctx, WAITED_FOR);

    // Assert
    expect(await pending(fix)).toBeGreaterThan(0);
  });
});
