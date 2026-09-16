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

/**
 * The module names a coverage record IN CODE — by import, by field, by
 * parameter — and prose does not count.
 *
 * COMMENTS AND STRING LITERALS ARE STRIPPED FIRST, because a predicate over
 * the whole source lets a doc comment satisfy a rule about consuming a
 * record. That is weaker than the precedent §7 cites for its own escape
 * hatch — `corpusCoveredBy` is machine-checked and the phrase
 * "corpus-covered" is BANNED from a `note` precisely because a prose claim of
 * coverage is not a claim (src/render-surfaces.ts) — and weaker than COV-5,
 * which forces every refused rung to be a printed doctor line. With a comment
 * as an escape hatch, COVERAGE_EXEMPT_SURFACES_MAX never binds.
 *
 * And the pattern is no longer word-bounded: the code spells `coverageLine`,
 * `coverageNote`, `CoverageRecord`, `coverage:` — identifiers, not the bare
 * word — so `\bcoverage\b` matched the doc comments and missed the code.
 * `briefing` and `briefing-solved` were passing on prose alone because of it.
 */
const stripProse = (source: string): string =>
  source
    .replaceAll(/\/\*[\s\S]*?\*\//g, " ")
    .replaceAll(/\/\/[^\n]*/g, " ")
    .replaceAll(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replaceAll(/"(?:[^"\\\n]|\\.)*"/g, '""');

const namesCoverage = (source: string): boolean =>
  /coverage/i.test(stripProse(source));

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
      .filter((surface) => !namesCoverage(surface.source))
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

  test("no registered answer surface satisfies the rule on prose alone", () => {
    // The walk above cannot tell "names a record" from "mentions coverage in
    // a comment", so this splits the same set and prints it. Two surfaces
    // were on the wrong side of that line — `briefing` and `briefing-solved`,
    // both resolving to src/briefing/render.ts, whose only bare-word matches
    // were two doc-comment lines while the code spelled `coverageLine`.
    const exempt = new Set(COVERAGE_EXEMPT_SURFACES.map((entry) => entry.name));
    const surfaces = answerSurfaces();
    const graded = surfaces.map((surface) => ({
      name: surface.name,
      module: surface.module,
      exempt: exempt.has(surface.name),
      inCode: /coverage/i.test(stripProse(surface.source)),
      anywhere: /coverage/i.test(surface.source),
    }));
    const proseOnly = graded.filter(
      (entry) => !entry.exempt && !entry.inCode && entry.anywhere,
    );
    process.stdout.write(
      `COV-9  ${String(surfaces.length)} answer surfaces: ` +
        `${String(graded.filter((entry) => entry.inCode).length)} name coverage in code, ` +
        `${String(graded.filter((entry) => entry.exempt).length)} exempt, ` +
        `${String(proseOnly.length)} on prose alone\n`,
    );

    // Assert
    expect(proseOnly.map((entry) => `${entry.name} (${entry.module})`)).toEqual(
      [],
    );
  });

  test("a comment saying the word `coverage` is not a coverage record", () => {
    // Arrange: the same smuggled surface as below, with one doc comment
    // added. §7 spent a subsection making the escape hatch narrower than the
    // rule — a VERIFY on the list's length, one printed doctor line per
    // exemption, COVERAGE_EXEMPT_SURFACES_MAX = 3 "never raised to make a
    // case pass" — on the explicit precedent that a prose claim of coverage
    // is not a claim (render-surfaces.ts bans the phrase "corpus-covered"
    // from a `note` for exactly this reason). A comment defeated all of it
    // without touching the list, so the cap never bound.
    const exempt = new Set(COVERAGE_EXEMPT_SURFACES.map((entry) => entry.name));
    const smuggled = {
      name: "smuggled-answer-surface",
      module: "src/fake.ts",
      source:
        "/** No coverage record is needed here. */\n" +
        "import type { SuspectView } from './http/hub.ts';\n" +
        "export const render = (view: SuspectView) => view.outcome;\n",
    };

    // Act
    const offends =
      COVERAGE_BEARING_RESPONSES.some((type) =>
        new RegExp(`\\b${type}\\b`).test(smuggled.source),
      ) &&
      !namesCoverage(smuggled.source) &&
      !exempt.has(smuggled.name);

    // Assert
    expect(offends).toBe(true);
    expect(COVERAGE_EXEMPT_SURFACES.length).toBeLessThanOrEqual(
      COVERAGE_EXEMPT_SURFACES_MAX,
    );
  });

  test("a surface that names coverage only in CODE still passes", () => {
    // Arrange: the control. `briefing/render.ts` spells the field
    // `coverageLine` — a record reaching a renderer, not a prose claim about
    // one — and the old word-boundary pattern did not match it, so that
    // surface was passing on its doc comment alone.
    const real =
      "export interface BriefingInput { readonly coverageLine?: string }\n" +
      "export const render = (input: BriefingInput) => input.coverageLine;\n";

    // Assert
    expect(namesCoverage(real)).toBe(true);
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
      !namesCoverage(smuggled.source) &&
      !exempt.has(smuggled.name);

    // Assert
    expect(offends).toBe(true);
  });
});
