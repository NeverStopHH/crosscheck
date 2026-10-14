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
 *
 * THE DRAIN'S WORK IS SPOOLED BEFORE THE HOOK RUNS, as the turn's earlier
 * hooks would have: the lane's git walk has 250 ms (GIT_TOUCHES_TIMEOUT_MS),
 * and a runner whose git missed it filed nothing — the answerless cases then
 * passed on an empty spool and the waited-for control failed on one (mutation
 * proof shard 3, ubuntu-latest, 2026-10-13; reproduced with every git call
 * 300 ms late). The seeded records make every case a statement about the
 * flush, whatever the lane adds.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { appendRecords, readSpoolLines, repoKey } from "@crosscheck/connector-core/index.ts";
import { readSessionState, updateSessionState } from "@crosscheck/connector-core/state/session-state.ts";
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

/** Targets the turn's edits spooled before the hook ran. */
const SEEDED_TARGETS = 3;

/** Spools SEEDED_TARGETS tool-edit targets under the session's life and returns their ids. */
const seedTurn = async (fix: CollisionFixture): Promise<readonly string[]> => {
  const state = await readSessionState(fix.home, SESSION_ID);
  if (state === null) {
    throw new Error("the fixture wrote no session state");
  }
  const ids = Array.from({ length: SEEDED_TARGETS }, (_, index) => `env_turn_${String(index)}`);
  const now = new Date();
  await appendRecords(
    fix.home,
    repoKey(fix.hub.url, REPO_ID),
    SESSION_ID,
    ids.map((id, index) => ({
      cx: "0.1",
      id,
      ts: now.toISOString(),
      producer: { developerId: state.developerId, agentKind: "claude-code", sessionId: state.crosscheckSessionId },
      kind: "target",
      body: { workContextId: state.workContextId, kind: "file", value: `src/turn-${String(index)}.ts`, source: "tool_edit" },
    })),
    now,
  );
  return ids;
};

const postedIds = (fix: CollisionFixture): readonly unknown[] => fix.hub.postedRecords.map((record) => record["id"]);

describe("Stop and SubagentStop give a records request the room left in their envelope", () => {
  test("a Stop delivers the turn's spooled files, and its lane's, past the request bound", async () => {
    // Arrange: the turn's edits on disk, and two dirty files the Stop's lane may file
    const fix = await slowFixture("af-stop");
    const ids = await seedTurn(fix);
    expect(await pending(fix)).toBe(SEEDED_TARGETS);
    const ctx = await contextFor(fix, { hook_event_name: "Stop" });

    // Act
    await handleStop(ctx, ANSWERLESS);

    // Assert
    expect(await pending(fix)).toBe(0);
    expect(postedIds(fix)).toEqual(expect.arrayContaining([...ids]));
  });

  test("a SubagentStop delivers the turn's spooled files, and its lane's, past the request bound", async () => {
    // Arrange
    const fix = await slowFixture("af-subagent");
    const ids = await seedTurn(fix);
    expect(await pending(fix)).toBe(SEEDED_TARGETS);
    const ctx = await contextFor(fix, { hook_event_name: "SubagentStop", ...SUBAGENT });

    // Act
    await handleSubagentStop(ctx, ANSWERLESS);

    // Assert
    expect(await pending(fix)).toBe(0);
    expect(postedIds(fix)).toEqual(expect.arrayContaining([...ids]));
  });

  test("the sweep a healed life is owed delivers the spool, what it filed included, past the request bound", async () => {
    // Arrange: the lane last swept under the life before a heal
    const fix = await slowFixture("af-heal");
    await updateSessionState(fix.home, SESSION_ID, (fresh) => ({
      ...fresh,
      gitLaneSweptLife: `${fresh.crosscheckSessionId}-before-the-heal`,
    }));
    const ids = await seedTurn(fix);
    expect(await pending(fix)).toBe(SEEDED_TARGETS);
    const ctx = await prepareHook(editPayload(fix.repo, OVERLAP_FILE), fix.env);
    if (ctx === null) {
      throw new Error("the fixture did not resolve a reportable repo");
    }

    // Act
    const swept = await sweepIfLifeMoved(ctx, ANSWERLESS);

    // Assert
    expect(swept).toBe(true);
    expect(await pending(fix)).toBe(0);
    expect(postedIds(fix)).toEqual(expect.arrayContaining([...ids]));
  });

  test("a hook a host waits for keeps the bound: the same Stop leaves the files on disk for the next hook", async () => {
    // Arrange
    const fix = await slowFixture("af-control");
    await seedTurn(fix);
    const ctx = await contextFor(fix, { hook_event_name: "Stop" });

    // Act
    await handleStop(ctx, WAITED_FOR);

    // Assert: the seeded files at least, whatever the lane added
    expect(await pending(fix)).toBeGreaterThanOrEqual(SEEDED_TARGETS);
  });
});
