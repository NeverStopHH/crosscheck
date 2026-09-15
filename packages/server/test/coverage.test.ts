/**
 * The coverage record's SHAPE (docs/1.0/03-coverage-integrity.md §3.1, §3.2).
 *
 * COV-2 and the data half of COV-5 live here. Both are about the same defect
 * in two directions: a rung that cannot be read must still be a ROW, and a
 * rung that cannot EXIST must not be readable as one that might.
 */
import { describe, expect, test } from "bun:test";

import {
  COVERAGE_SOURCES,
  readCoverage,
} from "../src/services/coverage.ts";
import { createTestDeveloper, createTestHarness } from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const REPO = "github.com/acme/api";

const seed = async (): Promise<{
  harness: TestHarness;
  viewerId: string;
}> => {
  const harness = await createTestHarness();
  const developer = await createTestDeveloper(harness, "Nick", "nick@example.com");
  return { harness, viewerId: developer.developerId };
};

describe("COV-2: five rows, in order, no scalar", () => {
  test("readCoverage emits exactly one record per source in COVERAGE_SOURCES order", async () => {
    // Arrange
    const { harness, viewerId } = await seed();

    // Act
    const record = await readCoverage(
      { db: harness.db, now: harness.clock.now },
      viewerId,
      REPO,
    );

    // Assert
    expect(record.sources.map((source) => source.source)).toEqual([
      ...COVERAGE_SOURCES,
    ]);
  });

  test("the record carries no aggregate — no overall, no count, no percentage", async () => {
    // Arrange
    const { harness, viewerId } = await seed();

    // Act
    const record = await readCoverage(
      { db: harness.db, now: harness.clock.now },
      viewerId,
      REPO,
    );

    // Assert: every own value is a string, or the five-row array itself.
    const scalars = Object.entries(record).filter(
      ([key]) => key !== "sources" && key !== "scope",
    );
    expect(scalars.every(([, value]) => typeof value === "string")).toBe(true);
    expect(Object.keys(record).sort()).toEqual([
      "computedAt",
      "repo",
      "scope",
      "sources",
    ]);
  });
});

describe("COV-5: three rungs refuse, by name", () => {
  test.each([
    ["ci", "no_emitter"],
    ["runtime", "out_of_scope_1_0"],
    ["human_edit", "no_platform_rung"],
  ] as const)(
    "%s is unavailable with reason %s — never unknown, never complete",
    async (source, reason) => {
      // Arrange
      const { harness, viewerId } = await seed();

      // Act
      const record = await readCoverage(
        { db: harness.db, now: harness.clock.now },
        viewerId,
        REPO,
      );
      const row = record.sources.find((entry) => entry.source === source);

      // Assert
      expect(row?.state).toBe("unavailable");
      expect(row?.reason).toBe(reason);
      expect(row?.gapSince).toBeNull();
    },
  );
});
