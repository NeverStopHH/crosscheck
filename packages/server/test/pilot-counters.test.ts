/**
 * PROOF 5 — coverage integrity in the wild (1.0 spec 07 §3.5).
 *
 * 03 made every answer surface carry the coverage qualifier. Nothing counted
 * whether it did, and that is the whole sentence of this proof: a rule nobody
 * measures is a rule that quietly stops holding, and the failure looks exactly
 * like success.
 *
 * WHAT IS ASSERTED HERE, and the distinctions are the point:
 *
 *   · counting is gated on ENROLMENT, like every other pilot write;
 *   · `qualifier_required` and `not_judgeable` are DIFFERENT numbers — a
 *     fresh hub is not judgeable and needs no qualifier, and folding them
 *     would report every new install as failing to qualify;
 *   · the five sources are tallied SEPARATELY, because 00 §8.1 forbids a
 *     scalar that collapses them and this storage makes the collapse
 *     unrepresentable;
 *   · the counters are UPSERTS — a second answer on the same day increments,
 *     it does not append a row.
 */
import { describe, expect, test } from "bun:test";

import { pilotCounters } from "../src/db/schema.ts";
import { COVERAGE_SOURCES } from "../src/services/coverage.ts";
import {
  PILOT_ANSWER_SURFACES,
  countCoverageAnswer,
} from "../src/services/pilot.ts";
import type { CoverageRecord } from "../src/services/coverage.ts";
import {
  TEST_ADMIN_TOKEN,
  TEST_START_ISO,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
} from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const REPO = "github.com/acme/api";
const NOW = new Date(TEST_START_ISO);
/** The UTC day the primary key spells, derived rather than typed twice. */
const DAY = TEST_START_ISO.slice(0, 10);

const coverageWith = (
  overrides: Partial<Record<string, string>> = {},
): CoverageRecord => ({
  repo: REPO,
  computedAt: NOW.toISOString(),
  scope: { sinceIso: NOW.toISOString() },
  sources: COVERAGE_SOURCES.map((source) => ({
    source,
    state: (overrides[source] ?? "unknown") as "unknown",
    reason: "hub_did_not_report" as const,
    gapSince: null,
    observedAt: null,
  })),
});

const setup = async (
  options: { readonly enrolled: boolean } = { enrolled: true },
): Promise<TestHarness> => {
  const harness = await createTestHarness();
  await createTestDeveloper(harness, "Nick", "nick-counters@example.com");
  if (options.enrolled) {
    await harness.app.request(
      "/api/team-settings",
      jsonRequest("PUT", TEST_ADMIN_TOKEN, { repo: REPO, pilotEnrolled: true }),
    );
  }
  return harness;
};

const counted = async (
  harness: TestHarness,
): Promise<ReadonlyMap<string, number>> => {
  const rows = await harness.db.select().from(pilotCounters);
  return new Map(rows.map((row) => [row.counter, Number(row.value)]));
};

const count = async (
  harness: TestHarness,
  coverage: CoverageRecord,
): Promise<void> => {
  await countCoverageAnswer(
    { db: harness.db, now: () => NOW },
    { repo: REPO, surface: "api-suspect", coverage },
  );
};

describe("proof 5 counts what 03 made mandatory", () => {
  test("a repo that never enrolled counts nothing", async () => {
    // Arrange
    const harness = await setup({ enrolled: false });

    // Act
    await count(harness, coverageWith());

    // Assert
    expect((await counted(harness)).size).toBe(0);
  });

  test("an answer with no observed gap needs no qualifier — and is still counted", async () => {
    // Arrange — a fresh hub: nothing reported, nothing observed missing.
    const harness = await setup();

    // Act
    await count(harness, coverageWith());

    // Assert
    const tallies = await counted(harness);
    expect(tallies.get("answers_emitted")).toBe(1);
    expect(tallies.has("qualifier_required")).toBe(false);
    // NOT judgeable — agent_event and git are not `complete`. The two
    // conditions are different, and folding them would report every new
    // install as failing to qualify its answers.
    expect(tallies.get("not_judgeable")).toBe(1);
    expect(tallies.has("judgeable")).toBe(false);
  });

  test("an OBSERVED gap requires the qualifier — and no tautological emission is counted", async () => {
    // Arrange — somebody's sessions went quiet: a gap the hub can see.
    const harness = await setup();

    // Act
    await count(harness, coverageWith({ agent_event: "incomplete" }));

    // Assert
    const tallies = await counted(harness);
    expect(tallies.get("qualifier_required")).toBe(1);
    // Written from the same record it would claim to verify, an "emitted"
    // count could only ever equal "required" — so it is not written at all.
    expect(tallies.has("qualifier_emitted")).toBe(false);
  });

  test("a complete record is judgeable and needs no qualifier", async () => {
    // Arrange
    const harness = await setup();

    // Act
    await count(
      harness,
      coverageWith({
        agent_event: "complete",
        git: "complete",
        ci: "unavailable",
        runtime: "unavailable",
        human_edit: "unavailable",
      }),
    );

    // Assert
    const tallies = await counted(harness);
    expect(tallies.get("judgeable")).toBe(1);
    expect(tallies.has("qualifier_required")).toBe(false);
  });

  test("the five sources are tallied SEPARATELY, never collapsed", async () => {
    // Arrange — 00 §8.1 forbids a scalar over the five, and this storage is
    // what makes the collapse unrepresentable rather than discouraged.
    const harness = await setup();

    // Act
    await count(
      harness,
      coverageWith({ agent_event: "complete", git: "incomplete" }),
    );

    // Assert
    const tallies = await counted(harness);
    expect(tallies.get("coverage_agent_event_complete")).toBe(1);
    expect(tallies.get("coverage_git_incomplete")).toBe(1);
    expect(tallies.get("coverage_ci_unknown")).toBe(1);
    // One tally per source, every time — a record can never report four.
    const perSource = [...tallies.keys()].filter((key) =>
      key.startsWith("coverage_"),
    );
    expect(perSource).toHaveLength(COVERAGE_SOURCES.length);
  });

  test("EVERY declared surface is reachable from a route", async () => {
    // A vocabulary with a name nothing writes is a report line that reads
    // zero for ever and looks like a finding. Each of these is grepped for
    // in the routes rather than assumed: the declaration and the call site
    // are in different files, and nothing else holds them together.
    const routes = await Promise.all(
      [
        "packages/server/src/routes/suspect.ts",
        "packages/server/src/routes/absences.ts",
        "packages/server/src/routes/hints.ts",
        "packages/server/src/routes/search.ts",
        "packages/server/src/routes/work-contexts.ts",
      ].map(async (path) => Bun.file(`${import.meta.dir}/../../../${path}`).text()),
    );
    const source = routes.join("\n");

    // Assert
    for (const surface of PILOT_ANSWER_SURFACES) {
      expect(source, surface).toContain(`surface: "${surface}"`);
    }
  });

  test("a second answer the same day INCREMENTS — it does not append", async () => {
    // Arrange — upsert-only is what keeps this table bounded by repos × days
    // × surfaces × counters rather than by traffic.
    const harness = await setup();

    // Act
    await count(harness, coverageWith());
    await count(harness, coverageWith());

    // Assert
    const rows = await harness.db.select().from(pilotCounters);
    expect((await counted(harness)).get("answers_emitted")).toBe(2);
    // Same row, twice the value.
    expect(
      rows.filter((row) => row.counter === "answers_emitted"),
    ).toHaveLength(1);
    expect(rows[0]?.day).toBe(DAY);
  });
});
