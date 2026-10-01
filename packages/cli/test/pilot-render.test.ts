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
import type {
  PilotLabelFigures,
  PilotReport,
} from "@crosscheck/connector-core/http/pilot.ts";

import { renderPilot } from "../src/cli/pilot-render.ts";
import type { PilotView } from "../src/cli/pilot-render.ts";

/** The review's example over the window: 4 helpful, 10 noise, 3 unclear of 2,416 over 1,208 sessions. */
const windowLabels = (): PilotLabelFigures => ({
  sessions: 1208,
  interventions: 2416,
  helpful: 4,
  noise: 10,
  unclear: 3,
  labelled: 17,
  benefitPer100: { kind: "measured", value: (4 * 100) / 1208 },
  burdenPer100: { kind: "measured", value: 200 },
  precision: { kind: "measured", value: 4 / 14 },
  labelCoverage: { kind: "measured", value: 17 / 2416 },
});

/** The same labels inside the discovery cohort's 31 sessions and 62 interventions. */
const discoveryLabels = (): PilotLabelFigures => ({
  sessions: 31,
  interventions: 62,
  helpful: 4,
  noise: 10,
  unclear: 3,
  labelled: 17,
  benefitPer100: { kind: "measured", value: (4 * 100) / 31 },
  burdenPer100: { kind: "measured", value: 200 },
  precision: { kind: "measured", value: 4 / 14 },
  labelCoverage: { kind: "measured", value: 17 / 62 },
});

/** A cohort nobody has entered yet: every figure says why it is absent. */
const emptyLabels = (): PilotLabelFigures => ({
  sessions: 0,
  interventions: 0,
  helpful: 0,
  noise: 0,
  unclear: 0,
  labelled: 0,
  benefitPer100: { kind: "unavailable", reason: "no_sessions" },
  burdenPer100: { kind: "unavailable", reason: "no_sessions" },
  precision: { kind: "unavailable", reason: "no_labels" },
  labelCoverage: { kind: "unavailable", reason: "no_interventions" },
});

const report = (overrides: Partial<PilotReport> = {}): PilotReport => ({
  repo: "github.com/acme/api",
  enrolled: true,
  labelsSinceIso: "2026-07-01T12:00:00.000Z",
  sinceIso: "2026-07-20T12:00:00.000Z",
  untilIso: "2026-09-14T12:00:00.000Z",
  days: 56,
  sessionSet: {
    used: 31,
    cap: 200,
    refused: 0,
    legacyRefused: 0,
    beforeLabels: 0,
    discovery: 31,
    discoveryCap: 50,
    replication: 0,
    replicationCap: 150,
    legacy: 0,
    spanned: 29,
    restarted: 1,
    notRecorded: 1,
  },
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
        pinnedFiles: ["src/workbench/usePlayback.ts"],
        namedFiles: ["src/config.ts"],
      },
      {
        pinId: "pin_c",
        repairPinId: "pin_d",
        brokenCommit: "abc1234",
        repairCommit: "def5678",
        pinnedFiles: ["src/workbench/usePlayback.ts"],
        namedFiles: ["src/config.ts"],
      },
    ],
    repairedBeyondBound: 0,
    noRepairYet: 2,
    repairedWithoutBreakCommit: 0,
    supersededAnswers: 0,
    answersAfterRepair: 0,
  },
  precision: {
    ...windowLabels(),
    labelledSinceIso: "2026-07-20T12:00:00.000Z",
    legacyNoise: 0,
    precisionTarget: 0.5,
    openedPer100: { kind: "measured", value: 6.1 },
    openedTargetPer100: 8,
    noisySessionsPer100: { kind: "measured", value: 0.9 },
    noisySessionsCeilingPer100: 20,
    surfaceOkMarks: 4,
    reasons: [{ label: "noise", reason: "stale pointer" }],
    reasonsBeyondList: 3,
  },
  cohorts: [
    { cohort: "discovery", cap: 50, ...discoveryLabels() },
    { cohort: "replication", cap: 150, ...emptyLabels() },
  ],
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
    expect(out).toContain("api-suspect: answers 12 · qualifier required 3");
    // No "emitted" or "missed": a hub-side count of those could only ever
    // equal "required", and printing it would claim a check nobody ran.
    expect(out).not.toContain("missed");
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

    // Assert — proof 3 states counts and never a percentage: a rate over a
    // handful of repairs reads as a result it is not. (Proof 4's precision
    // is a ratio by definition, and prints its own denominator beside it.)
    const proof3 = out.slice(out.indexOf("3. attribution accuracy"), out.indexOf("4. "));
    expect(out).toContain("hit 1 · miss 1 · excluded (coverage gap at answer time) 1 · no repair pin yet 2");
    expect(proof3).not.toMatch(/\d+%/);
  });

  test("outcomes that are not verdicts are counted apart from hit and miss", () => {
    // Arrange & Act
    const out = renderPilot(view({}, ["empty", "unresolvable"]));

    // Assert
    expect(out).toContain("hit 0 · miss 0");
    expect(out).toContain(
      "not scored: the fix touched only pinned files 0 · empty range 1 · too broad 0 · not resolvable on this clone 1",
    );
    expect(out).toContain("git fetch");
  });

  test("a fix that touched only pinned files is neither a hit nor a miss", () => {
    // Arrange & Act — every candidate touched the pinned files, so this fix
    // cannot say which one broke it
    const out = renderPilot(view({}, ["not_discriminating", "hit"]));

    // Assert
    expect(out).toContain("hit 1 · miss 0");
    expect(out).toContain("the fix touched only pinned files 1");
  });

  test("one verdict per fix is said, and so is a break with no recorded commit", () => {
    // Arrange
    const base = report();

    // Act
    const out = renderPilot(
      view({
        attribution: {
          ...base.attribution,
          supersededAnswers: 2,
          answersAfterRepair: 1,
          repairedWithoutBreakCommit: 3,
        },
      }),
    );

    // Assert
    expect(out).toContain("one verdict per fix: 2 earlier answer(s) replaced · 1 given after the repair, not scored");
    expect(out).toContain("3 repaired break(s) recorded no commit at the break");
  });

  test("the pull and the floor are named as what they are, and say so", () => {
    // Arrange & Act
    const out = renderPilot(view());

    // Assert
    expect(out).toContain(
      "opened per 100 sessions 6.1 (target 8, declared before measuring) — the agent pulled it; no person judged it",
    );
    expect(out).toContain("noisy sessions per 100 0.9 (ceiling 20) — a FLOOR: labels are voluntary");
  });

  test("precision prints beside its label coverage, and unclear apart (07 §12)", () => {
    // Arrange & Act — a precision from three labels out of forty must never
    // read as a result, so coverage is on the same line, always.
    const out = renderPilot(view());

    // Assert
    expect(out).toContain("benefit 0.3 helpful per 100 sessions · burden 200.0 interventions per 100 sessions");
    expect(out).toContain(
      "precision 29% (4 helpful of 14 verdicts; below the 50% target, declared before measuring) · label coverage 1% (17 of 2,416 interventions labelled) · unclear 3 (abstained, not in the denominator)",
    );
  });

  test("M3: just below the target never prints as meeting it", () => {
    // Arrange — the second review: 50 helpful of 101 (49.5%) printed
    // "precision 50% … target 50%", a pass that did not happen
    const base = report();
    const out = renderPilot(
      view({
        precision: {
          ...base.precision,
          helpful: 50,
          noise: 51,
          precision: { kind: "measured", value: 50 / 101 },
        },
      }),
    );

    // Assert — the side is the raw value's, and the digits show it
    expect(out).toContain("precision 49.5% (50 helpful of 101 verdicts; below the 50% target");
    expect(out).not.toContain("precision 50%");
  });

  test("exactly at the target says so", () => {
    // Arrange
    const base = report();
    const out = renderPilot(
      view({
        precision: { ...base.precision, helpful: 7, noise: 7, precision: { kind: "measured", value: 0.5 } },
      }),
    );

    // Assert
    expect(out).toContain("precision 50% (7 helpful of 14 verdicts; at or above the 50% target");
  });

  test("a precision with no verdict prints its reason, never 0%", () => {
    // Arrange
    const built = report();
    const out = renderPilot(
      view({
        precision: {
          ...built.precision,
          precision: { kind: "unavailable", reason: "no_labels" },
        },
      }),
    );

    // Assert
    expect(out).toContain("precision unavailable — nobody has labelled an intervention helpful or noise yet");
    expect(out).not.toContain("precision 0%");
  });

  test("the two cohorts print side by side, an empty one saying so", () => {
    // Arrange & Act
    const out = renderPilot(view());

    // Assert
    expect(out).toContain("cohorts, side by side");
    expect(out).toContain(
      "discovery 31/50 sessions · interventions 62 · benefit 12.9 · burden 200.0 · precision 29% (4 of 14) · coverage 27% (17 of 62) · unclear 3",
    );
    expect(out).toContain("replication 0/150 sessions — empty");
  });

  test("L6: a cohort's coverage carries its counts, so 1 of 300 never reads as none", () => {
    // Arrange — the second review: a bare rounded percent printed 1 of 300
    // as "0%" and 199 of 200 as "100%"
    const sparse = {
      cohort: "replication",
      cap: 150,
      ...discoveryLabels(),
      interventions: 300,
      labelled: 1,
      labelCoverage: { kind: "measured" as const, value: 1 / 300 },
    };
    const out = renderPilot(
      view({ cohorts: [{ cohort: "discovery", cap: 50, ...discoveryLabels() }, sparse] }),
    );

    // Assert
    expect(out).toContain("coverage 0% (1 of 300)");
  });

  test("a full discovery cohort says it is frozen", () => {
    // Arrange — the preregistered fifty; a reader comparing the two cohorts
    // must know no session joins the first one any more (its labels can
    // still arrive, so the line says MEMBERSHIP, not figures)
    const full = { cohort: "discovery", cap: 50, ...discoveryLabels(), sessions: 50 };
    const empty = { cohort: "replication", cap: 150, ...emptyLabels() };

    // Act
    const out = renderPilot(view({ cohorts: [full, empty] }));

    // Assert
    expect(out).toContain("discovery 50/50 sessions (full — membership frozen)");
  });

  test("the labelled figures say where they start when labels came after the window did (H1, M5)", () => {
    // Arrange — labels became available mid-window: the earlier sessions
    // could not be labelled, and a reader must not take the figures for the
    // whole eight weeks
    const base = report();
    const out = renderPilot(
      view({
        labelsSinceIso: "2026-09-01T09:30:00.000Z",
        precision: { ...base.precision, labelledSinceIso: "2026-09-01T09:30:00.000Z" },
      }),
    );

    // Assert
    expect(out).toContain(
      "labelled figures count sessions from 2026-09-01, when labels became available here — earlier ones could not be labelled",
    );
  });

  test("an unclipped window says nothing about where labels start", () => {
    // Arrange & Act
    const out = renderPilot(view());

    // Assert
    expect(out).not.toContain("labelled figures count sessions from");
  });

  test("0.10 noise marks print as their own count, outside precision (H1)", () => {
    // Arrange
    const base = report();
    const out = renderPilot(view({ precision: { ...base.precision, legacyNoise: 6 } }));

    // Assert
    expect(out).toContain(
      "noise marks from before labels (off_target) 6 — outside precision: nobody could label those interventions helpful",
    );
  });

  test("the header counts the 0.10 rows apart, in neither cohort (H1)", () => {
    // Arrange
    const base = report();
    const out = renderPilot(view({ sessionSet: { ...base.sessionSet, legacy: 30 } }));

    // Assert
    expect(out).toContain("· 30 recorded before labels, in neither cohort");
  });

  test("the header says 0.10's refusals and the pre-labels sessions apart from the set's own (M2, M4)", () => {
    // Arrange
    const base = report();
    const out = renderPilot(
      view({ sessionSet: { ...base.sessionSet, legacyRefused: 30, beforeLabels: 3 } }),
    );

    // Assert — the set's own refusals stay 0; the others are named for what they are
    expect(out).toContain("0 refused at the cap");
    expect(out).toContain("· 30 refused under the 0.10 fifty-session cap, before labels");
    expect(out).toContain("· 3 started before labels, not in the set");
  });

  test("the header names the set and both cohorts' fill", () => {
    // Arrange & Act
    const out = renderPilot(view());

    // Assert — the set no longer stops at fifty; the refusal past the cap
    // is still a count on the first line
    expect(out).toContain(
      "session set 31/200 (discovery 31/50 · replication 0/150), 0 refused at the cap",
    );
  });

  test("a reason is quoted as data, with the count beyond the list", () => {
    // Arrange & Act
    const out = renderPilot(view());

    // Assert
    expect(out).toContain("reasons people gave, newest first:");
    expect(out).toContain("noise: «stale pointer»");
    expect(out).toContain("(+3 more, not listed)");
  });

  test("a restarted sequence is counted without a span (PIL-7)", () => {
    // Arrange & Act
    const out = renderPilot(view());

    // Assert
    expect(out).toContain("sequence: 29 spanned · 1 restarted (no span: the counter started over) · 1 not recorded");
  });

  test("the words the spec refuses never appear where they would lie (§8.1, §12)", () => {
    // Arrange & Act — "prevented" is a counterfactual nobody observed, and
    // "helpful" is a human verdict: since §12 it names a human label and
    // nothing else, so the line about the MODEL pulling a pointer never
    // carries it.
    const out = renderPilot(view());
    const opened = out.split("\n").find((line) => line.includes("opened per 100")) ?? "";

    // Assert
    expect(out).not.toMatch(/prevent/i);
    expect(opened).not.toMatch(/helpful/i);
  });
});
