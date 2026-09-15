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
import {
  coverageClause,
  coverageNote,
  mustQualifyEmptyAnswer,
} from "../src/coverage/render.ts";
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

/**
 * A SCOPED RECORD MAY NOT BE READ OUT AS A REPO-WIDE ONE.
 *
 * §3.2a lets a caller narrow the question — `/api/search` passes the caller's
 * own `since`, the pin lane passes a file set — and the hub's record is honest
 * about it: the reason enum literally says `no_session_in_window` and
 * `scope.sinceIso` carries the window. The renderer threw both away and said
 * "no agent session reported on this repo", which is false as written on a
 * busy, fully-watched repo, on the surface §1 names as AT-1's defect line.
 * Fail-safe direction, still a statement nobody observed — and it makes
 * "Coverage unknown" fire on ordinary short-window searches against perfectly
 * watched repos, which is the noise §5.1 argues against arriving through the
 * section written to prevent it.
 */
describe("the sentence is about the question that was asked", () => {
  test("a window-narrowed record names the window, not the repo", () => {
    // Arrange: a one-hour search on a repo with plenty of reported sessions
    const record: CoverageRecord = {
      repo: "github.com/acme/api",
      computedAt: NOW.toISOString(),
      scope: { sinceIso: new Date(NOW.getTime() - 3_600_000).toISOString() },
      sources: [
        row("agent_event", "unknown", "no_session_in_window"),
        row("git", "complete", "commits_reported", null, GAP_ISO),
        row("ci", "unavailable", "no_emitter"),
        row("runtime", "unavailable", "out_of_scope_1_0"),
        row("human_edit", "unavailable", "no_platform_rung"),
      ],
    };

    // Act
    const clause = coverageClause(record, NOW);

    // Assert: a model reading "no agent session reported on this repo"
    // concludes the archive is empty and re-derives work recorded an hour ago.
    expect(clause).toContain("1h");
    expect(clause).not.toBe(
      "Coverage unknown: no agent session reported on this repo; git evidence reported.",
    );
  });

  test("a path-scoped record names the files, not the repo", () => {
    // Arrange: the pin lane's shape
    const record: CoverageRecord = {
      repo: "github.com/acme/api",
      computedAt: NOW.toISOString(),
      scope: { sinceIso: GAP_ISO, paths: ["src/player.ts"] },
      sources: [
        row("agent_event", "unknown", "no_session_in_window"),
        row("git", "complete", "commits_reported", null, GAP_ISO),
        row("ci", "unavailable", "no_emitter"),
        row("runtime", "unavailable", "out_of_scope_1_0"),
        row("human_edit", "unavailable", "no_platform_rung"),
      ],
    };

    // Act
    const clause = coverageClause(record, NOW);

    // Assert: sessions may well have reported on this repo — just not here.
    expect(clause).not.toContain("on this repo");
  });

  test("a path-scoped gap says the gap is about those files", () => {
    // Arrange
    const record: CoverageRecord = {
      repo: "github.com/acme/api",
      computedAt: NOW.toISOString(),
      scope: { sinceIso: GAP_ISO, paths: ["src/player.ts"] },
      sources: [
        row("agent_event", "incomplete", "session_reaped", GAP_ISO, GAP_ISO),
        row("git", "complete", "commits_reported", null, GAP_ISO),
        row("ci", "unavailable", "no_emitter"),
        row("runtime", "unavailable", "out_of_scope_1_0"),
        row("human_edit", "unavailable", "no_platform_rung"),
      ],
    };

    // Act
    const clause = coverageClause(record, NOW);

    // Assert
    expect(clause).toContain(GAP_SHOWN);
    expect(clause).not.toContain("on this repo");
  });

  test("an UNSCOPED record still says `on this repo`", () => {
    // Arrange: the control — the briefing and doctor pass no scope, and
    // §3.2a says they get the repo-wide answer exactly as before.
    const record = recordOf([
      row("agent_event", "unknown", "no_session_in_window"),
      row("git", "complete", "commits_reported", null, GAP_ISO),
    ]);

    // Act
    const clause = coverageClause(record, NOW);

    // Assert
    expect(clause).toContain("on this repo");
  });
});

/**
 * THE HEAD WORD AND THE BODY MUST BE ABOUT THE SAME RECORD.
 *
 * `headOf` takes the worst state across all five readable rungs; the body was
 * built from two fragments. So `ci`, `runtime` and `human_edit` could each set
 * the head and none of them could ever appear in the sentence — and by
 * decision 2 that sentence is the FIRST, uncuttable line of every SessionStart
 * briefing for as long as the gap lasts. A caveat a reader cannot reconcile
 * reads as a crosscheck bug, which is how the next real "Coverage incomplete"
 * gets skipped.
 *
 * Not hypothetical: this spec minted `ci_lanes_reported`, `ci_lanes_missing`,
 * `ci_awaiting_rerun` and `ci_not_reported_yet` into both enums for 05, and
 * `parseCoverage` accepts them today.
 */
describe("a gap on a lane the sentence cannot name", () => {
  test("an incomplete ci lane is named, not contradicted", () => {
    // Arrange: 05 §3.6's exact state — agent_event and git both clean, one
    // CI lane mid-flight
    const record = recordOf([
      row("agent_event", "complete", "sessions_reported", null, GAP_ISO),
      row("git", "complete", "commits_reported", null, GAP_ISO),
      row("ci", "incomplete", "ci_lanes_missing", GAP_ISO, GAP_ISO),
    ]);

    // Act
    const clause = coverageClause(record, NOW);

    // Assert
    expect(clause.startsWith("Coverage incomplete")).toBe(true);
    expect(clause).not.toBe(
      "Coverage incomplete: agent sessions reported; git evidence reported.",
    );
    expect(clause).toContain("ci");
  });

  test.each([
    ["ci", "ci_not_reported_yet"],
    ["runtime", "out_of_scope_1_0"],
    ["human_edit", "no_platform_rung"],
  ] as const)(
    "an %s rung that is merely unknown still reaches the sentence",
    (source, reason) => {
      // Arrange
      const record = recordOf([
        row("agent_event", "complete", "sessions_reported", null, GAP_ISO),
        row("git", "complete", "commits_reported", null, GAP_ISO),
        row(source, "unknown", reason),
      ]);

      // Act
      const clause = coverageClause(record, NOW);

      // Assert: the head says "unknown", so the body has to say about what.
      expect(clause.startsWith("Coverage unknown")).toBe(true);
      expect(clause).not.toBe(
        "Coverage unknown: agent sessions reported; git evidence reported.",
      );
    },
  );

  test("a record with NO readable rung at all is never `complete`", () => {
    // Arrange: every rung `unavailable`. `headOf` filtered those out and then
    // asked `.some()` twice over an empty set — both false, so it fell
    // through to "Coverage complete": a pass produced from zero evidence,
    // which is the clause AT-10 names by name.
    const record = recordOf([
      row("agent_event", "unavailable", "no_emitter"),
      row("git", "unavailable", "no_emitter"),
    ]);

    // Act
    const clause = coverageClause(record, NOW);

    // Assert: and the two halves of the feature have to agree — the
    // empty-answer rule fires on this record, so the clause may not say the
    // opposite in the line beside it.
    expect(clause).not.toContain("Coverage complete");
    expect(mustQualifyEmptyAnswer(record)).toBe(true);
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

  test("every shape of ALL FIVE rungs fits, and none fakes a pass", () => {
    // Arrange: everyShape() above pins ci, runtime and human_edit at
    // `unavailable` via recordOf, so no renderer test ever saw one of them
    // `incomplete` — which is exactly where the head word and the body
    // disagreed. This sweep varies all five states together, with the
    // longest reasons and a gap instant on every row.
    const shapes = COVERAGE_STATES.flatMap((agent) =>
      COVERAGE_STATES.flatMap((git) =>
        COVERAGE_STATES.flatMap((ci) =>
          COVERAGE_STATES.flatMap((runtime) =>
            COVERAGE_STATES.map((human) =>
              recordOf([
                row("agent_event", agent, "session_reaped", GAP_ISO, GAP_ISO),
                row("git", git, "commit_authors_unreported", GAP_ISO, GAP_ISO),
                row("ci", ci, "ci_awaiting_rerun", GAP_ISO, GAP_ISO),
                row("runtime", runtime, "out_of_scope_1_0", GAP_ISO, GAP_ISO),
                row("human_edit", human, "no_platform_rung", GAP_ISO, GAP_ISO),
              ]),
            ),
          ),
        ),
      ),
    );
    expect(shapes.length).toBe(1024);

    // Act & Assert
    let fakePasses = 0;
    let contradictions = 0;
    for (const record of shapes) {
      const clause = coverageClause(record, NOW);
      expect(clause.length, clause).toBeLessThanOrEqual(MAX_COVERAGE_LINE_CHARS);
      expect(clause.includes("%"), clause).toBe(false);
      expect(clause.includes("\n"), clause).toBe(false);
      const readable = record.sources.filter(
        (entry) => entry.state !== "unavailable",
      );
      const clean =
        readable.length > 0 &&
        readable.every((entry) => entry.state === "complete");
      if (clause.startsWith("Coverage complete") && !clean) {
        fakePasses += 1;
      }
      if (
        clause.startsWith("Coverage incomplete") &&
        clause ===
          "Coverage incomplete: agent sessions reported; git evidence reported."
      ) {
        contradictions += 1;
      }
    }

    // A head word that says one thing over a body that says the opposite, and
    // a pass over an empty readable set, are the two ways this line lies.
    expect(fakePasses).toBe(0);
    expect(contradictions).toBe(0);
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
