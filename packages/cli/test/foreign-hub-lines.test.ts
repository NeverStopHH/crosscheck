/**
 * The count phrase beside the live key-origin WARN (cli/foreign-hub.ts): a
 * ledger that is FULL and holds no line for this repo has stopped counting,
 * which must never read as "nothing refused" (review M11 — the fix in
 * 0e0c1f4c had no test); an empty, healthy ledger says so plainly; a floor
 * count says "at least".
 */
import { describe, expect, test } from "bun:test";

import type { ForeignHub } from "@crosscheck/connector-core/config/key-binding.ts";

import { foreignHubDetail } from "../src/cli/foreign-hub.ts";

const REPO = "github.com/acme/api";
const FOREIGN: ForeignHub = {
  hubOrigin: "http://evil.example:7100",
  keyOrigin: "http://hub.example:7100",
  hubSource: "repo",
  keySource: "login",
};

describe("the count beside the key-origin WARN", () => {
  test("a full ledger with no line for this repo says the count stopped, never zero", () => {
    // Act
    const detail = foreignHubDetail(FOREIGN, { groups: [], isFull: true }, REPO);

    // Assert
    expect(detail).toContain("not counted — the local refusal ledger is full");
    expect(detail).not.toContain("no session has been refused here yet");
  });

  test("an empty ledger that is not full says nothing has been refused yet", () => {
    // Act
    const detail = foreignHubDetail(FOREIGN, { groups: [], isFull: false }, REPO);

    // Assert
    expect(detail).toContain("no session has been refused here yet");
  });

  test("a count from a ledger that dropped lines is a floor", () => {
    // Arrange
    const group = { repoId: REPO, hubOrigin: FOREIGN.hubOrigin, keyOrigin: FOREIGN.keyOrigin, count: 4, lastAt: "2026-10-08T12:00:00.000Z" };

    // Act
    const detail = foreignHubDetail(FOREIGN, { groups: [group], isFull: true }, REPO);

    // Assert
    expect(detail).toContain("at least 4 sessions refused in the last 7 days");
  });
});
