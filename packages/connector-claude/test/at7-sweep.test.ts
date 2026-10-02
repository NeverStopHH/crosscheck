import { describe, expect, test } from "bun:test";

import {
  INITIAL_PROGRESS,
  recordVoidAttempt,
  remainingSlots,
  VOID_BUDGET,
} from "../bench/at7/sweep.ts";
import type { Slot } from "../bench/at7/manifest.ts";

/**
 * The sweep bookkeeping (A1.6 / H1): five void attempts are allowed, the sixth
 * aborts the measurement; a resumed sweep owes only the slots it has not yet
 * finished with a valid outcome.
 */
describe("recordVoidAttempt", () => {
  test("the cap of five void attempts does not abort; the sixth does", () => {
    // Act
    let progress = INITIAL_PROGRESS;
    for (let i = 0; i < VOID_BUDGET; i += 1) {
      progress = recordVoidAttempt(progress);
    }

    // Assert: five attempts are within budget
    expect(progress.voidAttempts).toBe(5);
    expect(progress.aborted).toBe(false);

    // Act: the sixth
    progress = recordVoidAttempt(progress);

    // Assert
    expect(progress.voidAttempts).toBe(6);
    expect(progress.aborted).toBe(true);
  });
});

describe("remainingSlots", () => {
  const order: readonly Slot[] = [
    { index: 0, arm: { kind: "control" } },
    { index: 1, arm: { kind: "treatment", payload: "P1" } },
    { index: 2, arm: { kind: "control" } },
  ];

  test("skips slots already completed, preserving order", () => {
    // Act
    const remaining = remainingSlots(order, [0, 2]);

    // Assert
    expect(remaining.map((slot) => slot.index)).toEqual([1]);
  });

  test("owes the whole order when nothing is completed", () => {
    // Act / Assert
    expect(remainingSlots(order, []).map((s) => s.index)).toEqual([0, 1, 2]);
  });
});
