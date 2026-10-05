/**
 * `crosscheck pilot --mine`'s header says where counting starts (07 §13.9).
 *
 * The view starts at the later of the window and the instant outcomes became
 * recordable on the repo. A header that still said "last 56 days" over a view
 * that began this morning would describe a window nothing was counted in.
 */
import { describe, expect, test } from "bun:test";

import type { MyHintOutcomes } from "@crosscheck/connector-core/http/hint-outcomes.ts";

import { renderMyOutcomes } from "../src/cli/pilot-mine-render.ts";

const UNTIL = "2026-10-05T12:00:00.000Z";
const JULY = { periodStartIso: "2026-07-01T00:00:00.000Z", periodEndIso: "2026-08-01T00:00:00.000Z" };

const viewSince = (sinceIso: string): MyHintOutcomes => ({
  repo: "github.com/acme/api",
  days: 56,
  sinceIso,
  untilIso: UNTIL,
  received: 0,
  followed: 0,
  overrode: 0,
  notRelevantNow: 0,
  noise: 0,
  unmarked: 0,
  bySource: [],
  bySourceBeyondList: 0,
  reasons: [],
  reasonsBeyondList: 0,
  yourWork: { ...JULY, followed: null, withheld: "no_interventions" },
});

const creditLine = (yourWork: MyHintOutcomes["yourWork"]): string | undefined =>
  renderMyOutcomes({ ...viewSince("2026-08-10T12:00:00.000Z"), yourWork })
    .split("\n")
    .find((line) => line.startsWith("your own work"));

describe("renderMyOutcomes' header", () => {
  test("a view that spans its whole window names the window", () => {
    // Act
    const header = renderMyOutcomes(viewSince("2026-08-10T12:00:00.000Z")).split("\n")[0];

    // Assert
    expect(header).toBe("your hint outcomes on github.com/acme/api · last 56 days (2026-08-10..2026-10-05)");
  });

  test("a view clipped to when outcomes became recordable says so, never 'last 56 days'", () => {
    // Act
    const header = renderMyOutcomes(viewSince("2026-10-05T09:00:00.000Z")).split("\n")[0];

    // Assert
    expect(header).toBe(
      "your hint outcomes on github.com/acme/api · since 2026-10-05, when outcomes became recordable here (..2026-10-05)",
    );
  });
});

describe("renderMyOutcomes' source credit (review #10)", () => {
  test("a count names its closed month and the minimum it passed", () => {
    // Act
    const line = creditLine({ ...JULY, followed: 4, withheld: null });

    // Assert
    expect(line).toBe(
      "your own work, in teammates' hints, July 2026: followed 4 times — counted once at least 3 people recorded outcomes about it",
    );
  });

  test("below the minimum there is no number, and the line says why", () => {
    // Act
    const line = creditLine({ ...JULY, followed: null, withheld: "too_few_recorders" });

    // Assert
    expect(line).toBe(
      "your own work, in teammates' hints, July 2026: no count — fewer than 3 people recorded an outcome about it, and a count could single someone out",
    );
  });

  test("a month nothing pointed at the work says so, never 'followed 0 times'", () => {
    // Act
    const line = creditLine({ ...JULY, followed: null, withheld: "no_interventions" });

    // Assert
    expect(line).toBe("your own work, in teammates' hints, July 2026: no hint pointed at it");
  });

  test("a month that ended before outcomes were recordable says so", () => {
    // Act
    const line = creditLine({
      periodStartIso: "2026-06-01T00:00:00.000Z",
      periodEndIso: "2026-07-01T00:00:00.000Z",
      followed: null,
      withheld: "not_recordable",
    });

    // Assert
    expect(line).toBe(
      "your own work, in teammates' hints, June 2026: nothing to count — outcomes became recordable here after it ended",
    );
  });

  test("the footer's promise names both shared totals and their minimums", () => {
    // Act
    const out = renderMyOutcomes(viewSince("2026-08-10T12:00:00.000Z"));

    // Assert
    expect(out).toContain(
      "only you see this view in full; others see your words only inside totals for a whole past month — the team report's, once at least 3 people recorded outcomes about at least 3 people's work, and a teammate's count of how often their work was followed, once at least 3 people recorded outcomes about it",
    );
  });
});
