/**
 * WHEN AN ANSWER IS WORTH STOPPING AN EDIT FOR.
 *
 * A stop spends the file's once-per-session marker, so it must not be spent
 * on the half that matters least while the half that matters most is still
 * unknown. Something MISSING is always worth a stop. Recent work alone is
 * worth one only when the missing half is COMPLETE — no landing branch left
 * unchecked, and no limit reached with nothing shown; otherwise the stop
 * waits and the next edit asks again.
 */
import { describe, expect, test } from "bun:test";

import { worthStopping } from "../src/landed-changes/probe.ts";
import type { LandedChanges, LandedCommit } from "../src/landed-changes/probe.ts";

const COMMIT: LandedCommit = {
  sha: "0dcfc4e41e1f309f8a6d3056726744bb8ddd6133",
  shortSha: "0dcfc4e",
  authorName: "Mike",
  authorEmail: "mike@example.com",
  subject: "Fix line offset",
  committedAt: new Date("2026-09-22T10:00:00Z"),
  branches: ["staging"],
  landedAt: new Date("2026-09-23T10:00:00Z"),
};

const answer = (overrides: Partial<LandedChanges>): LandedChanges => ({
  missing: [],
  recent: [],
  moreMissing: false,
  unchecked: [],
  cleanKey: null,
  ...overrides,
});

describe("worthStopping", () => {
  test("something missing is always worth a stop, even with a branch unchecked", () => {
    const landed = answer({ missing: [COMMIT], unchecked: ["develop"] });

    expect(worthStopping(landed)).toBe(landed);
  });

  test("recent work alone is worth a stop when the missing half is complete", () => {
    const landed = answer({ recent: [COMMIT] });

    expect(worthStopping(landed)).toBe(landed);
  });

  test("recent work alone waits while a landing branch is unchecked", () => {
    expect(worthStopping(answer({ recent: [COMMIT], unchecked: ["staging"] }))).toBeNull();
  });

  test("recent work alone waits while a limit was reached with nothing shown", () => {
    expect(worthStopping(answer({ recent: [COMMIT], moreMissing: true }))).toBeNull();
  });

  test("nothing, and unknown, are not worth a stop", () => {
    expect(worthStopping(answer({}))).toBeNull();
    expect(worthStopping(null)).toBeNull();
  });
});
