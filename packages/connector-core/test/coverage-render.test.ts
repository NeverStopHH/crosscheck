/**
 * The coverage line (03 §3.3, §3.4, §5.3) — one line, no author-written
 * string, and short enough that making it uncuttable costs the briefing
 * almost nothing.
 *
 * WHY THIS FILE IS THE `coverage-note` SURFACE'S `corpusCoveredBy`. §3.3's
 * claim is that the line carries no untrusted slot: enum values, ISO
 * timestamps and renderer-owned literals only. That claim is exactly the kind
 * a reader should not take on trust — `gapSince` and `observedAt` are STRINGS
 * THE HUB SENT, and a renderer that printed them through would put hub-chosen
 * text on every answer surface in the product. So the whole injection corpus
 * is planted in both of them here, under the same character invariants the
 * briefing and MCP corpora use.
 */
import { describe, expect, test } from "bun:test";

import { MAX_BRIEFING_CHARS, MAX_COVERAGE_LINE_CHARS } from "../src/constants.ts";
import { QUOTED_DATA_NOTICE, renderBriefing } from "../src/briefing/render.ts";
import { coverageClause, coverageNote } from "../src/coverage/render.ts";
import {
  COVERAGE_REASONS,
  COVERAGE_SOURCES,
  COVERAGE_STATES,
  UNKNOWN_COVERAGE,
} from "../src/http/coverage.ts";
import type {
  CoverageRecord,
  CoverageReason,
  CoverageSource,
  CoverageSourceRecord,
  CoverageState,
} from "../src/http/coverage.ts";
import { INJECTION_CORPUS } from "./fixtures/injection-corpus.ts";
import { assertUntrustedCharacters } from "./fixtures/untrusted-invariants.ts";

const NOW = new Date("2026-09-15T10:00:00.000Z");
const GAP_ISO = "2026-09-05T08:13:00.000Z";
const GAP_SHOWN = "2026-09-05T08:13Z";

const row = (
  source: CoverageSource,
  state: CoverageState,
  reason: CoverageReason,
  gapSince: string | null = null,
  observedAt: string | null = null,
): CoverageSourceRecord => ({ source, state, reason, gapSince, observedAt });

const recordOf = (
  rows: readonly CoverageSourceRecord[],
): CoverageRecord => ({
  repo: "github.com/acme/api",
  computedAt: NOW.toISOString(),
  scope: { sinceIso: "2026-09-01T10:00:00.000Z" },
  sources: [
    ...rows,
    ...COVERAGE_SOURCES.filter(
      (source) => !rows.some((entry) => entry.source === source),
    ).map((source) => row(source, "unavailable", "no_emitter")),
  ],
});

const REAPED = recordOf([
  row("agent_event", "incomplete", "session_reaped", GAP_ISO, GAP_ISO),
  row("git", "complete", "commits_reported", null, "2026-09-15T09:00:00.000Z"),
]);

describe("COV-1's instant reaches the line", () => {
  test("a reaped agent_event names the minute observation stopped", () => {
    // Act
    const clause = coverageClause(REAPED, NOW);

    // Assert
    expect(clause).toContain(GAP_SHOWN);
    expect(clause.startsWith("Coverage incomplete")).toBe(true);
  });

  test("an unparseable instant costs the instant, never the sentence", () => {
    // Arrange: a hub that sent rubbish where an ISO belongs
    const record = recordOf([
      row("agent_event", "incomplete", "session_reaped", "not-a-date", null),
      row("git", "unknown", "no_commit_evidence"),
    ]);

    // Act
    const clause = coverageClause(record, NOW);

    // Assert
    expect(clause.length).toBeGreaterThan(0);
    expect(clause).not.toContain("not-a-date");
    expect(clause.startsWith("Coverage incomplete")).toBe(true);
  });
});

describe("the soft annotation rule — decision 4", () => {
  test("a note renders on incomplete", () => {
    expect(coverageNote(REAPED, NOW)).not.toBeNull();
  });

  test.each([["unknown"], ["complete"], ["unavailable"]] as const)(
    "no note when the readable rungs are %s and nothing is incomplete",
    (state) => {
      // Arrange
      const record = recordOf([
        row("agent_event", state, "no_session_in_window"),
        row("git", state, "no_commit_evidence"),
      ]);

      // Act & Assert: a caveat on every answer is the noise that teaches
      // people to ignore caveats — §5.1, and Nick's decision 4.
      expect(coverageNote(record, NOW)).toBeNull();
    },
  );

  test("an un-upgraded hub annotates nothing and still answers a clause", () => {
    // Act
    const clause = coverageClause(UNKNOWN_COVERAGE, NOW);

    // Assert
    expect(coverageNote(UNKNOWN_COVERAGE, NOW)).toBeNull();
    expect(clause.startsWith("Coverage unknown")).toBe(true);
  });
});

describe("COV-6: no percentage, ever, and the bound holds", () => {
  const everyShape = (): readonly CoverageRecord[] =>
    COVERAGE_STATES.flatMap((agentState) =>
      COVERAGE_REASONS.flatMap((agentReason) =>
        COVERAGE_STATES.flatMap((gitState) =>
          COVERAGE_REASONS.map((gitReason) =>
            recordOf([
              row("agent_event", agentState, agentReason, GAP_ISO, GAP_ISO),
              row("git", gitState, gitReason, GAP_ISO, "2026-09-06T08:13:00.000Z"),
            ]),
          ),
        ),
      ),
    );

  test("no clause carries a percent sign or a ratio", () => {
    for (const record of everyShape()) {
      expect(coverageClause(record, NOW).includes("%")).toBe(false);
    }
  });

  test("every clause fits MAX_COVERAGE_LINE_CHARS", () => {
    // Arrange: 4 states x 16 reasons, squared — every shape the enum admits
    const shapes = everyShape();

    // Assert
    expect(shapes.length).toBe(4096);
    for (const record of shapes) {
      const clause = coverageClause(record, NOW);
      expect(clause.length, clause).toBeLessThanOrEqual(MAX_COVERAGE_LINE_CHARS);
      expect(clause.includes("\n"), clause).toBe(false);
    }
  });

  test("the record the renderer reads exposes no numeric aggregate", () => {
    // Assert: every own value is a string, null, or the five-row array.
    for (const [key, value] of Object.entries(REAPED)) {
      if (key === "sources" || key === "scope") {
        continue;
      }
      expect(typeof value === "string" || value === null).toBe(true);
    }
  });
});

describe("§3.3's claim, attacked: the line has no untrusted slot", () => {
  test("every corpus payload in gapSince and observedAt holds the invariants", () => {
    for (const { id, payload } of INJECTION_CORPUS) {
      // Arrange: the two hub-sent strings on the record, both hostile
      const record = recordOf([
        row("agent_event", "incomplete", "session_reaped", payload, payload),
        row("git", "incomplete", "evidence_stale", payload, payload),
      ]);

      // Act
      const clause = coverageClause(record, NOW);

      // Assert
      assertUntrustedCharacters(clause, `coverage-note/${id}`);
      expect(clause.includes(payload), `coverage-note/${id}`).toBe(false);
    }
  });
});

describe("§5.3: first and uncuttable in the briefing", () => {
  const saturate = (): readonly {
    kind: string;
    name: string;
    latestCommitAt: string;
    lastSessionAt: string | null;
    evidenceCollectedAt: string;
  }[] =>
    Array.from({ length: 40 }, (_unused, index) => ({
      kind: "unconnected",
      name: `author-${String(index)}-${"x".repeat(60)}`,
      latestCommitAt: "2026-09-14T10:00:00.000Z",
      lastSessionAt: null,
      evidenceCollectedAt: "2026-09-15T09:00:00.000Z",
    }));

  test("the clause is the line after the header, before every section", () => {
    // Arrange
    const clause = coverageClause(REAPED, NOW);

    // Act
    const briefing = renderBriefing({
      repoId: "github.com/acme/api",
      selfDeveloperId: "dev_self",
      presence: [],
      workContexts: [],
      absences: saturate(),
      coverageLine: clause,
      now: NOW,
    });
    const lines = briefing.split("\n");

    // Assert
    expect(lines[0]).toContain(QUOTED_DATA_NOTICE);
    expect(lines[1]).toBe(clause);
  });

  test("a saturated briefing still carries it — a caveat that can be cut is a caveat that lies", () => {
    // Arrange: enough absence lines to spend the whole char budget
    const clause = coverageClause(REAPED, NOW);

    // Act
    const briefing = renderBriefing({
      repoId: "github.com/acme/api",
      selfDeveloperId: "dev_self",
      presence: [],
      workContexts: [],
      absences: saturate(),
      coverageLine: clause,
      now: NOW,
    });

    // Assert
    expect(briefing.length).toBeLessThanOrEqual(MAX_BRIEFING_CHARS);
    expect(briefing).toContain(clause);
    expect(briefing).toContain(GAP_SHOWN);
  });

  test("no coverage line leaves a quiet repo silent, exactly as before", () => {
    // Act
    const briefing = renderBriefing({
      repoId: "github.com/acme/api",
      selfDeveloperId: "dev_self",
      presence: [],
      workContexts: [],
      now: NOW,
    });

    // Assert
    expect(briefing).toBe("");
  });

  test("a gap on a quiet repo is still said out loud", () => {
    // Act: nothing to report, and we know we were not watching
    const briefing = renderBriefing({
      repoId: "github.com/acme/api",
      selfDeveloperId: "dev_self",
      presence: [],
      workContexts: [],
      coverageLine: coverageClause(REAPED, NOW),
      now: NOW,
    });

    // Assert
    expect(briefing.split("\n").length).toBe(2);
    expect(briefing).toContain(GAP_SHOWN);
  });
});
