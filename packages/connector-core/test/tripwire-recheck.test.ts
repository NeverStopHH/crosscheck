/**
 * THE TRIPWIRE'S PER-FILE RE-CHECK WINDOW, AS STATE (review of
 * feat/collision-visible, round 2, L1). A file whose live answer was fully
 * dealt with rests for TRIPWIRE_RECHECK_TTL_MS; these pin the window's edges
 * and the record's bound. The hook's half is
 * connector-claude/test/collision-tripwire-ttl.test.ts.
 */
import { describe, expect, test } from "bun:test";

import { MAX_TRIPWIRE_ASKED_FILES, TRIPWIRE_RECHECK_TTL_MS } from "../src/constants.ts";
import { deriveSessionState, isTripwireFresh, withTripwireChecked } from "../src/state/session-state.ts";
import type { SessionState } from "../src/state/session-state.ts";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const FILE = "src/auth/refresh.ts";

const state = (): SessionState =>
  deriveSessionState({
    hostSessionKey: "recheck-session",
    repoId: "github.com/acme/api",
    repoRoot: "/tmp/repo",
    hubUrl: "http://hub.invalid",
    developerId: "dev_self",
    startedAt: NOW.toISOString(),
  });

const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

describe("a settled tripwire answer rests its file for the re-check window", () => {
  test("inside the window the file is fresh, at its edge it is not", () => {
    // Arrange
    const checked = withTripwireChecked(state(), FILE, NOW);

    // Act / Assert
    expect(isTripwireFresh(checked, FILE, at(TRIPWIRE_RECHECK_TTL_MS - 1))).toBe(true);
    expect(isTripwireFresh(checked, FILE, at(TRIPWIRE_RECHECK_TTL_MS))).toBe(false);
  });

  test("a stamp ahead of the clock rests nothing", () => {
    // Arrange: stamped by a clock an hour fast
    const checked = withTripwireChecked(state(), FILE, at(3_600_000));

    // Act / Assert
    expect(isTripwireFresh(checked, FILE, NOW)).toBe(false);
  });

  test("an unreadable stamp rests nothing, and another file is not rested by this one", () => {
    // Arrange
    const garbled: SessionState = { ...state(), tripwireCheckedFiles: [{ file: FILE, at: "not a date" }] };
    const checked = withTripwireChecked(state(), FILE, NOW);

    // Act / Assert
    expect(isTripwireFresh(garbled, FILE, NOW)).toBe(false);
    expect(isTripwireFresh(checked, "src/auth/rotate.ts", NOW)).toBe(false);
  });

  test("one stamp per file, the newest kept, and the record capped oldest out", () => {
    // Arrange
    const many = Array.from({ length: MAX_TRIPWIRE_ASKED_FILES + 3 }, (_, index) => `src/f${String(index)}.ts`).reduce(
      (next, file) => withTripwireChecked(next, file, NOW),
      state(),
    );

    // Act
    const restamped = withTripwireChecked(withTripwireChecked(state(), FILE, NOW), FILE, at(1_000));

    // Assert
    expect(many.tripwireCheckedFiles).toHaveLength(MAX_TRIPWIRE_ASKED_FILES);
    expect(many.tripwireCheckedFiles?.[0]?.file).toBe("src/f3.ts");
    expect(restamped.tripwireCheckedFiles).toEqual([{ file: FILE, at: at(1_000).toISOString() }]);
  });
});
