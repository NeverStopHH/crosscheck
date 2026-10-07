/**
 * THE PROJECTION BY ITSELF (services/live-location.ts projectRow): withheld
 * by default for a hidden owner, judged by a field's VALUE, at any depth —
 * review round 4. The route-by-route guard (live-location-privacy.test.ts)
 * proves no route leaks today; this pins the rule that keeps a field added
 * tomorrow from leaking, whatever it is called.
 */
import { describe, expect, test } from "bun:test";
import { LOCATION_WITHHELD } from "@crosscheck/schema";

import { isWithheldShape, projectRow } from "../src/services/live-location.ts";
import type { HiddenLocations } from "../src/services/live-location.ts";

const ROBIN = "dev_robin";
const NICK = "dev_nick";
const HIDDEN: HiddenLocations = new Map([[ROBIN, ["feat/robin-relocates-to-zurich"]]]);
const INSTANT = "2026-07-24T09:20:34.000Z";

/** What a projected row is to a reader: its fields may now hold other types. */
type Projected = Readonly<Record<string, unknown>>;

describe("a hidden owner's row is withheld by value, not by name", () => {
  test("a field nobody named is withheld when it IS an instant, in every spelling", () => {
    // Arrange
    const row = {
      iso: INSTANT,
      pgText: "2026-07-24 09:20:34.123+00",
      minute: "2026-07-24T09:20",
      day: "2026-07-24",
      seenAtMs: 1_785_000_000_000,
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
      seenAtMs: LOCATION_WITHHELD,
      asDate: null,
      words: "rotation finished inside its window",
      count: 3,
    });
  });

  test("a commit or an epoch is withheld only where the field's type is a commit or an instant", () => {
    const seen: Projected = projectRow(HIDDEN, { developerId: ROBIN }, {
      headCommit: "beefbeefb1234567890abcdef1234567890abcd",
      sha: "beefbee",
      runId: "18273645501",
      buildNumber: 1_785_000_000,
      word: "deadline",
      id: "clm_robin",
    });

    expect(seen).toEqual({
      headCommit: LOCATION_WITHHELD,
      sha: LOCATION_WITHHELD,
      runId: "18273645501",
      buildNumber: 1_785_000_000,
      word: "deadline",
      id: "clm_robin",
    });
  });

  test("her words are never a shape: prose that opens with a time, or is a bare sha, stays (H1)", () => {
    const words = {
      body: "beefbee",
      description: "2026-10-06 14:30 deploy of v2.3.1 broke refresh",
      summary: "2026-10-08 09:00 cutover must not log anyone out",
      note: INSTANT,
      surface: "2026-07-24",
      check: "1785000000",
    };

    expect(projectRow(HIDDEN, { developerId: ROBIN }, words)).toEqual(words);
  });

  test("a claim's evidence and paths are references, never shapes, however they look (H2)", () => {
    const refs = {
      evidenceRefs: ["2026-10-06", "9f3c2a1b7d4e", "18273645501", "clm_robin_evidence"],
      affectedPaths: ["2026-10-06", "src/auth/refresh.ts"],
    };

    expect(projectRow(HIDDEN, { developerId: ROBIN, kind: "claim" }, refs)).toEqual(refs);
  });

  test("nested objects are projected, and a list drops the members it withholds", () => {
    const seen: Projected = projectRow(HIDDEN, { developerId: ROBIN }, {
      intent: { summary: "rotate the key", capturedAt: INSTANT, seq: { epoch: "0b0c-uuid", n: 3 } },
      headCommits: ["beefbee", "not a sha"],
      rows: [{ at: INSTANT, path: "src/auth/cache.ts" }],
    });

    expect(seen).toEqual({
      intent: { summary: "rotate the key", seq: { epoch: "0b0c-uuid", n: 3 } },
      headCommits: ["not a sha"],
      rows: [{ at: LOCATION_WITHHELD, path: "src/auth/cache.ts" }],
    });
  });

  test("the allowlist is the ROW KIND's: a claim's createdAt is shown, a target's is not", () => {
    const claim: Projected = projectRow(HIDDEN, { developerId: ROBIN, kind: "claim" }, { createdAt: INSTANT, lastSeenAt: INSTANT });
    const target: Projected = projectRow(HIDDEN, { developerId: ROBIN }, { createdAt: INSTANT }, { createdAt: "null" });

    expect(claim).toEqual({ createdAt: INSTANT, lastSeenAt: null });
    expect(target).toEqual({ createdAt: null });
  });

  test("the allowlist names PATHS: a createdAt nested in her claim is not the claim's (review round 5, L1)", () => {
    // Arrange: the reviewer's m1b — her session's start, nested in her claim
    // under the name the claim's own creation goes by.
    const row = {
      createdAt: INSTANT,
      authorSession: { createdAt: "2026-07-24T08:00:00.000Z" },
      validity: { refCommit: "c0ffee1", lastRevalidatedAt: INSTANT, touchingCommits: ["0123abc4567def"], observedAt: INSTANT },
    };

    // Act
    const claim: Projected = projectRow(HIDDEN, { developerId: ROBIN, kind: "claim" }, row);
    const validity: Projected = projectRow(HIDDEN, { developerId: ROBIN, kind: "claim_validity" }, row.validity);

    // Assert
    expect(claim).toEqual({
      createdAt: INSTANT,
      authorSession: { createdAt: LOCATION_WITHHELD },
      validity: { refCommit: "c0ffee1", lastRevalidatedAt: INSTANT, touchingCommits: ["0123abc4567def"], observedAt: null },
    });
    expect(validity).toEqual({ refCommit: "c0ffee1", lastRevalidatedAt: INSTANT, touchingCommits: ["0123abc4567def"], observedAt: null });
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

describe("what counts as an instant or a commit, in which field", () => {
  test.each([
    ["at", INSTANT, true],
    ["at", "2026-07-24 09:20:34+00", true],
    ["at", "2026-07-24T09:20:34Z and then some", false],
    ["at", "2026-13-45", false],
    ["checkedAt", "1785000000", true],
    ["checkedAt", 1_785_000_000, true],
    ["checkedAt", 999_999_999, false],
    ["refCommit", "0123abc", true],
    ["refCommit", "0123ab", false],
    ["label", "0123abc", false],
    ["label", 1_785_000_000, false],
    ["body", INSTANT, false],
    ["value", "sha256:0123abcdef", false],
    ["branchName", "feat/robin-relocates-to-zurich", false],
  ] as const)("%p holding %p → %p", (key, value, expected) => {
    expect(isWithheldShape(key, value)).toBe(expected);
  });
});
