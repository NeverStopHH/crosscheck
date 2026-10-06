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
      "your own work, in teammates' hints, July 2026: followed 4 times — shown once, leaving out any one person, at least 3 people followed it",
    );
  });

  test("review M1: below the minimum there is no number, and one generic sentence says why", () => {
    // Act
    const line = creditLine({ ...JULY, followed: null, withheld: "below_minimums" });

    // Assert
    expect(line).toBe(
      "your own work, in teammates' hints, July 2026: no count — below the disclosure minimums: leaving out any one person, at least 3 people must have followed it",
    );
  });

  test("review M-3: a credit counted over an enrolment an upgrade reconstructed says so", () => {
    // Act
    const line = creditLine({ ...JULY, followed: 4, withheld: null, reconstructed: true });

    // Assert
    expect(line).toBe(
      "your own work, in teammates' hints, July 2026: followed 4 times — shown once, leaving out any one person, at least 3 people followed it; its enrolment reconstructed from recorded outcomes",
    );
  });

  test("review LOW: a credit whose month the pilot paused in says only its enrolled time was counted", () => {
    // Act
    const line = creditLine({ ...JULY, followed: 4, withheld: null, pausedInPeriod: true });

    // Assert
    expect(line).toBe(
      "your own work, in teammates' hints, July 2026: followed 4 times — shown once, leaving out any one person, at least 3 people followed it; counted only while the pilot was enrolled here",
    );
  });

  test("review M-1: a hub's count of 0 is never printed — the same generic sentence", () => {
    // Act
    const line = creditLine({ ...JULY, followed: 0, withheld: null });

    // Assert — "followed 0 times" is every recorder's verdict at once
    expect(line).toBe(
      "your own work, in teammates' hints, July 2026: no count — below the disclosure minimums: leaving out any one person, at least 3 people must have followed it",
    );
  });

  test("review M1: an older hub's specific word prints as the same generic sentence, never 'followed 0 times'", () => {
    // Act
    const empty = creditLine({ ...JULY, followed: null, withheld: "no_interventions" });
    const few = creditLine({ ...JULY, followed: null, withheld: "too_few_recorders" });

    // Assert
    expect([empty, few]).toEqual(["your own work, in teammates' hints, July 2026: no count — below the disclosure minimums: leaving out any one person, at least 3 people must have followed it", "your own work, in teammates' hints, July 2026: no count — below the disclosure minimums: leaving out any one person, at least 3 people must have followed it"]);
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
      "your own work, in teammates' hints, June 2026: nothing to count — the pilot was not enrolled here during it",
    );
  });

  test("the footer's promise names both shared totals, their viewer-independent minimums, and the team of three (H1)", () => {
    // Act
    const out = renderMyOutcomes(viewSince("2026-08-10T12:00:00.000Z"));

    // Assert
    expect(out).toContain(
      "only you see this view in full; others see your words only inside totals for a whole past month: the team report's, and a teammate's count of how often their work was followed\n" +
        "each is shown only if, leaving out any one person's words, words from at least 3 people remain — the team report's also about at least 3 people's work, 10 or more — so a team of three never gets either",
    );
  });
});

describe("renderMyOutcomes' window under a paused pilot (review M3)", () => {
  test("a window the pilot paused in says only its enrolled time was counted", () => {
    // Act
    const header = renderMyOutcomes({ ...viewSince("2026-08-10T12:00:00.000Z"), pausedInWindow: true }).split("\n")[0];

    // Assert
    expect(header).toBe(
      "your hint outcomes on github.com/acme/api · last 56 days (2026-08-10..2026-10-05) — counted only while the pilot was enrolled here",
    );
  });
});

describe("renderMyOutcomes' credit it cannot read (round 3)", () => {
  test("a credit this client cannot read is one line, and the person's own view still prints", () => {
    // Act
    const out = renderMyOutcomes({ ...viewSince("2026-08-10T12:00:00.000Z"), yourWork: { unreadable: true } });

    // Assert
    expect(out).toContain("your own work, in teammates' hints: this hub sent a count this client cannot read — nothing is shown from it");
    expect(out.split("\n")[0]).toStartWith("your hint outcomes on github.com/acme/api");
  });
});
