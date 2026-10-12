/**
 * A SWEEP OWED TO A HEALED LIFE IS PAID BY ONE HOOK (final review of batch 2,
 * N4). hooks/git-lane.ts sweepIfLifeMoved read `owesSweepToLife` outside any
 * claim, so under a subagent fan-out every PostToolUse with the room found
 * the sweep owed in the same second and each ran the whole lane — N × the
 * lane plus a flush, once per heal, on the hooks that are already the loaded
 * ones. The sweep is now CLAIMED inside the transform that reads the debt
 * ("sweeping since <iso>", honoured for one GIT_TOUCHES_TIMEOUT_MS), so one
 * hook pays and its siblings find the claim; a claim a cut hook left behind
 * expires with the lane's own deadline, and the next hook takes it.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { sweepIfLifeMoved } from "../src/hooks/git-lane.ts";
import { prepareHook } from "../src/hooks/runner.ts";
import type { HookBudget, HookContext } from "../src/hooks/runner.ts";
import { GIT_TOUCHES_TIMEOUT_MS } from "@crosscheck/connector-core/constants.ts";
import { owesSweepToLife, readSessionState, updateSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { OVERLAP_FILE, SESSION_ID, cleanupCollisionFixtures, collisionFixture, editPayload } from "./fixtures/collision-fixture.ts";
import type { CollisionFixture } from "./fixtures/collision-fixture.ts";

afterEach(cleanupCollisionFixtures);

const AMPLE: HookBudget = { spareMs: () => 60_000 };

/** A session whose life a heal moved: the lane last swept under the life before. */
const healedFixture = async (label: string): Promise<{ readonly fix: CollisionFixture; readonly ctx: HookContext }> => {
  const fix = await collisionFixture(label);
  await updateSessionState(fix.home, SESSION_ID, (fresh) => ({
    ...fresh,
    gitLaneSweptLife: `${fresh.crosscheckSessionId}-before-the-heal`,
  }));
  const ctx = await prepareHook(editPayload(fix.repo, OVERLAP_FILE), fix.env);
  if (ctx === null) {
    throw new Error("the fixture did not resolve a reportable repo");
  }
  return { fix, ctx };
};

const sweepingSince = async (fix: CollisionFixture, iso: string): Promise<void> => {
  await updateSessionState(fix.home, SESSION_ID, (fresh) => ({ ...fresh, gitLaneSweepingSince: iso }));
};

describe("a sweep owed to a healed life is paid by one hook (final review of batch 2, N4)", () => {
  test("two hooks with the room that find the sweep owed at once: one sweeps, the other finds the claim", async () => {
    // Arrange
    const { fix, ctx } = await healedFixture("sc-two");

    // Act
    const swept = await Promise.all([sweepIfLifeMoved(ctx, AMPLE), sweepIfLifeMoved(ctx, AMPLE)]);

    // Assert: one lane, and the debt is paid
    expect(swept.filter(Boolean)).toHaveLength(1);
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state === null ? null : owesSweepToLife(state)).toBe(false);
  });

  test("a fresh claim holds: a sibling that finds it pays nothing", async () => {
    // Arrange
    const { fix, ctx } = await healedFixture("sc-fresh");
    await sweepingSince(fix, new Date().toISOString());

    // Act / Assert
    expect(await sweepIfLifeMoved(ctx, AMPLE)).toBe(false);
  });

  test("a claim a cut hook left behind expires with the lane's deadline, and the next hook sweeps", async () => {
    // Arrange
    const { fix, ctx } = await healedFixture("sc-stale");
    await sweepingSince(fix, new Date(Date.now() - GIT_TOUCHES_TIMEOUT_MS - 1).toISOString());

    // Act / Assert
    expect(await sweepIfLifeMoved(ctx, AMPLE)).toBe(true);
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.gitLaneSweepingSince ?? null).toBeNull();
  });
});
