/**
 * COV-10 — `isJudgeable`, the predicate AT-5 is decided by and nothing else.
 *
 * Three cases, because the first shape of this spec tested one. The third
 * term is the one that was missing: with `agent_event` and `git` both
 * complete, a `ci` lane known to be mid-flight still let `UNATTRIBUTED`
 * through — the system saying "nobody in the record did this" while knowing a
 * lane it watches had not finished. That is AT-5's "fails if" verbatim.
 */
import { describe, expect, test } from "bun:test";

import {
  COVERAGE_STATES,
  isJudgeable,
} from "../src/services/coverage.ts";
import type {
  CoverageRecord,
  CoverageSource,
  CoverageState,
} from "../src/services/coverage.ts";

const OTHERS: readonly CoverageSource[] = ["ci", "runtime", "human_edit"];

const recordWith = (
  agentEvent: CoverageState,
  git: CoverageState,
  others: CoverageState = "unavailable",
): CoverageRecord => ({
  repo: "github.com/acme/api",
  computedAt: "2026-07-24T09:00:00.000Z",
  scope: { sinceIso: "2026-07-10T09:00:00.000Z" },
  sources: [
    { source: "agent_event", state: agentEvent, reason: "sessions_reported", gapSince: null, observedAt: null },
    { source: "git", state: git, reason: "commits_reported", gapSince: null, observedAt: null },
    ...OTHERS.map((source) => ({
      source,
      state: others,
      reason: "no_emitter" as const,
      gapSince: null,
      observedAt: null,
    })),
  ],
});

describe("COV-10 (a): over agent_event x git it is true for exactly one pair", () => {
  test("only complete x complete is judgeable", () => {
    // Arrange: all 16 combinations of the two readable rungs
    const pairs = COVERAGE_STATES.flatMap((agentEvent) =>
      COVERAGE_STATES.map((git) => [agentEvent, git] as const),
    );

    // Act
    const judgeable = pairs.filter(([agentEvent, git]) =>
      isJudgeable(recordWith(agentEvent, git)),
    );

    // Assert
    expect(pairs.length).toBe(16);
    expect(judgeable).toEqual([["complete", "complete"]]);
  });
});

describe("COV-10 (b): a known gap on ANY source makes it false", () => {
  test.each(OTHERS.map((source) => [source] as const))(
    "%s at incomplete blocks judging even with agent_event and git complete",
    (source) => {
      // Arrange
      const base = recordWith("complete", "complete");
      const record: CoverageRecord = {
        ...base,
        sources: base.sources.map((row) =>
          row.source === source ? { ...row, state: "incomplete" as const } : row,
        ),
      };

      // Act & Assert
      expect(isJudgeable(base)).toBe(true);
      expect(isJudgeable(record)).toBe(false);
    },
  );
});

describe("COV-10 (c): a rung that cannot exist is not a known gap", () => {
  test.each([["unavailable"], ["unknown"]] as const)(
    "ci, runtime and human_edit at %s leave the record judgeable",
    (state) => {
      // Act & Assert: treating these as gaps makes every verdict
      // INDETERMINATE for ever, which is a predicate nobody can use.
      expect(isJudgeable(recordWith("complete", "complete", state))).toBe(true);
    },
  );
});
