/**
 * WHAT THE COLLISION RECORD KEEPS WHEN IT GROWS (review of
 * feat/collision-visible, round 2): a told group merged with a newer row of
 * the same teammate context takes the newer row's withholding with it (R6),
 * and the 32-group cap never evicts a group still queued for the main thread
 * while a merely told one can go — the drain reads the queued group's facts
 * from this record, and a queue key without them was relayed as nothing
 * (L6). A queued group the cap must take anyway is counted.
 */
import { describe, expect, test } from "bun:test";

import { LOCATION_WITHHELD } from "@crosscheck/schema";

import { MAX_COLLISION_NOTICES } from "../src/constants.ts";
import { tripwireCollision } from "../src/hints/collision-notice.ts";
import type { TripwireSession } from "../src/http/hub.ts";
import {
  deriveSessionState,
  withCarriedCapture,
  withCollisionNotices,
  withDrainedCollisionRelays,
  withQueuedCollisionRelays,
} from "../src/state/session-state.ts";
import type { CollisionNotice, SessionState } from "../src/state/session-state.ts";

const row = (overrides: Partial<TripwireSession> = {}): TripwireSession => ({
  sessionId: "cc_mike",
  developerId: "dev_mike",
  developerName: "Mike",
  branch: "feat/streaming-practice-beta",
  status: "implementing",
  lastHeartbeatAt: "2026-10-07T11:57:00.000Z",
  workContextId: "wc_mike",
  workContextTitle: "t",
  workContextIntent: null,
  ...overrides,
});

const state = (): SessionState =>
  deriveSessionState({
    hostSessionKey: "eviction-session",
    repoId: "github.com/acme/api",
    repoRoot: "/tmp/repo",
    hubUrl: "http://hub.invalid",
    developerId: "dev_self",
    startedAt: "2026-10-07T10:00:00.000Z",
  });

describe("a told group merged with a newer row of the same work (reviewer mutation R6)", () => {
  test("a branch the newer row withheld is withheld on the group too, never kept from the older row", () => {
    // Arrange: told on feat/…, then the teammate turned presence off
    const told = withCollisionNotices(state(), [tripwireCollision(row(), "src/a.ts")]);

    // Act
    const merged = withCollisionNotices(told, [tripwireCollision(row({ branch: LOCATION_WITHHELD }), "src/b.ts")]);

    // Assert
    expect(merged.collisionNotices).toHaveLength(1);
    expect(merged.collisionNotices?.[0]?.branch).toBeNull();
    expect(merged.collisionNotices?.[0]?.files).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

/** Teammate `index`'s group, on a file of its own. */
const group = (index: number): CollisionNotice =>
  tripwireCollision(
    row({ developerId: `dev_${String(index)}`, developerName: `T${String(index)}`, workContextId: `wc_${String(index)}` }),
    `src/file${String(index)}.ts`,
  );

/** What a subagent's PreToolUse writes: queued first, then remembered (hooks/pre-tool-use.ts). */
const subagentTold = (from: SessionState, told: CollisionNotice): SessionState =>
  withCollisionNotices(withQueuedCollisionRelays(from, [told.key]), [told]);

const keysOf = (from: SessionState): readonly string[] => (from.collisionNotices ?? []).map((notice) => notice.key);

describe("the cap evicts merely told groups before queued ones (round 2, L6)", () => {
  test("a queued group outlives thirty-two newer groups told in place, and is still there to drain", () => {
    // Arrange: a subagent's hit, then 32 main-thread groups
    const queued = subagentTold(state(), group(0));

    // Act
    const crowded = Array.from({ length: MAX_COLLISION_NOTICES }, (_, index) => group(index + 1)).reduce(
      (next, told) => withCollisionNotices(next, [told]),
      queued,
    );

    // Assert
    expect(crowded.collisionNotices).toHaveLength(MAX_COLLISION_NOTICES);
    expect(keysOf(crowded)).toContain(group(0).key);
    expect(crowded.collisionRelayQueue).toEqual([group(0).key]);
    expect(crowded.collisionRelayDropped ?? 0).toBe(0);
  });

  test("the oldest merely told group is the one that goes", () => {
    // Arrange: told 1 … 31 in place, then a queued one, then one more told
    const told = Array.from({ length: MAX_COLLISION_NOTICES - 1 }, (_, index) => group(index + 1)).reduce(
      (next, notice) => withCollisionNotices(next, [notice]),
      state(),
    );
    const withQueued = subagentTold(told, group(0));

    // Act
    const next = withCollisionNotices(withQueued, [group(99)]);

    // Assert
    expect(keysOf(next)).not.toContain(group(1).key);
    expect(keysOf(next)).toContain(group(0).key);
    expect(keysOf(next)).toContain(group(99).key);
  });

  test("thirty-three queued groups: the oldest is let go and COUNTED, never silently lost", () => {
    // Act
    const full = Array.from({ length: MAX_COLLISION_NOTICES + 1 }, (_, index) => group(index)).reduce(
      (next, told) => subagentTold(next, told),
      state(),
    );

    // Assert: every key still queued has its facts, and the one let go is counted
    expect(full.collisionRelayQueue).toHaveLength(MAX_COLLISION_NOTICES);
    expect(full.collisionRelayQueue).not.toContain(group(0).key);
    expect((full.collisionRelayQueue ?? []).every((key) => keysOf(full).includes(key))).toBe(true);
    expect(full.collisionRelayDropped).toBe(1);
  });

  test("a queued group the notice cap is forced to take leaves the queue and is counted", () => {
    // Arrange: a record where every remembered group is queued (as an older writer could leave it)
    const groups = Array.from({ length: MAX_COLLISION_NOTICES }, (_, index) => group(index));
    const allQueued: SessionState = {
      ...state(),
      collisionNotices: groups,
      collisionRelayQueue: [...groups.map((notice) => notice.key), group(MAX_COLLISION_NOTICES).key],
    };

    // Act: one more queued group arrives
    const next = withCollisionNotices(allQueued, [group(MAX_COLLISION_NOTICES)]);

    // Assert
    expect(next.collisionNotices).toHaveLength(MAX_COLLISION_NOTICES);
    expect(keysOf(next)).not.toContain(group(0).key);
    expect(next.collisionRelayQueue).not.toContain(group(0).key);
    expect(next.collisionRelayDropped).toBe(1);
  });

  test("the count survives a compact and is spent by the drain", () => {
    // Arrange
    const dropped: SessionState = { ...subagentTold(state(), group(0)), collisionRelayDropped: 2 };

    // Act
    const refired = withCarriedCapture(state(), dropped);
    const drained = withDrainedCollisionRelays(dropped);

    // Assert
    expect(refired.collisionRelayDropped).toBe(2);
    expect(drained.collisionRelayDropped).toBe(0);
    expect(drained.collisionRelayQueue).toEqual([]);
  });
});
