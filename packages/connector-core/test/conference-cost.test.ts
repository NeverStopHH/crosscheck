/**
 * The two conference telemetry surfaces a human reads: the one sentence
 * `status` and `doctor` both print, and the REMEDY doctor attaches to it.
 *
 * The block's own cost module argues at length that folding the four outcomes
 * together is the expensive mistake — a quiet team reading as a broken runner,
 * a drifted prompt reading as a quiet team. These tests are about the place
 * that argument had not reached: the remedies, which were one string for two
 * different faults, and the one outcome that had no WARN path at all.
 */
import { describe, expect, test } from "bun:test";

import {
  EMPTY_CONFERENCE_COST,
  conferenceRemedies,
  formatConferenceCost,
} from "../src/state/conference-cost.ts";
import type { ConferenceCost } from "../src/state/conference-cost.ts";

const NOW = new Date("2026-08-27T12:00:00.000Z");
const TEN_MINUTES_AGO = new Date(NOW.getTime() - 600_000).toISOString();

const costWith = (overrides: Partial<ConferenceCost>): ConferenceCost => ({
  ...EMPTY_CONFERENCE_COST,
  runs: 1,
  lastRunAt: TEN_MINUTES_AGO,
  ...overrides,
});

describe("the conference doctor remedy", () => {
  test("a lost model call is not blamed on the answer format", () => {
    // Arrange: the binary was missing or the call timed out. Zero answers
    // were unreadable.
    const cost = costWith({ fails: 1, lastFailure: "claude exited 1" });

    // Act
    const remedies = conferenceRemedies(cost);

    // Assert: the operator is sent to the runner, not hunting a prompt drift
    // that never happened.
    expect(remedies.length).toBe(1);
    expect(remedies[0]).toContain("did not come back");
    expect(remedies.join(" ")).not.toContain("answer format");
  });

  test("an unreadable answer gets its own remedy, and both faults get both", () => {
    // Arrange
    const drifted = costWith({ unreadable: 1 });
    const both = costWith({ unreadable: 1, fails: 1, lastFailure: "boom" });

    // Act + Assert
    expect(conferenceRemedies(drifted).length).toBe(1);
    expect(conferenceRemedies(drifted)[0]).toContain("answer format");
    expect(conferenceRemedies(both).length).toBe(2);
    expect(conferenceRemedies(both)[0]).toContain("answer format");
    expect(conferenceRemedies(both)[1]).toContain("did not come back");
  });

  test("a feature that has never once reached the hub warns instead of passing", () => {
    // Arrange: every run this repo+hub ever made ended at the hub. That is
    // not a deployment blip, it is a feature that has never worked here —
    // and it used to print PASS forever (non-negotiable #4).
    const never = costWith({ runs: 4, noHubAnswer: 4 });

    // Act + Assert
    expect(conferenceRemedies(never).length).toBe(1);
    expect(conferenceRemedies(never)[0]).toContain("has ever reached this hub");

    // THE CONTRAST that keeps it self-clearing: one run that did reach the
    // hub, and the line goes quiet again — no decay, no counter to edit.
    expect(conferenceRemedies(costWith({ runs: 4, noHubAnswer: 3 }))).toEqual([]);
    expect(conferenceRemedies(EMPTY_CONFERENCE_COST)).toEqual([]);
  });
});

describe("the conference cost line", () => {
  test("it counts in sentences a person would say", () => {
    // Arrange
    const cost = costWith({ findings: 1, published: 1 });

    // Act
    const line = formatConferenceCost(cost, NOW);

    // Assert: "1 findings" and "0 nothing to synthesize" are not sentences in
    // any register, and this is the line status prints on every run.
    expect(line).toContain("1 run (last 10m ago)");
    expect(line).toContain("1 finding (");
    expect(line).not.toContain("1 findings");
    expect(line).not.toContain("nothing to synthesize");
    expect(line).toContain("had nothing to compare");
  });

  test("plural forms are used when there are several", () => {
    // Arrange + Act
    const line = formatConferenceCost(
      costWith({ runs: 5, findings: 2, nones: 2, skipped: 2 }),
      NOW,
    );

    // Assert
    expect(line).toContain("5 runs");
    expect(line).toContain("2 findings");
  });
});
