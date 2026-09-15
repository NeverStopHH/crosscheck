/**
 * COV-9 — the qualifier reaches every answer surface, not only doctor (AT-9).
 *
 * A REGISTRY WALK, mechanised the way render-surface-registry.test.ts
 * mechanises non-negotiable #2: every registered surface whose module renders
 * one of the six coverage-bearing responses either names a CoverageRecord or
 * appears in COVERAGE_EXEMPT_SURFACES with a one-line reason.
 *
 * WHY THE PREDICATE IS THE SIX RESPONSES AND NOT "EVERY SURFACE". A walk over
 * all 59 registered surfaces would flag the conference report, the pin
 * listing, the statusline and seven cursor/ACP blocks that re-wrap text core
 * already rendered — and the exempt list would be spent on day one, which is
 * how a cap gets raised. The spec's own §3.5 names exactly six responses that
 * carry coverage; a surface that renders one of them is a surface that
 * asserts what the team knows on the strength of an archive, and that is the
 * set this rule is about. Every other surface is out of scope BY THE SPEC,
 * not by an exemption, which is the difference between a boundary and a hole.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  COVERAGE_BEARING_RESPONSES,
  COVERAGE_EXEMPT_SURFACES,
  COVERAGE_EXEMPT_SURFACES_MAX,
} from "../src/coverage/exempt-surfaces.ts";
import { REGISTERED_PACKAGES } from "./fixtures/registry-packages.ts";

/** The module names a coverage record, by import, by field or by parameter. */
const NAMES_COVERAGE = /\bcoverage\b|\bCoverage\b/;

interface AnswerSurface {
  readonly name: string;
  readonly module: string;
  readonly source: string;
}

const answerSurfaces = (): readonly AnswerSurface[] =>
  REGISTERED_PACKAGES.flatMap((pkg) =>
    pkg.surfaces.flatMap((surface) => {
      const source = readFileSync(join(pkg.root, surface.module), "utf8");
      return COVERAGE_BEARING_RESPONSES.some((type) =>
        new RegExp(`\\b${type}\\b`).test(source),
      )
        ? [{ name: surface.name, module: surface.module, source }]
        : [];
    }),
  );

describe("COV-9: every answer surface consumes coverage or is exempt", () => {
  test("there are answer surfaces to walk — the rule cannot be hollowed out", () => {
    // A floor, like the corpus registry's: shrinking this set is a design
    // decision, not a refactor side effect.
    expect(answerSurfaces().length).toBeGreaterThanOrEqual(15);
  });

  test("all six coverage-bearing responses are in reach of the walk", () => {
    // The other way this rule dies is quietly: drop a response name and the
    // surfaces that render it fall out of scope with nothing going red. Each
    // of §3.5's six is named here, by its envelope and by the row type the
    // renderer one level down actually takes.
    for (const name of [
      "AbsencesOutcome",
      "AbsenceEntry",
      "SearchOutcome",
      "SearchHit",
      "Diagnosis",
      "HintCandidatesResult",
      "HintClaimCandidate",
      "TripwireOutcome",
      "TripwireSession",
      "SuspectView",
    ]) {
      expect(COVERAGE_BEARING_RESPONSES, name).toContain(name);
    }
  });

  test("no surface answers about the team's knowledge without a record", () => {
    // Act
    const exempt = new Set(COVERAGE_EXEMPT_SURFACES.map((row) => row.name));
    const offenders = answerSurfaces()
      .filter((surface) => !NAMES_COVERAGE.test(surface.source))
      .filter((surface) => !exempt.has(surface.name))
      .map((surface) => `${surface.name} (${surface.module})`);

    // Assert
    expect(offenders).toEqual([]);
  });

  test("every exemption names a surface that is really registered", () => {
    // An exemption for a surface nobody registers is a row that hides a real
    // one: the list has to describe the registry, not a memory of it.
    const registered = new Set(
      REGISTERED_PACKAGES.flatMap((pkg) =>
        pkg.surfaces.map((surface) => surface.name),
      ),
    );
    for (const row of COVERAGE_EXEMPT_SURFACES) {
      expect(registered.has(row.name), `${row.name} is not registered`).toBe(
        true,
      );
    }
  });

  test("every exemption carries a reason somebody can argue with", () => {
    for (const row of COVERAGE_EXEMPT_SURFACES) {
      expect(row.reason.length, row.name).toBeGreaterThan(20);
    }
  });

  test("the exempt list is capped, and the cap is not a suggestion", () => {
    // The escape hatch may not be wider than the rule. Three, because the
    // honest exemptions are few and specific and a fourth should cost an
    // argument — never raised to make a case pass.
    expect(COVERAGE_EXEMPT_SURFACES_MAX).toBe(3);
    expect(COVERAGE_EXEMPT_SURFACES.length).toBeLessThanOrEqual(
      COVERAGE_EXEMPT_SURFACES_MAX,
    );
  });

  test("a new answer surface that skips the record is a red build", () => {
    // Arrange: the mutation COV-9 names, run inline — a module that renders a
    // coverage-bearing response and consumes no record, WITHOUT touching the
    // exempt list.
    const exempt = new Set(COVERAGE_EXEMPT_SURFACES.map((row) => row.name));
    const smuggled = {
      name: "smuggled-answer-surface",
      module: "src/fake.ts",
      source: "import type { SuspectView } from './http/hub.ts';\nexport const render = (view: SuspectView) => view.outcome;\n",
    };

    // Act
    const offends =
      COVERAGE_BEARING_RESPONSES.some((type) =>
        new RegExp(`\\b${type}\\b`).test(smuggled.source),
      ) &&
      !NAMES_COVERAGE.test(smuggled.source) &&
      !exempt.has(smuggled.name);

    // Assert
    expect(offends).toBe(true);
  });
});
