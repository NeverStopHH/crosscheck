/**
 * A RECORD SHOWN LATER, HELD TO PRESENCE AS IT IS NOW (review of
 * feat/collision-visible, round 2). The renderer's half of the relay's rules;
 * the hooks that apply them are pinned in
 * connector-claude/test/collision-relay-unconfirmed.test.ts.
 */
import { describe, expect, test } from "bun:test";

import { PRESENCE_TTL_MS } from "../src/constants.ts";
import {
  PARTIAL_RECORD_CLAUSE,
  anonymousCollision,
  relayedCollisions,
  renderCollisionNotice,
  tripwireCollision,
  withoutStaleLocation,
} from "../src/hints/collision-notice.ts";
import { UNKNOWN_COVERAGE } from "../src/http/coverage.ts";
import type { CoverageRecord } from "../src/http/coverage.ts";
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

describe("a relayed group is named only when live presence confirms the teammate (round 2, H1)", () => {
  const nick = (): ReturnType<typeof tripwireCollision> => tripwireCollision(row(), FILE);

  test("a teammate the fresh answer lists is named, with branch and age", () => {
    // Act
    const [relayed] = relayedCollisions([nick()], [{ developerId: "dev_nick", isSelf: false }], NOW);

    // Assert
    expect(renderCollisionNotice(relayed ?? nick(), NOW)).toBe(
      "crosscheck: Nick is working on refresh.ts on branch feat/refresh-fix (last active just now) — talk before you both change it",
    );
  });

  test("a teammate the answer does not list is told unnamed: the file stays, who and where go", () => {
    // Act
    const relayed = relayedCollisions([nick()], [{ developerId: "dev_ken", isSelf: false }], NOW);

    // Assert
    expect(relayed).toHaveLength(1);
    expect(relayed[0]?.name).toBe("");
    expect(relayed[0]?.branch).toBeNull();
    expect(relayed[0]?.lastActiveAt).toBeNull();
    expect(renderCollisionNotice(relayed[0] ?? nick(), NOW)).toBe(
      "crosscheck: A teammate recently worked on refresh.ts — talk to your team before you change it",
    );
  });

  test("no fresh answer at all tells every group unnamed, never none", () => {
    // Act
    const relayed = relayedCollisions([nick(), tripwireCollision(row({ developerId: "dev_ken", workContextId: "wc_ken" }), FILE)], [], NOW);

    // Assert
    expect(relayed.map((group) => group.anonymous)).toEqual([true, true]);
  });

  test("a self row never confirms a teammate", () => {
    // Act
    const [relayed] = relayedCollisions([nick()], [{ developerId: "dev_nick", isSelf: true }], NOW);

    // Assert
    expect(relayed?.anonymous).toBe(true);
  });

  test("an unnamed group of files keeps its count and its partial-record clause", () => {
    // Arrange: a told group of two files, from an answer whose record had a gap
    const partial: CoverageRecord = {
      ...UNKNOWN_COVERAGE,
      sources: [{ source: "git", state: "incomplete", reason: "evidence_stale", gapSince: null, observedAt: null }],
    };
    const group = { ...tripwireCollision(row(), FILE, partial), files: [FILE, "src/auth/rotate.ts"], fileCount: 2 };

    // Act
    const line = renderCollisionNotice(anonymousCollision(group), NOW);

    // Assert
    expect(line).toBe(
      "crosscheck: A teammate recently worked on 2 files you also touched, e.g. refresh.ts — " +
        `talk to your team before you change them${PARTIAL_RECORD_CLAUSE}`,
    );
  });
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
