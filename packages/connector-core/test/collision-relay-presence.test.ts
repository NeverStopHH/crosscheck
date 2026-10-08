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
import type { PresenceFact } from "../src/hints/collision-notice.ts";
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

/** One row of a fresh presence answer, on the branch Nick's session is on now. */
const presence = (developerId: string, overrides: Partial<PresenceFact> = {}): PresenceFact => ({
  developerId,
  isSelf: false,
  branch: "feat/refresh-fix",
  lastHeartbeatAt: "2026-10-07T11:59:50.000Z",
  ...overrides,
});

const nick = (overrides: Partial<TripwireSession> = {}): ReturnType<typeof tripwireCollision> =>
  tripwireCollision(row(overrides), FILE);

describe("a relayed group is unnamed only when a presence answer omits the teammate (round 2, H1 as refined)", () => {
  test("a teammate the fresh answer lists is named, with branch and age", () => {
    // Act
    const [relayed] = relayedCollisions([nick()], [presence("dev_nick")], NOW);

    // Assert
    expect(renderCollisionNotice(relayed ?? nick(), NOW)).toBe(
      "crosscheck: Nick is working on refresh.ts on branch feat/refresh-fix (last active just now) — talk before you both change it",
    );
  });

  test("a teammate the answer does not list is told unnamed: the file stays, who and where go", () => {
    // Act
    const relayed = relayedCollisions([nick()], [presence("dev_ken")], NOW);

    // Assert
    expect(relayed).toHaveLength(1);
    expect(relayed[0]?.name).toBe("");
    expect(relayed[0]?.branch).toBeNull();
    expect(relayed[0]?.lastActiveAt).toBeNull();
    expect(renderCollisionNotice(relayed[0] ?? nick(), NOW)).toBe(
      "crosscheck: A teammate recently worked on refresh.ts — talk to your team before you change it",
    );
  });

  test("an answer that lists nobody tells every group unnamed, never none", () => {
    // Act
    const relayed = relayedCollisions([nick(), nick({ developerId: "dev_ken", workContextId: "wc_ken" })], [], NOW);

    // Assert
    expect(relayed.map((group) => group.anonymous)).toEqual([true, true]);
  });

  test("NO answer at all (null) names each group as its tripwire row did — there is no contrary evidence", () => {
    // Act
    const [relayed] = relayedCollisions([nick()], null, NOW);

    // Assert
    expect(relayed?.anonymous).toBeUndefined();
    expect(renderCollisionNotice(relayed ?? nick(), NOW)).toBe(
      "crosscheck: Nick is working on refresh.ts on branch feat/refresh-fix (last active just now) — talk before you both change it",
    );
  });

  test("with no answer, a hit older than the presence TTL keeps its name and loses branch and age", () => {
    // Act
    const [relayed] = relayedCollisions(
      [nick({ lastHeartbeatAt: new Date(NOW.getTime() - PRESENCE_TTL_MS - 1).toISOString() })],
      null,
      NOW,
    );

    // Assert
    expect(relayed?.name).toBe("Nick");
    expect(relayed?.branch).toBeNull();
    expect(relayed?.lastActiveAt).toBeNull();
  });

  test("a self row never confirms a teammate", () => {
    // Act
    const [relayed] = relayedCollisions([nick()], [presence("dev_nick", { isSelf: true })], NOW);

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

describe("a named relay says where the teammate is NOW (round 2, L3)", () => {
  /** A hit whose heartbeat is older than the TTL by the time the relay drains: a long subagent run. */
  const longRun = (): ReturnType<typeof tripwireCollision> =>
    nick({ lastHeartbeatAt: new Date(NOW.getTime() - PRESENCE_TTL_MS - 60_000).toISOString() });

  test("a subagent running past the presence TTL keeps the branch while presence still lists the teammate", () => {
    // Act
    const [relayed] = relayedCollisions([longRun()], [presence("dev_nick")], NOW);

    // Assert
    expect(relayed?.branch).toBe("feat/refresh-fix");
    expect(relayed?.lastActiveAt).toBe("2026-10-07T11:59:50.000Z");
  });

  test("the branch is the presence row's, not the one the hit recorded", () => {
    // Act
    const [relayed] = relayedCollisions([nick()], [presence("dev_nick", { branch: "feat/rotation-2" })], NOW);

    // Assert
    expect(renderCollisionNotice(relayed ?? nick(), NOW)).toBe(
      "crosscheck: Nick is working on refresh.ts on branch feat/rotation-2 (last active just now) — talk before you both change it",
    );
  });

  test("of several rows for one teammate, the freshest locates them", () => {
    // Act
    const [relayed] = relayedCollisions(
      [nick()],
      [
        presence("dev_nick", { branch: "feat/old-window", lastHeartbeatAt: "2026-10-07T11:59:00.000Z" }),
        presence("dev_nick", { branch: "feat/new-window", lastHeartbeatAt: "2026-10-07T11:59:55.000Z" }),
        presence("dev_nick", { branch: "feat/older-window", lastHeartbeatAt: "2026-10-07T11:58:40.000Z" }),
      ],
      NOW,
    );

    // Assert
    expect(relayed?.branch).toBe("feat/new-window");
  });

  test("a confirming row itself past the TTL keeps name and file only", () => {
    // Act
    const [relayed] = relayedCollisions(
      [nick()],
      [presence("dev_nick", { lastHeartbeatAt: new Date(NOW.getTime() - PRESENCE_TTL_MS - 1).toISOString() })],
      NOW,
    );

    // Assert
    expect(relayed?.name).toBe("Nick");
    expect(relayed?.branch).toBeNull();
    expect(relayed?.lastActiveAt).toBeNull();
  });

  test("landed work keeps the branch that merged", () => {
    // Act
    const [relayed] = relayedCollisions(
      [nick({ landedAt: "2026-10-06T09:00:00.000Z" })],
      [presence("dev_nick", { branch: "feat/next-thing" })],
      NOW,
    );

    // Assert
    expect(relayed?.branch).toBe("feat/refresh-fix");
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
