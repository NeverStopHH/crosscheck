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
  yourWork: { followed: 0 },
});

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
