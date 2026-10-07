/**
 * WHAT THE COLLISION RECORD KEEPS WHEN IT GROWS (review of
 * feat/collision-visible, round 2): a told group merged with a newer row of
 * the same teammate context takes the newer row's withholding with it.
 */
import { describe, expect, test } from "bun:test";

import { LOCATION_WITHHELD } from "@crosscheck/schema";

import { tripwireCollision } from "../src/hints/collision-notice.ts";
import type { TripwireSession } from "../src/http/hub.ts";
import { deriveSessionState, withCollisionNotices } from "../src/state/session-state.ts";
import type { SessionState } from "../src/state/session-state.ts";

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
