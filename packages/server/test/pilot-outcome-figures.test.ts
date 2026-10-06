/**
 * The team report's one descriptive outcomes line (1.0 spec 07 §13.9, D-O5;
 * review finding #4).
 *
 * Per repo, per 100 interventions that reached someone: followed, overrode,
 * not relevant now, noise (the label), unmarked. No target, and nobody named.
 *
 * NO DIFFERENCE MAY SINGLE SOMEBODY OUT. The review subtracted a person's own
 * `--mine` from a two-recipient team total and read a teammate's exact
 * outcomes; an author read the overrides of their own work. So the block:
 *
 *   · covers ONE FIXED, CLOSED PERIOD — the last whole calendar month (UTC) —
 *     whatever `days` the report was asked for, frozen as it stood at the
 *     month's end, so no window can be stepped or watched to isolate a day;
 *   · prints figures only when at least three people recorded words, about at
 *     least three people's work, ten words or more — otherwise it says which
 *     minimum was not met, and no figure.
 *
 * IT STARTS WHERE OUTCOMES COULD BE RECORDED (the H1 lesson): a delivery from
 * before `pilot_outcomes_since` is outside the population, never "unmarked".
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { HINT_OUTCOME_DISCLOSURE_MINIMUMS } from "@crosscheck/schema";

import { lastWholeMonth, readPeriodAggregate } from "../src/services/outcome-population.ts";

import {
  ANNA_SESSION,
  SECONDS_TO_AUGUST,
  createCrowd,
  recordTenWords,
} from "./fixtures/hint-outcome-crowd.ts";
import {
  KEN_CLAIM,
  KEN_CONTEXT,
  MIKE_SESSION,
  NICK_SESSION,
  REPO,
  createOutcomeWorld,
  deliveryRecord,
  recordOutcome,
} from "./fixtures/hint-outcome-world.ts";
import type { OutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import { TEST_ADMIN_TOKEN, jsonRequest, postRecords } from "./helpers.ts";

const SECONDS_PER_HOUR = 3600;
const JULY = { periodStartIso: "2026-07-01T00:00:00.000Z", periodEndIso: "2026-08-01T00:00:00.000Z" };
const ENROLLED_ISO = "2026-07-24T09:00:00.000Z";

const NICK_CONTEXT = `wc_${NICK_SESSION}`;

/** July's interventions as the closed month reads them — below the rendering, so no minimum hides it. */
const julyInterventions = async (world: OutcomeWorld): Promise<number> => {
  const july = lastWholeMonth(world.harness.clock.now());
  const aggregate = await readPeriodAggregate(world.harness.db, {
    repo: REPO,
    from: july.start,
    until: july.end,
    who: sql`true`,
    sourceIs: null,
  });
  return aggregate.interventions;
};

const outcomesOf = async (world: OutcomeWorld, days?: number): Promise<Record<string, unknown>> => {
  const window = days === undefined ? "" : `&days=${String(days)}`;
  const response = await world.harness.app.request(
    `/api/pilot/report?repo=${encodeURIComponent(REPO)}${window}`,
    jsonRequest("GET", world.nick.apiKey),
  );
  return ((await response.json()) as { data: { outcomes: Record<string, unknown> } }).data.outcomes;
};

describe("the team report's outcomes block (D-O5, review #4)", () => {
  test("a big enough team gets figures for the last whole month, counted from when outcomes became recordable", async () => {
    // Arrange — three people, ten words, four people's work, all in July
    const crowd = await createCrowd();
    await recordTenWords(crowd);
    crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);

    // Act
    const outcomes = await outcomesOf(crowd);

    // Assert
    expect(outcomes).toEqual({
      ...JULY,
      recordableSinceIso: ENROLLED_ISO,
      countedFromIso: ENROLLED_ISO,
      interventions: 11,
      withheld: null,
      figures: { followed: 6, overrode: 2, notRelevantNow: 1, noise: 1, unmarked: 1 },
    });
  });

  test("the month is frozen at its end: a word said after it never moves the figures", async () => {
    // Arrange
    const crowd = await createCrowd();
    await recordTenWords(crowd, { skip: false });
    crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);
    const before = await outcomesOf(crowd);

    // Act — Nick changes his mind in August about a July hint, and a minute passes
    await recordOutcome(crowd, crowd.nick, { ref: KEN_CLAIM, outcome: "followed" });
    crowd.harness.clock.advanceSeconds(60);
    const after = await outcomesOf(crowd);

    // Assert
    expect(after).toEqual(before);
  });

  test("the block ignores the report's window: no `days` can be stepped to isolate a day", async () => {
    // Arrange
    const crowd = await createCrowd();
    await recordTenWords(crowd);
    crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);

    // Act
    const narrow = await outcomesOf(crowd, 1);
    const wide = await outcomesOf(crowd, 90);

    // Assert
    expect(narrow).toEqual(wide);
  });

  test("two recipients — team minus my own view would be the other's — print no figure", async () => {
    // Arrange — the review's probe: Nick and Mike, Ken the author
    const world = await createOutcomeWorld();
    await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    await recordOutcome(world, world.mike, { ref: KEN_CONTEXT, outcome: "overrode", reason: "kept mine" });
    world.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);

    // Act
    const outcomes = await outcomesOf(world);

    // Assert
    expect(outcomes["withheld"]).toBe("too_few_recorders");
    expect(outcomes["figures"]).toBeNull();
    expect(HINT_OUTCOME_DISCLOSURE_MINIMUMS.recorders).toBe(3);
  });

  test("words that are all about one author's work print no figure — an author never reads their overrides", async () => {
    // Arrange — three recorders, every word about Ken's work
    const crowd = await createCrowd();
    await postRecords(crowd.harness, crowd.anna, {
      records: [deliveryRecord(ANNA_SESSION, "claim", KEN_CLAIM, "prompt_hint")],
    });
    for (const [developer, ref, outcome] of [
      [crowd.nick, KEN_CONTEXT, "followed"],
      [crowd.nick, KEN_CLAIM, "followed"],
      [crowd.mike, KEN_CONTEXT, "followed"],
      [crowd.mike, KEN_CLAIM, "followed"],
      [crowd.anna, KEN_CONTEXT, "followed"],
      [crowd.anna, KEN_CLAIM, "not_relevant_now"],
    ] as const) {
      await recordOutcome(crowd, developer, { ref, outcome });
    }
    crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);

    // Act
    const outcomes = await outcomesOf(crowd);

    // Assert
    expect(outcomes["withheld"]).toBe("too_few_sources");
    expect(outcomes["figures"]).toBeNull();
  });

  test("fewer than ten recorded words print no figure", async () => {
    // Arrange
    const crowd = await createCrowd();
    await recordTenWords(crowd, { skip: true });
    crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);

    // Act
    const outcomes = await outcomesOf(crowd);

    // Assert
    expect(outcomes["withheld"]).toBe("too_few_recorded");
    expect(outcomes["figures"]).toBeNull();
  });

  test("a month that ended before outcomes became recordable is not recordable, and says when they became so", async () => {
    // Arrange — enrolled 2026-07-24; the last whole month is June
    const world = await createOutcomeWorld();

    // Act
    const outcomes = await outcomesOf(world);

    // Assert
    expect(outcomes).toMatchObject({
      periodStartIso: "2026-06-01T00:00:00.000Z",
      recordableSinceIso: ENROLLED_ISO,
      countedFromIso: null,
      withheld: "not_recordable",
      figures: null,
    });
  });

  test("a delivery from before the repo could record outcomes is outside the population", async () => {
    // Arrange — one more pointer, an hour before enrolment stamped the instant
    const world = await createOutcomeWorld();
    const earlier = new Date(world.harness.clock.now().getTime() - SECONDS_PER_HOUR * 1000).toISOString();
    await postRecords(world.harness, world.nick, {
      records: [deliveryRecord(NICK_SESSION, "work_context", "wc_old_pointer", "prompt_hint", earlier)],
    });
    world.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);

    // Act
    const outcomes = await outcomesOf(world);

    // Assert — the world's four, not five
    expect(outcomes["interventions"]).toBe(4);
    expect(MIKE_SESSION).toBeDefined();
  });

  test("a repo nobody enrolled has no instant and no figure", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: false });

    // Act
    const outcomes = await outcomesOf(world);

    // Assert
    expect(outcomes).toMatchObject({
      recordableSinceIso: null,
      countedFromIso: null,
      interventions: 0,
      withheld: "not_recordable",
      figures: null,
    });
  });

  test("enrolment stamps when outcomes became recordable, and a re-enrolment restamps it", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    const first = world.harness.clock.now().toISOString();
    const put = (pilotEnrolled: boolean) =>
      world.harness.app.request(
        "/api/team-settings",
        jsonRequest("PUT", TEST_ADMIN_TOKEN, { repo: REPO, pilotEnrolled }),
      );
    const read = async (): Promise<unknown> =>
      ((await (await world.harness.app.request(
        `/api/team-settings?repo=${encodeURIComponent(REPO)}`,
        jsonRequest("GET", world.nick.apiKey),
      )).json()) as { data: Record<string, unknown> }).data["pilotOutcomesSince"];

    // Act
    const atEnrolment = await read();
    world.harness.clock.advanceSeconds(SECONDS_PER_HOUR);
    await put(false);
    const afterLeaving = await read();
    world.harness.clock.advanceSeconds(SECONDS_PER_HOUR);
    await put(true);
    const afterReturning = await read();

    // Assert
    expect(atEnrolment).toBe(first);
    expect(afterLeaving).toBe(first);
    expect(afterReturning).toBe(world.harness.clock.now().toISOString());
  });
});

describe("a closed month is frozen against late ingest (review P5)", () => {
  test("a delivery dated in July but reaching the hub in August is never read into July", async () => {
    // Arrange — four July deliveries; then August, and Mike's connector sends a late one
    const world = await createOutcomeWorld();
    world.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);
    const before = await julyInterventions(world);

    // Act
    await postRecords(world.harness, world.mike, {
      records: [deliveryRecord(MIKE_SESSION, "work_context", NICK_CONTEXT, "prompt_hint", "2026-07-31T23:00:00.000Z")],
    });
    const after = await julyInterventions(world);

    // Assert — a closed month read twice reads the same
    expect(before).toBe(4);
    expect(after).toBe(before);
  });
});
