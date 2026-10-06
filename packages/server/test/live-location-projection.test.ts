/**
 * THE PROJECTION BY ITSELF (services/live-location.ts projectRow): withheld
 * by default for a hidden owner, judged by a field's VALUE, at any depth —
 * review round 4. The route-by-route guard (live-location-privacy.test.ts)
 * proves no route leaks today; this pins the rule that keeps a field added
 * tomorrow from leaking, whatever it is called.
 */
import { describe, expect, test } from "bun:test";
import { LOCATION_WITHHELD } from "@crosscheck/schema";

import { isInstantOrCommit, projectRow } from "../src/services/live-location.ts";
import type { HiddenLocations } from "../src/services/live-location.ts";

const ROBIN = "dev_robin";
const NICK = "dev_nick";
const HIDDEN: HiddenLocations = new Map([[ROBIN, ["feat/robin-relocates-to-zurich"]]]);
const INSTANT = "2026-07-24T09:20:34.000Z";

/** What a projected row is to a reader: its fields may now hold other types. */
type Projected = Readonly<Record<string, unknown>>;

describe("a hidden owner's row is withheld by value, not by name", () => {
  test("a field nobody named is withheld when it holds an instant, in every spelling", () => {
    // Arrange
    const row = {
      iso: INSTANT,
      pgText: "2026-07-24 09:20:34.123+00",
      minute: "2026-07-24T09:20",
      day: "2026-07-24",
      epochSeconds: 1_785_000_000,
      epochMs: 1_785_000_000_000,
      asDate: new Date(INSTANT),
      words: "rotation finished inside its window",
      count: 3,
    };

    // Act
    const seen: Projected = projectRow(HIDDEN, { developerId: ROBIN }, row);

    // Assert
    expect(seen).toEqual({
      iso: LOCATION_WITHHELD,
      pgText: LOCATION_WITHHELD,
      minute: LOCATION_WITHHELD,
      day: LOCATION_WITHHELD,
      epochSeconds: LOCATION_WITHHELD,
      epochMs: LOCATION_WITHHELD,
      asDate: null,
      words: "rotation finished inside its window",
      count: 3,
    });
  });

  test("a commit-like value is withheld whatever its field is called, and nothing shorter is", () => {
    const seen: Projected = projectRow(HIDDEN, { developerId: ROBIN }, {
      head: "beefbeefb1234567890abcdef1234567890abcd",
      shortHead: "beefbee",
      word: "deadline",
      id: "clm_robin",
      sixHex: "abcdef",
    });

    expect(seen).toEqual({
      head: LOCATION_WITHHELD,
      shortHead: LOCATION_WITHHELD,
      word: "deadline",
      id: "clm_robin",
      sixHex: "abcdef",
    });
  });

  test("nested objects are projected, and a list drops the members it withholds", () => {
    const seen: Projected = projectRow(HIDDEN, { developerId: ROBIN }, {
      intent: { summary: "rotate the key", capturedAt: INSTANT, seq: { epoch: "0b0c-uuid", n: 3 } },
      commits: ["beefbee", "not a sha"],
      rows: [{ at: INSTANT, path: "src/auth/cache.ts" }],
    });

    expect(seen).toEqual({
      intent: { summary: "rotate the key", seq: { epoch: "0b0c-uuid", n: 3 } },
      commits: ["not a sha"],
      rows: [{ at: LOCATION_WITHHELD, path: "src/auth/cache.ts" }],
    });
  });

  test("the allowlist is the ROW KIND's: a claim's createdAt is shown, a target's is not", () => {
    const claim: Projected = projectRow(HIDDEN, { developerId: ROBIN, kind: "claim" }, { createdAt: INSTANT, lastSeenAt: INSTANT });
    const target: Projected = projectRow(HIDDEN, { developerId: ROBIN }, { createdAt: INSTANT }, { createdAt: "null" });

    expect(claim).toEqual({ createdAt: INSTANT, lastSeenAt: null });
    expect(target).toEqual({ createdAt: null });
  });

  test("her activity counter reads as the first observation", () => {
    const seen: Projected = projectRow(HIDDEN, { developerId: ROBIN, kind: "claim" }, { dedupCount: 7 });

    expect(seen).toEqual({ dedupCount: 1 });
  });

  test("landing is said to the day, in the type it came in", () => {
    const asText: Projected = projectRow(HIDDEN, { developerId: ROBIN }, { landedAt: INSTANT });
    const asDate: Projected = projectRow(HIDDEN, { developerId: ROBIN }, { landedAt: new Date(INSTANT) });

    expect(asText).toEqual({ landedAt: "2026-07-24T00:00:00.000Z" });
    expect(asDate.landedAt).toEqual(new Date("2026-07-24T00:00:00.000Z"));
  });

  test("a viewer who may see the owner gets the very same row", () => {
    const row = { lastSeenAt: INSTANT, dedupCount: 7 };

    expect(projectRow(HIDDEN, { developerId: NICK }, row)).toBe(row);
  });
});

describe("what counts as an instant or a commit", () => {
  test.each([
    [INSTANT, true],
    ["2026-07-24 09:20:34+00", true],
    ["1785000000", true],
    [1_785_000_000, true],
    [999_999_999, false],
    ["0123abc", true],
    ["0123ab", false],
    ["sha256:0123abcdef", false],
    ["feat/robin-relocates-to-zurich", false],
  ] as const)("%p → %p", (value, expected) => {
    expect(isInstantOrCommit(value)).toBe(expected);
  });
});
