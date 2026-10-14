/**
 * WHAT ONE RUN OF A GUARD COSTS, READ FROM THE PROOF'S OWN CI LOGS
 * (scripts/mutation-guard-times.ts). The shards are dealt by these seconds
 * (scripts/mutation-shards.ts), so the parse is pinned on the exact lines
 * mutation-check.ts prints under GitHub's timestamps: an anchor's time runs
 * from its "· label" line to the line that says how it ended, and a guard's
 * first anchor also paid its unmutated run.
 */
import { describe, expect, test } from "bun:test";

import { guardRunsOf, guardSecondsOf, tableOf } from "../scripts/mutation-guard-times.ts";

const GUARD_A = "packages/server/test/hint-outcomes.test.ts";
const GUARD_B = "packages/schema/test/continuation.test.ts";

/** A shard log as GitHub serves it: every line under its timestamp. */
const SHARD_LOG = [
  "2026-10-13T21:24:57.0475394Z ##[group]Run bun run packages/connector-core/scripts/mutation-check.ts --shard 3/8",
  "2026-10-13T21:25:00.0000000Z · the first anchor of A",
  "2026-10-13T21:25:09.0000000Z   caught by packages/server/test/hint-outcomes.test.ts",
  "2026-10-13T21:25:09.0000100Z · the second anchor of A",
  "2026-10-13T21:25:12.0000100Z   caught by packages/server/test/hint-outcomes.test.ts",
  "2026-10-13T21:25:12.0000200Z · the anchor of B",
  "2026-10-13T21:25:12.5000200Z ##[error]NOT CAUGHT by packages/schema/test/continuation.test.ts — the because line",
  "2026-10-13T21:25:12.6000000Z ",
  "2026-10-13T21:25:12.6000100Z all 3 re-introduced defects were caught",
].join("\n");

describe("a guard's runs, read from one shard log", () => {
  test("each anchor runs from its label line to the line saying how it ended, summed per guard", () => {
    // Act
    const runs = guardRunsOf(SHARD_LOG);

    // Assert: A had two anchors, 9 s and 3 s; B one, 0.5 s
    expect(runs.get(GUARD_A)?.anchors).toBe(2);
    expect(runs.get(GUARD_A)?.seconds).toBeCloseTo(12, 3);
    expect(runs.get(GUARD_B)?.anchors).toBe(1);
    expect(runs.get(GUARD_B)?.seconds).toBeCloseTo(0.5, 3);
  });

  test("an anchor the log ends inside is left out rather than guessed", () => {
    // Arrange: the run was cancelled before the anchor said how it ended
    const cut = `${SHARD_LOG}\n2026-10-13T21:26:00.0000000Z · an anchor that never ended`;

    // Act
    const runs = guardRunsOf(cut);

    // Assert
    expect([...runs.values()].reduce((sum, run) => sum + run.anchors, 0)).toBe(3);
  });

  test("a guard that was already red ends the log, and the anchor it stopped is not timed", () => {
    // Arrange
    const aborted = [
      "2026-10-13T22:32:48.7845315Z · the Stop hook's drain keeps the request bound",
      "2026-10-13T22:32:50.0266968Z ##[error]packages/connector-claude/test/stop-answerless-flush.test.ts is already failing WITHOUT any mutation (exit 1).",
    ].join("\n");

    // Act / Assert
    expect(guardRunsOf(aborted).size).toBe(0);
  });

  test("a log without GitHub's timestamps is refused, so a local transcript never reads as zero seconds", () => {
    expect(() => guardRunsOf("· an anchor\n  caught by packages/a.test.ts\n")).toThrow();
  });
});

describe("seconds per run of a guard, over every log", () => {
  test("a guard's time is its unmutated run and one run per anchor", () => {
    // Act: A took 12 s for 2 anchors + 1 unmutated run
    const seconds = guardSecondsOf([SHARD_LOG]);

    // Assert
    expect(seconds.get(GUARD_A)).toBeCloseTo(4, 3);
    expect(seconds.get(GUARD_B)).toBeCloseTo(0.25, 3);
  });

  test("a guard two logs timed is the mean of their paces", () => {
    // Arrange: a second run where A took 24 s for its 2 anchors
    const slower = SHARD_LOG.replace("21:25:09.0000000Z   caught", "21:25:21.0000000Z   caught");

    // Act
    const seconds = guardSecondsOf([SHARD_LOG, slower]);

    // Assert: (12 / 3 + 24 / 3) / 2
    expect(seconds.get(GUARD_A)).toBeCloseTo(6, 3);
  });
});

describe("the table the shards are dealt by", () => {
  test("is sorted by file and rounded to hundredths, so a regeneration diffs line by line", () => {
    // Act
    const table = tableOf(new Map([[GUARD_A, 4.004], [GUARD_B, 0.25]]), "two test logs");

    // Assert
    expect(Object.keys(table.secondsPerRun)).toEqual([GUARD_B, GUARD_A]);
    expect(table.secondsPerRun[GUARD_A]).toBe(4);
    expect(table.source).toBe("two test logs");
  });

  test("a guard faster than a hundredth still costs one, never zero", () => {
    expect(tableOf(new Map([[GUARD_B, 0.001]]), "a log").secondsPerRun[GUARD_B]).toBe(0.01);
  });
});
