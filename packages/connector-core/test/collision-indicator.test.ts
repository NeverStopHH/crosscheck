/**
 * THE STATUSLINE'S OVERLAP INDICATOR, NAMED AND UNNAMED (review of
 * feat/collision-visible, round 2, M1). The indicator named only teammates
 * the presence answer listed and DROPPED the rest — so a briefing that told
 * the person "Mike … 3 files" while Mike was offline, which is the pilot's
 * case, left the statusline showing nothing right after. A teammate presence
 * does not confirm is now counted and never named. The hook-level half is
 * connector-claude/test/collision-statusline-unnamed.test.ts.
 */
import { describe, expect, test } from "bun:test";

import { COLLISION_INDICATOR_MAX_CHARS, STATUSLINE_NAME_CHARS } from "../src/constants.ts";
import { ghostCollisions, renderOverlapIndicator, tripwireCollision } from "../src/hints/collision-notice.ts";
import type { GhostCheckEntry, TripwireSession } from "../src/http/hub.ts";
import { INJECTION_CORPUS } from "./fixtures/injection-corpus.ts";

const tripwireRow = (overrides: Partial<TripwireSession> = {}): TripwireSession => ({
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

/** Mike's ghost row: three files shared, two of them in the sample. */
const mikeGhost = (): GhostCheckEntry => ({
  workContextId: "wc_mike",
  title: "Practice mapping grid",
  developerId: "dev_mike",
  developerName: "Mike",
  intent: null,
  lastActiveAt: "2026-10-05T11:00:00.000Z",
  sharedTargets: [
    { kind: "file", value: "apps/web/src/practice/PlayerMappingGrid.tsx" },
    { kind: "file", value: "apps/web/src/practice/MappingRow.tsx" },
  ],
  sharedTargetCount: 3,
  intentTokenHits: 0,
});

const listed = (...developerIds: readonly string[]): readonly { developerId: string; isSelf: boolean }[] =>
  developerIds.map((developerId) => ({ developerId, isSelf: false }));

const nick = tripwireCollision(tripwireRow(), "src/auth/refresh.ts");
const mike = ghostCollisions([mikeGhost()]);

describe("a teammate presence does not confirm is counted, never named (round 2, M1)", () => {
  test("Mike offline after the briefing told the person: one teammate, three files", () => {
    // Act
    const indicator = renderOverlapIndicator(mike, []);

    // Assert
    expect(indicator).toBe("⚠ overlap: 1 teammate · 3 files");
  });

  test("Nick present and Mike offline: Nick by name, Mike counted after him", () => {
    // Act
    const indicator = renderOverlapIndicator([nick, ...mike], listed("dev_nick"));

    // Assert
    expect(indicator).toBe("⚠ overlap: Nick · 1 file, +1 teammate · 3 files");
  });

  test("two unconfirmed teammates on the same file count it once", () => {
    // Arrange
    const ken = tripwireCollision(
      tripwireRow({ developerId: "dev_ken", developerName: "Ken", workContextId: "wc_ken" }),
      "src/auth/refresh.ts",
    );

    // Act
    const indicator = renderOverlapIndicator([nick, ken], []);

    // Assert
    expect(indicator).toBe("⚠ overlap: 2 teammates · 1 file");
  });

  test("a self row confirms nobody", () => {
    // Act
    const indicator = renderOverlapIndicator([nick], [{ developerId: "dev_nick", isSelf: true }]);

    // Assert
    expect(indicator).toBe("⚠ overlap: 1 teammate · 1 file");
  });

  test.each(INJECTION_CORPUS.map((entry) => [entry.id, entry.payload] as const))(
    "%s as the name of an unconfirmed teammate never reaches the line",
    (_id, payload) => {
      // Arrange
      const hostile = tripwireCollision(tripwireRow({ developerName: payload }), "src/auth/refresh.ts");

      // Act
      const indicator = renderOverlapIndicator([hostile], []);

      // Assert
      expect(indicator).toBe("⚠ overlap: 1 teammate · 1 file");
    },
  );
});

describe("each name keeps its own cap inside the segment's (reviewer mutation M7)", () => {
  test("a long name is cut at STATUSLINE_NAME_CHARS, so the next teammate still fits whole", () => {
    // Arrange: thirteen characters, one past the per-name cap
    const long = tripwireCollision(
      tripwireRow({ developerId: "dev_a", developerName: "Alexandrovich", workContextId: "wc_a" }),
      "src/auth/refresh.ts",
    );
    const ken = tripwireCollision(
      tripwireRow({ developerId: "dev_ken", developerName: "Ken", workContextId: "wc_ken" }),
      "src/auth/refresh.ts",
    );

    // Act
    const indicator = renderOverlapIndicator([long, ken], listed("dev_a", "dev_ken"));

    // Assert
    expect("Alexandrovich".length).toBe(STATUSLINE_NAME_CHARS + 1);
    expect(indicator).toBe("⚠ overlap: Alexandrovi… · 1 file, Ken · 1 file");
    expect(indicator.length).toBeLessThanOrEqual(COLLISION_INDICATOR_MAX_CHARS);
  });
});
