import { describe, expect, test } from "bun:test";

import {
  CONTROL_RUNS,
  dryRunOrder,
  MANIFEST_SEED,
  MEASURED_TOTAL,
  measuredOrder,
  PAYLOAD_IDS,
  TREATMENT_RUNS_PER_PAYLOAD,
} from "../bench/at7/manifest.ts";
import type { Slot } from "../bench/at7/manifest.ts";

/**
 * The 40-slot order is drawn ONCE from a seeded shuffle and written before the
 * first run (§3, §9 step 4), so time-of-day or service drift cannot line up
 * with an arm. The seed is fixed, so the order is reproducible: the same seed
 * must give the same sequence, and the split must be exactly 20 control + 20
 * treatment, 4 per payload.
 */
const armLabel = (slot: Slot): string =>
  slot.arm.kind === "control" ? "control" : slot.arm.payload;

describe("measuredOrder", () => {
  test("is forty slots, indexed 0..39 without a gap", () => {
    // Act
    const order = measuredOrder();

    // Assert
    expect(order.length).toBe(MEASURED_TOTAL);
    expect(order.map((slot) => slot.index)).toEqual(
      Array.from({ length: MEASURED_TOTAL }, (_unused, i) => i),
    );
  });

  test("splits 20 control and 20 treatment, four runs per payload", () => {
    // Act
    const order = measuredOrder();
    const counts = order.reduce<Record<string, number>>((acc, slot) => {
      const label = armLabel(slot);
      return { ...acc, [label]: (acc[label] ?? 0) + 1 };
    }, {});

    // Assert
    expect(counts["control"]).toBe(CONTROL_RUNS);
    for (const payload of PAYLOAD_IDS) {
      expect(counts[payload]).toBe(TREATMENT_RUNS_PER_PAYLOAD);
    }
  });

  test("is deterministic: the same seed gives the same order", () => {
    // Act
    const first = measuredOrder(MANIFEST_SEED).map(armLabel);
    const second = measuredOrder(MANIFEST_SEED).map(armLabel);

    // Assert
    expect(second).toEqual(first);
  });

  test("a different seed gives a different order", () => {
    // Act
    const base = measuredOrder(MANIFEST_SEED).map(armLabel);
    const other = measuredOrder(MANIFEST_SEED + 1).map(armLabel);

    // Assert
    expect(other).not.toEqual(base);
  });

  test("is shuffled, not blocked — control is not the whole first half", () => {
    // Act
    const firstHalf = measuredOrder()
      .slice(0, MEASURED_TOTAL / 2)
      .map(armLabel);

    // Assert: a blocked order would make the first twenty all 'control'
    expect(firstHalf.some((label) => label !== "control")).toBe(true);
  });
});

describe("dryRunOrder", () => {
  test("is one control plus one run per payload — six, never counted", () => {
    // Act
    const order = dryRunOrder();
    const labels = order.map(armLabel);

    // Assert
    expect(order.length).toBe(PAYLOAD_IDS.length + 1);
    expect(labels.filter((label) => label === "control").length).toBe(1);
    for (const payload of PAYLOAD_IDS) {
      expect(labels).toContain(payload);
    }
  });

  test("indexes its slots 0..5 without a gap", () => {
    // Act
    const order = dryRunOrder();

    // Assert
    expect(order.map((slot) => slot.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
