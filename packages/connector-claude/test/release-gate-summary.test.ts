/**
 * The release gate's failure summary (scripts/release-gate-summary.ts) reads
 * bun's console log. The fixture is bun 1.3.13's output shape, measured: an
 * `error:` line before the `(fail)` line it belongs to, and a marked test
 * that passed followed by "this test is marked as failing but it passed".
 */
import { describe, expect, test } from "bun:test";

import { annotationsFor, caseLinesIn, failuresIn, renderSummary } from "../scripts/release-gate-summary.ts";

const LANE = "release gate — production budgets, parallel subagents, compaction and resume";
const LOG = [
  "bun test v1.3.13 (bf2e2cec)",
  "P1 [production] 121 s, 509 hook runs · subagent hits 8",
  `(pass) ${LANE} > P1 — the pilot collision must warn both people [production] > 1a: Mike's next edit tells MIKE [0.20ms]`,
  "error: expect(received).toMatch(expected)",
  "",
  'Received: "⚠ overlap: Nick · 8 files"',
  `(fail) ${LANE} > P1 — the pilot collision must warn both people [production] > 6c: agent_event agrees with the loss ledgers [1.06ms]`,
  `(fail) ${LANE} > P1 — the pilot collision must warn both people [production] > R1: every foreground hit is on NICK's record`,
  "  ^ this test is marked as failing but it passed. Remove `.failing` if tested behavior now works",
  " 70 pass",
  " 2 fail",
].join("\n");

describe("the release gate's failure summary", () => {
  test("names each failed case and test, with the assertion that failed", () => {
    // Act
    const failures = failuresIn(LOG);

    // Assert
    expect(failures.map((failure) => [failure.case, failure.id, failure.isFixLanded])).toEqual([
      ["P1 — the pilot collision must warn both people [production]", "6c", false],
      ["P1 — the pilot collision must warn both people [production]", "R1", true],
    ]);
    expect(failures[0]?.error).toBe("error: expect(received).toMatch(expected)");
    expect(failures[1]?.error).toBeNull();
  });

  test("says that a marked expected failure which passed is a fix that landed, and which line to remove", () => {
    // Arrange
    const failures = failuresIn(LOG);

    // Act
    const summary = renderSummary(failures, caseLinesIn(LOG), { runUrl: "https://example.invalid/run/1", artifact: "release-gate-logs-1-1" });
    const annotations = annotationsFor(failures);

    // Assert
    expect(summary).toContain("Remove the `R1` line from `release-gate/expected.ts`");
    expect(summary).toContain("release-gate-logs-1-1");
    expect(summary).toContain("https://example.invalid/run/1");
    expect(summary).toContain("P1 [production] 121 s");
    expect(annotations).toHaveLength(2);
    expect(annotations[1]).toContain("a fix landed");
  });

  test("says when a run ended without any failed case (a crash or a timeout)", () => {
    // Act
    const summary = renderSummary(failuresIn("bun test v1.3.13\nKilled\n"), [], { runUrl: "u", artifact: "a" });

    // Assert
    expect(summary).toContain("crashed or ran out of time");
  });
});
