/**
 * THE ASK STATES WHAT LANDED, WHERE, AND BY WHOM — AND HOW TO SEE IT.
 *
 * The PreToolUse ask is a stop, so its text has to carry the reason for the
 * stop (docs/1.0/landed-changes.md, decision 3): which commits, on which
 * landing branch, written by whom, and the one git command that shows them.
 * Commit subjects and author names are written by other people, so they are
 * framed as quoted data like every other teammate-written string; an author's
 * email is used for matching only and never printed.
 */
import { describe, expect, test } from "bun:test";

import { QUOTED_DATA_NOTICE } from "../src/briefing/render.ts";
import { renderEditWarning, renderTripwireReason } from "../src/hints/render.ts";
import type { LandedChanges, LandedCommit } from "../src/landed-changes/probe.ts";
import type { TripwireSession } from "../src/http/hub.ts";

const NOW = new Date("2026-09-24T12:00:00Z");
const FILE = "src/lines.ts";

const commit = (overrides: Partial<LandedCommit> = {}): LandedCommit => ({
  sha: "0dcfc4e41e1f309f8a6d3056726744bb8ddd6133",
  shortSha: "0dcfc4e",
  authorName: "Mike",
  authorEmail: "mike@example.com",
  subject: "Fix line offset",
  committedAt: new Date("2026-09-10T10:00:00Z"),
  branches: ["staging"],
  landedAt: null,
  ...overrides,
});

const LIVE: TripwireSession = {
  sessionId: "cc_11111111-2222-4333-8444-555555555555",
  developerId: "dev_mike",
  developerName: "Mike",
  branch: "mike/fix",
  status: "implementing",
  lastHeartbeatAt: "2026-09-24T11:59:00Z",
  workContextId: "wc_cc_11111111-2222-4333-8444-555555555555",
  workContextTitle: "Line offset",
  workContextIntent: null,
};

const missingOnly = (commits: readonly LandedCommit[], moreMissing = false): LandedChanges => ({
  missing: commits,
  recent: [],
  moreMissing,
  unchecked: [],
  key: null,
});

describe("a landed change the checkout is missing", () => {
  test("names the commit, its author, where it landed, and how to see it", () => {
    // Act
    const text = renderEditWarning({ live: null, landed: missingOnly([commit()]), file: FILE, now: NOW });

    // Assert
    expect(text).toContain("src/lines.ts has landed changes your checkout does not contain");
    expect(text).toContain("0dcfc4e «Fix line offset» by Mike, on staging");
    expect(text).toContain("To see them: git show 0dcfc4e");
    expect(text.endsWith(QUOTED_DATA_NOTICE)).toBe(true);
  });

  test("never prints the author's email", () => {
    const text = renderEditWarning({ live: null, landed: missingOnly([commit()]), file: FILE, now: NOW });

    expect(text).not.toContain("mike@example.com");
  });

  test("names at most three commits and counts the rest", () => {
    // Arrange
    const five = [1, 2, 3, 4, 5].map((n) =>
      commit({ sha: `${String(n)}`.repeat(40), shortSha: `${String(n)}`.repeat(7), subject: `Change ${String(n)}` }),
    );

    // Act
    const text = renderEditWarning({ live: null, landed: missingOnly(five), file: FILE, now: NOW });

    // Assert
    expect(text).toContain("«Change 3»");
    expect(text).not.toContain("«Change 4»");
    expect(text).toContain("(+2 more)");
    expect(text).toContain("To see them: git show 1111111 2222222 3333333");
  });

  test("says 'or more' when the probe did not read them all", () => {
    // Arrange
    const five = [1, 2, 3, 4, 5].map((n) =>
      commit({ sha: `${String(n)}`.repeat(40), shortSha: `${String(n)}`.repeat(7), subject: `Change ${String(n)}` }),
    );

    // Act
    const text = renderEditWarning({ live: null, landed: missingOnly(five, true), file: FILE, now: NOW });

    // Assert
    expect(text).toContain("(+2 or more)");
  });

  test("says there may be more even when every commit read fits on the stop", () => {
    // Arrange — the probe stopped reading, but after the reader's own commits
    // were filtered out only one teammate commit remained
    const text = renderEditWarning({ live: null, landed: missingOnly([commit()], true), file: FILE, now: NOW });

    // Assert
    expect(text).toContain("(and possibly more)");
  });

  test("names a landing branch it could not check", () => {
    // Arrange
    const landed: LandedChanges = { ...missingOnly([commit()]), unchecked: ["develop"] };

    // Act
    const text = renderEditWarning({ live: null, landed, file: FILE, now: NOW });

    // Assert
    expect(text).toContain("Not checked in time: develop; changes there may be missing too.");
  });

  test("a change on two landing branches says both", () => {
    const text = renderEditWarning({
      live: null,
      landed: missingOnly([commit({ branches: ["main", "staging"] })]),
      file: FILE,
      now: NOW,
    });

    expect(text).toContain("on main and staging");
  });
});

describe("a recent landed change the checkout already has", () => {
  test("says it is in the checkout, when it landed, and how to see it", () => {
    // Arrange
    const landed: LandedChanges = {
      missing: [],
      recent: [commit({ landedAt: new Date("2026-09-23T12:00:00Z") })],
      moreMissing: false,
      unchecked: [],
      key: null,
    };

    // Act
    const text = renderEditWarning({ live: null, landed, file: FILE, now: NOW });

    // Assert
    expect(text).toContain(
      "src/lines.ts changed on a landing branch in the last 2 working days; your checkout has it",
    );
    expect(text).toContain("0dcfc4e «Fix line offset» by Mike, landed on staging 24h ago");
    expect(text).toContain("To see what changed: git show 0dcfc4e");
  });
});

describe("the live tripwire's own text", () => {
  test("is unchanged when nothing landed", () => {
    expect(renderEditWarning({ live: LIVE, landed: null, file: FILE, now: NOW })).toBe(
      renderTripwireReason(LIVE, FILE, NOW),
    );
  });

  test("comes first when both apply, with one quoted-data notice at the end", () => {
    // Act
    const text = renderEditWarning({ live: LIVE, landed: missingOnly([commit()]), file: FILE, now: NOW });

    // Assert
    expect(text.indexOf("has an active session")).toBeLessThan(text.indexOf("has landed changes"));
    expect(text.split(QUOTED_DATA_NOTICE)).toHaveLength(2);
  });
});
