/**
 * A RECORD SHOWN LATER, HELD TO PRESENCE AS IT IS NOW (review of
 * feat/collision-visible, round 2). The renderer's half of the relay's rules;
 * the hooks that apply them are pinned in
 * connector-claude/test/collision-relay-unconfirmed.test.ts.
 */
import { describe, expect, test } from "bun:test";

import { PRESENCE_TTL_MS } from "../src/constants.ts";
import { tripwireCollision, withoutStaleLocation } from "../src/hints/collision-notice.ts";
import type { TripwireSession } from "../src/http/hub.ts";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const FILE = "src/auth/refresh.ts";

const row = (overrides: Partial<TripwireSession> = {}): TripwireSession => ({
  sessionId: "cc_nick",
  developerId: "dev_nick",
  developerName: "Nick",
  branch: "feat/refresh-fix",
  status: "implementing",
  lastHeartbeatAt: "2026-10-07T11:59:30.000Z",
  workContextId: "wc_nick",
  workContextTitle: "t",
  workContextIntent: null,
  ...overrides,
});

describe("the 90 s rule counts only an age the clock can vouch for (round 2, L2)", () => {
  test("a last-active instant ahead of the clock loses branch and age", () => {
    // Arrange: a hub clock an hour fast
    const group = tripwireCollision(row({ lastHeartbeatAt: new Date(NOW.getTime() + 3_600_000).toISOString() }), FILE);

    // Act
    const shown = withoutStaleLocation(group, NOW);

    // Assert
    expect(shown.branch).toBeNull();
    expect(shown.lastActiveAt).toBeNull();
  });

  test("an instant exactly now is an age of zero and keeps both", () => {
    // Arrange
    const group = tripwireCollision(row({ lastHeartbeatAt: NOW.toISOString() }), FILE);

    // Act / Assert
    expect(withoutStaleLocation(group, NOW)).toBe(group);
  });

  test("an instant one TTL old still keeps both", () => {
    // Arrange
    const group = tripwireCollision(row({ lastHeartbeatAt: new Date(NOW.getTime() - PRESENCE_TTL_MS).toISOString() }), FILE);

    // Act / Assert
    expect(withoutStaleLocation(group, NOW)).toBe(group);
  });
});
