/**
 * `crosscheck pilot` as a person reads it (1.0 spec 07 §5).
 *
 * The report's one rule is that every figure is measured or says why not, and
 * the hub keeps it as a TYPE. These tests keep it at the last step, where it
 * is easiest to lose: a renderer that prints `value ?? 0`, a channel loop that
 * skips the empty bucket, an opened count with the list beside it cut away.
 * Each would print a tidier report that says something nobody measured.
 */
import { describe, expect, test } from "bun:test";

import type { FixDiffOutcome } from "@crosscheck/connector-core/git/fix-diff.ts";
import type { PilotReport } from "@crosscheck/connector-core/http/pilot.ts";

import { renderPilot } from "../src/cli/pilot-render.ts";
import type { PilotView } from "../src/cli/pilot-render.ts";

const report = (overrides: Partial<PilotReport> = {}): PilotReport => ({
  repo: "github.com/acme/api",
  enrolled: true,
  sinceIso: "2026-07-20T12:00:00.000Z",
  untilIso: "2026-09-14T12:00:00.000Z",
  days: 56,
  sessionSet: { used: 31, cap: 50, refused: 0, spanned: 29, restarted: 1, notRecorded: 1 },
  duplicateWork: {
    surfaced: 312,
    opened: 74,
    converged: 31,
    byChannel: { unknown: 0, briefing: 208, prompt_hint: 96, tripwire: 8, suspect: 0 },
    priorWork: [
      { workContextId: "wc_8f21", title: "Widen the filter row", openedBySessions: 2 },
    ],
    priorWorkBeyondList: 0,
    openedAnyway: 19,
  },
  collisions: {
    tripwireFlagged: { kind: "measured", value: 8 },
    ghostFlagged: { kind: "unavailable", reason: "ghost_lines_not_recorded" },
    bothLanded: { kind: "measured", value: 3 },
    ciRegressed: { kind: "unavailable", reason: "no_ci_reporter" },
  },
  attribution: {
    answers: 6,
    attributions: 5,
    excluded: 1,
    repaired: [
      {
        pinId: "pin_a",
        repairPinId: "pin_b",
        brokenCommit: "abc1234",
        repairCommit: "def5678",
        namedFiles: ["src/workbench/usePlayback.ts"],
      },
      {
        pinId: "pin_c",
        repairPinId: "pin_d",
        brokenCommit: "abc1234",
        repairCommit: "def5678",
        namedFiles: ["src/workbench/usePlayback.ts"],
      },
    ],
    repairedBeyondBound: 0,
    noRepairYet: 2,
  },
  precision: {
    sessions: 1208,
    openedPer100: { kind: "measured", value: 6.1 },
    openedTargetPer100: 8,
    offTargetMarks: 11,
    offTargetPer100: { kind: "measured", value: 0.9 },
    offTargetCeilingPer100: 20,
    surfaceOkMarks: 4,
  },
  integrity: [
    {
      surface: "api-suspect",
      counters: {
        answers_emitted: 12,
        qualifier_required: 3,
        qualifier_emitted: 3,
        judgeable: 9,
        not_judgeable: 3,
        coverage_agent_event_complete: 10,
        coverage_agent_event_incomplete: 2,
      },
    },
    { surface: "api-search", counters: null },
  ],
  ...overrides,
});

const view = (
  overrides: Partial<PilotReport> = {},
  outcomes: readonly FixDiffOutcome[] = ["hit", "miss"],
): PilotView => {
  const built = report(overrides);
  return {
    report: built,
    fixes: built.attribution.repaired.map((repair, index) => ({
      repair,
      outcome: outcomes[index] ?? "unresolvable",
    })),
  };
};

describe("renderPilot", () => {
  test("a repo nobody enrolled prints that and no figure at all", () => {
    // Arrange & Act — figures for a repo nobody agreed to measure would be
    // measuring it anyway, and zeros would read as a result.
    const out = renderPilot(view({ enrolled: false }));

    // Assert
    expect(out).toContain("not enrolled");
    expect(out).toContain("pilotEnrolled");
    expect(out).not.toContain("surfaced");
    expect(out).not.toContain("per 100");
  });

  test("every channel prints, the empty ones and `unknown` included (PIL-1)", () => {
    // Arrange & Act
    const out = renderPilot(view());

    // Assert
    expect(out).toContain(
      "by channel: briefing 208 · prompt_hint 96 · tripwire 8 · suspect 0 · unknown 0",
    );
  });

  test("a channel this client has not heard of is printed, not dropped", () => {
    // Arrange
    const base = report();
    const out = renderPilot(
      view({
        duplicateWork: {
          ...base.duplicateWork,
          byChannel: { ...base.duplicateWork.byChannel, digest: 5 },
        },
      }),
    );

    // Assert
    expect(out).toContain("digest 5");
  });

  test("a known channel the hub did not report says so instead of reading zero", () => {
    // Arrange
    const base = report();
    const { tripwire: _missing, ...rest } = base.duplicateWork.byChannel;

    // Act
    const out = renderPilot(
      view({ duplicateWork: { ...base.duplicateWork, byChannel: rest } }),
    );

    // Assert
    expect(out).toContain("tripwire not reported");
    expect(out).not.toContain("tripwire 0");
  });

  test("each opened count is printed beside the prior work it named (PIL-2)", () => {
    // Arrange & Act
    const out = renderPilot(view());

    // Assert
    expect(out).toContain("opened 74");
    expect(out).toContain("«Widen the filter row» wc_8f21 · opened by 2 sessions");
  });

  test("an opened count whose prior work cannot be listed is withheld, never bare (PIL-2)", () => {
    // Arrange — a bare number is the counterfactual claim without the
    // counterfactual.
    const base = report();

    // Act
    const out = renderPilot(
      view({ duplicateWork: { ...base.duplicateWork, priorWork: [] } }),
    );

    // Assert
    expect(out).not.toContain("opened 74");
    expect(out).toContain("withheld");
  });

  test("an unavailable figure prints its reason, never a zero", () => {
    // Arrange & Act
    const out = renderPilot(view());

    // Assert
    expect(out).toContain("ghost unavailable — a ghost line is never recorded as a delivery");
    expect(out).toContain("ci regressed unavailable — no CI reporter writes to this hub");
    expect(out).not.toContain("ghost 0");
  });

  test("a reason this client has no sentence for is printed as the word", () => {
    // Arrange
    const base = report();

    // Act
    const out = renderPilot(
      view({
        collisions: {
          ...base.collisions,
          ciRegressed: { kind: "unavailable", reason: "reporter_paused" },
        },
      }),
    );

    // Assert
    expect(out).toContain("ci regressed unavailable (reporter_paused)");
  });

  test("a surface that counted nothing is `not instrumented`, never `missed 0` (PIL-4)", () => {
    // Arrange & Act
    const out = renderPilot(view());

    // Assert
    expect(out).toContain("api-search: not instrumented");
    expect(out).toContain("api-suspect: answers 12 · qualifier required 3 · emitted 3 · missed 0");
  });

  test("each coverage source gets its own line, never one number", () => {
    // Arrange & Act
    const out = renderPilot(view());

    // Assert
    expect(out).toContain("agent_event complete 10 · incomplete 2 · unknown 0 · unavailable 0");
    expect(out).toContain("human_edit complete 0 · incomplete 0 · unknown 0 · unavailable 0");
  });

  test("proof 3 scores the diffs, and exclusions and missing repairs are their own counts", () => {
    // Arrange & Act
    const out = renderPilot(view());

    // Assert
    expect(out).toContain("hit 1 · miss 1 · excluded (coverage gap at answer time) 1 · no repair pin yet 2");
    expect(out).not.toMatch(/\d+%/);
  });

  test("outcomes that are not verdicts are counted apart from hit and miss", () => {
    // Arrange & Act
    const out = renderPilot(view({}, ["empty", "unresolvable"]));

    // Assert
    expect(out).toContain("hit 0 · miss 0");
    expect(out).toContain("not scored: empty range 1 · too broad 0 · not resolvable on this clone 1");
    expect(out).toContain("git fetch");
  });

  test("the precision figures are a pull and a floor, and say so", () => {
    // Arrange & Act
    const out = renderPilot(view());

    // Assert
    expect(out).toContain("opened per 100 sessions 6.1 (target 8, declared before measuring)");
    expect(out).toContain("off-target marks per 100 sessions 0.9 (ceiling 20) — a FLOOR: marks are voluntary");
  });

  test("a restarted sequence is counted without a span (PIL-7)", () => {
    // Arrange & Act
    const out = renderPilot(view());

    // Assert
    expect(out).toContain("sequence: 29 spanned · 1 restarted (no span: the counter started over) · 1 not recorded");
  });

  test("the words the spec refuses never appear (§8.1)", () => {
    // Arrange & Act — "prevented" is a counterfactual nobody observed, and
    // "helpful" is a human verdict when what was measured is the MODEL
    // pulling a pointer.
    const out = renderPilot(view());

    // Assert
    expect(out).not.toMatch(/prevent/i);
    expect(out).not.toMatch(/helpful/i);
  });
});
