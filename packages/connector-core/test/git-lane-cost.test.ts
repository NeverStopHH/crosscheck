/**
 * The git lane's health verdict compares LIKE WITH LIKE (regression-guard
 * Stage 1, observability half).
 *
 * `skipped` counts Stop TURNS the lane did not run; `recorded` counts FILES
 * the lane found that no Edit tool reported. The first shipped WARN compared
 * the two directly, so on a healthy install — every edit through the Edit
 * tool, no codemods anywhere — `recorded` was structurally 0 and any three
 * lifetime skips among live sessions re-fired the WARN forever. Measured
 * verdicts against that code: {recorded 0, skipped 3} WARN, {recorded 0,
 * skipped 4} WARN, {recorded 2, skipped 3} WARN, and the remedy it named
 * (CROSSCHECK_TIMEOUT_MS) could never clear it. Doctor cried wolf on the
 * exact install the lane is fine on.
 *
 * So the lane counts the turns it RAN, and the verdict is skipped turns
 * against ran turns. The starved shape — the one the WARN exists for — is
 * still a WARN, and a lane that ran two hundred times and skipped three is a
 * PASS.
 */
import { describe, expect, test } from "bun:test";

import {
  formatGitLaneCost,
  gitLaneWarning,
  summarizeGitLaneCost,
} from "../src/state/git-lane-cost.ts";
import type { GitLaneCost } from "../src/state/git-lane-cost.ts";
import { deriveSessionState, withGitTouches } from "../src/state/session-state.ts";

const cost = (overrides: Partial<GitLaneCost>): GitLaneCost => ({
  sessions: 1,
  recorded: 0,
  skipped: 0,
  ran: 0,
  ...overrides,
});

describe("the git lane's WARN compares turns with turns", () => {
  test("a healthy install that runs no codemods is not a WARN", () => {
    // Arrange: one session, two hundred Stop turns on which the lane ran and
    // found nothing (every edit came through the Edit tool), three turns on
    // which the hook was already past its spare budget.
    const healthy = cost({ recorded: 0, skipped: 3, ran: 200 });

    // Act
    const warning = gitLaneWarning(healthy);

    // Assert
    expect(warning).toBeNull();
  });

  test("a codemod session with a few slow turns is not a WARN either", () => {
    // Arrange: the lane recorded two files and ran on twenty turns; three
    // were skipped. Compared file-to-turn this WARNed; turn-to-turn it is a
    // lane doing its job.
    const warning = gitLaneWarning(cost({ recorded: 2, skipped: 3, ran: 20 }));

    // Assert
    expect(warning).toBeNull();
  });

  test("a lane skipped more often than it ran is still the WARN it was", () => {
    // Arrange: the starved machine — the shape the WARN exists for.
    const warning = gitLaneWarning(cost({ recorded: 1, skipped: 9, ran: 1 }));

    // Assert: the level AND the unit the sentence compares.
    expect(warning).not.toBeNull();
    expect(warning).toContain("skipped more often than it runs");
  });

  test("a lane that never ran at all is a WARN", () => {
    // Arrange
    const warning = gitLaneWarning(cost({ recorded: 0, skipped: 40, ran: 0 }));

    // Assert
    expect(warning).not.toBeNull();
  });

  test("below the skip floor there is nothing to say, whatever ran", () => {
    // Arrange: two slow turns on a busy afternoon is the design working.
    expect(gitLaneWarning(cost({ recorded: 0, skipped: 2, ran: 0 }))).toBeNull();
  });

  test("the printed line carries all three counts", () => {
    // Arrange
    const line = formatGitLaneCost(cost({ recorded: 2, skipped: 1, ran: 7 }));

    // Assert: a reader deciding how far to trust suspect needs the turns the
    // lane ran beside the turns it skipped, not only the files it found.
    expect(line).toContain("2 file(s) no Edit tool reported");
    expect(line).toContain("7 turn(s) ran");
    expect(line).toContain("1 turn(s) skipped");
  });
});

describe("the session state books the turns the lane ran", () => {
  const state = deriveSessionState({
    hostSessionKey: "host",
    repoId: "github.com/acme/api",
    repoRoot: "/tmp/acme",
    hubUrl: "http://127.0.0.1:1",
    developerId: "dev_self",
    startedAt: "2026-08-25T11:00:00.000Z",
  });

  test("a turn the lane ran and found nothing on is a ran turn, not a silence", () => {
    // Act
    const next = withGitTouches(state, { captured: [], skipped: false });

    // Assert
    expect(next.gitLaneRan).toBe(1);
    expect(next.gitLaneSkipped).toBe(0);
    expect(next.gitTouchCount).toBe(0);
  });

  test("a skipped turn moves the skip counter and never the ran counter", () => {
    // Act
    const next = withGitTouches(state, { captured: [], skipped: true });

    // Assert
    expect(next.gitLaneRan).toBe(0);
    expect(next.gitLaneSkipped).toBe(1);
  });

  test("the summary sums ran turns across sessions like the other two", () => {
    // Arrange
    const first = withGitTouches(state, { captured: ["a.ts"], skipped: false });
    const second = withGitTouches(state, { captured: [], skipped: true });

    // Act
    const summary = summarizeGitLaneCost([first, second]);

    // Assert
    expect(summary).toEqual({ sessions: 2, recorded: 1, skipped: 1, ran: 1 });
  });
});
