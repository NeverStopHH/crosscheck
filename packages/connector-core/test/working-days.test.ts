/**
 * "RECENT" MEANS WITHIN TWO WORKING DAYS, COUNTED IN THE READER'S TIMEZONE.
 *
 * A teammate's change that the reader's checkout already contains is only
 * worth a word while it is fresh (docs/1.0/landed-changes.md, decision 2):
 * landed at most two working days ago, Monday to Friday, on the reader's own
 * calendar. A weekend does not age a change, and the same instant can fall on
 * different days in Berlin and in UTC — so the count is taken on calendar
 * dates in the reader's zone, never as a fixed number of hours.
 *
 * 2026-09-24 is a Thursday.
 */
import { describe, expect, test } from "bun:test";

import { isRecentLanding, workingDaysSince } from "../src/landed-changes/working-days.ts";

const BERLIN = "Europe/Berlin";
const THURSDAY_NOON = new Date("2026-09-24T12:00:00Z");
const MONDAY_NOON = new Date("2026-09-28T12:00:00Z");

describe("workingDaysSince", () => {
  test("a change that landed today is zero working days old", () => {
    expect(workingDaysSince(new Date("2026-09-24T07:00:00Z"), THURSDAY_NOON, BERLIN)).toBe(0);
  });

  test("counts the working days after the landing day, up to and including today", () => {
    // Tuesday → Wednesday, Thursday
    expect(workingDaysSince(new Date("2026-09-22T09:00:00Z"), THURSDAY_NOON, BERLIN)).toBe(2);
    // Monday → Tuesday, Wednesday, Thursday
    expect(workingDaysSince(new Date("2026-09-21T09:00:00Z"), THURSDAY_NOON, BERLIN)).toBe(3);
  });

  test("a weekend does not age a change", () => {
    // Thursday → Friday, (Saturday, Sunday), Monday
    expect(workingDaysSince(new Date("2026-09-24T09:00:00Z"), MONDAY_NOON, BERLIN)).toBe(2);
    // Friday → (Saturday, Sunday), Monday
    expect(workingDaysSince(new Date("2026-09-25T09:00:00Z"), MONDAY_NOON, BERLIN)).toBe(1);
  });

  test("the calendar is the reader's: one instant, two different answers", () => {
    // 23:30 UTC on Tuesday is 01:30 on Wednesday in Berlin
    const landed = new Date("2026-09-22T23:30:00Z");
    const friday = new Date("2026-09-25T10:00:00Z");

    expect(workingDaysSince(landed, friday, BERLIN)).toBe(2);
    expect(workingDaysSince(landed, friday, "UTC")).toBe(3);
  });

  test("a landing time ahead of the reader's clock counts as now, not as a negative age", () => {
    expect(workingDaysSince(new Date("2026-09-26T09:00:00Z"), THURSDAY_NOON, BERLIN)).toBe(0);
  });
});

describe("isRecentLanding", () => {
  test("two working days is recent, three is not", () => {
    expect(isRecentLanding(new Date("2026-09-22T09:00:00Z"), THURSDAY_NOON, BERLIN)).toBe(true);
    expect(isRecentLanding(new Date("2026-09-21T09:00:00Z"), THURSDAY_NOON, BERLIN)).toBe(false);
  });

  test("an unknown timezone falls back to the machine's own, never throws", () => {
    expect(isRecentLanding(new Date("2026-09-24T07:00:00Z"), THURSDAY_NOON, "Not/AZone")).toBe(true);
  });
});
