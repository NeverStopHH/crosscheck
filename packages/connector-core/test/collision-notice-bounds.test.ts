/**
 * THE PERSON'S LINES AND THEIR TAIL STAY INSIDE ONE BOUND (review of
 * feat/collision-visible, round 2). Reviewer mutation R7 dropped the room the
 * fitting keeps for the `+N more` line and every test stayed green: the
 * existing bound test used field lengths whose kept lines left the tail room
 * by accident. This one walks the field lengths through the window where five
 * lines fit and the tail does not, so no lucky length can hide a missing
 * reserve.
 */
import { describe, expect, test } from "bun:test";

import { COLLISION_NOTICE_MAX_CHARS, COLLISION_NOTICE_MAX_LINES } from "../src/constants.ts";
import { renderCollisionNotices, tripwireCollision } from "../src/hints/collision-notice.ts";
import { UNKNOWN_COVERAGE } from "../src/http/coverage.ts";
import type { CoverageRecord } from "../src/http/coverage.ts";
import type { TripwireSession } from "../src/http/hub.ts";

const NOW = new Date("2026-10-07T12:00:00.000Z");

/** The longest line shape there is: a partial record adds its clause. */
const PARTIAL: CoverageRecord = {
  ...UNKNOWN_COVERAGE,
  sources: [{ source: "git", state: "incomplete", reason: "evidence_stale", gapSince: null, observedAt: null }],
};

const NAME_LENGTHS = Array.from({ length: 40 }, (_, index) => index + 1);
const BRANCH_LENGTHS = Array.from({ length: 58 }, (_, index) => index + 1);

/** One past the line cap, so a tail is always owed. */
const groupsWith = (nameLength: number, branchLength: number): ReturnType<typeof tripwireCollision>[] =>
  Array.from({ length: COLLISION_NOTICE_MAX_LINES + 1 }, (_, index) => {
    const row: TripwireSession = {
      sessionId: `cc_${String(index)}`,
      developerId: `dev_${String(index)}`,
      developerName: "N".repeat(nameLength),
      branch: `b/${"x".repeat(branchLength)}`,
      status: "implementing",
      lastHeartbeatAt: "2026-10-07T11:57:00.000Z",
      workContextId: `wc_${String(index)}`,
      workContextTitle: "t",
      workContextIntent: null,
    };
    return tripwireCollision(row, `src/${"f".repeat(55)}.ts`, PARTIAL);
  });

describe("every field length keeps the person's lines and their tail inside the bound (reviewer mutation R7)", () => {
  test("names of 1–40 and branches of 1–58 characters, a tail always owed", () => {
    // Act
    const longest = Math.max(
      ...NAME_LENGTHS.flatMap((name) =>
        BRANCH_LENGTHS.map((branch) => renderCollisionNotices(groupsWith(name, branch), NOW).length),
      ),
    );

    // Assert
    expect(longest).toBeLessThanOrEqual(COLLISION_NOTICE_MAX_CHARS);
  });

  test("the walk really reaches the window where five lines fit and five plus the tail do not", () => {
    // Arrange: one line of each combination, measured the way the fitting adds them
    const lineLengths = NAME_LENGTHS.flatMap((name) =>
      BRANCH_LENGTHS.map((branch) => renderCollisionNotices(groupsWith(name, branch).slice(0, 1), NOW).length),
    );
    const tail = "crosscheck: +1 more teammate overlap not shown".length;

    // Act
    const inWindow = lineLengths.filter((line) => {
      const five = line * COLLISION_NOTICE_MAX_LINES + COLLISION_NOTICE_MAX_LINES - 1;
      return five <= COLLISION_NOTICE_MAX_CHARS && five + 1 + tail > COLLISION_NOTICE_MAX_CHARS;
    });

    // Assert: otherwise the bound above would hold by luck
    expect(inWindow.length).toBeGreaterThan(0);
  });
});
