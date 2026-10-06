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
 *   · prints figures only when, leaving out ANY one person's words — the
 *     viewer's own included, whoever views it (review H1) — at least three
 *     people's words about at least three people's work, ten or more, remain;
 *     otherwise it says which minimum was not met, and no figure. A team of
 *     three never meets them.
 *
 * IT STARTS WHERE OUTCOMES COULD BE RECORDED (the H1 lesson): a delivery from
 * before `pilot_outcomes_since` is outside the population, never "unmarked".
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { HINT_OUTCOME_DISCLOSURE_MINIMUMS, deliveryIdFor } from "@crosscheck/schema";

import { lastWholeMonth, readPeriodAggregate } from "../src/services/outcome-population.ts";

import {
  ANNA_CONTEXT,
  LENA_CONTEXT,
  SECONDS_TO_AUGUST,
  createCrowd,
  recordCrowdWords,
} from "./fixtures/hint-outcome-crowd.ts";
import type { Crowd } from "./fixtures/hint-outcome-crowd.ts";
import {
  KEN_CLAIM,
  KEN_CONTEXT,
  KEN_SESSION,
  MIKE_CONTEXT,
  MIKE_SESSION,
  NICK_SECOND_SESSION,
  NICK_SESSION,
  REPO,
  createOutcomeWorld,
  deliveryRecord,
  recordOutcome,
} from "./fixtures/hint-outcome-world.ts";
import type { OutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import { TEST_ADMIN_TOKEN, jsonRequest, postRecords, registerTestSession } from "./helpers.ts";

const SECONDS_PER_HOUR = 3600;
const JULY = { periodStartIso: "2026-07-01T00:00:00.000Z", periodEndIso: "2026-08-01T00:00:00.000Z" };
const ENROLLED_ISO = "2026-07-24T09:00:00.000Z";

const NICK_CONTEXT = `wc_${NICK_SESSION}`;
const NICK_THIRD_SESSION = "cc_aaaaaaaa-3333-4333-8333-333333333333";

/** Words in the crowd, one per pointer, as [who, ref, outcome]. */
const say = async (
  crowd: Crowd,
  words: readonly (readonly [keyof Pick<Crowd, "nick" | "ken" | "mike" | "anna" | "lena">, string, string])[],
): Promise<void> => {
  for (const [who, ref, outcome] of words) {
    const reason = outcome === "overrode" ? { reason: "went another way" } : {};
    await recordOutcome(crowd, crowd[who], { ref, outcome, ...reason });
  }
};

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
    // Arrange — four people, fifteen words, five people's work, all in July
    const crowd = await createCrowd();
    await recordCrowdWords(crowd);
    crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);

    // Act
    const outcomes = await outcomesOf(crowd);

    // Assert
    expect(outcomes).toEqual({
      ...JULY,
      recordableSinceIso: ENROLLED_ISO,
      countedFromIso: ENROLLED_ISO,
      pausedInPeriod: false,
      interventions: 24,
      withheld: null,
      figures: { followed: 9, overrode: 3, notRelevantNow: 2, noise: 1, unmarked: 9 },
    });
  });

  test("the month is frozen at its end: a word said after it never moves the figures", async () => {
    // Arrange
    const crowd = await createCrowd();
    await recordCrowdWords(crowd);
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
    await recordCrowdWords(crowd);
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

  test("review H1 (P1): in a team of three, a viewer who pads the words minimum still reads no figure", async () => {
    // Arrange — Nick follows eight of Ken's and Mike's pointers across three sessions;
    // Ken and Mike override one each. Before H1 the line printed "followed 8 · overrode 2",
    // and Nick, subtracting his own eight, knew both teammates had overridden once.
    const crowd = await createOutcomeWorld();
    for (const session of [NICK_SECOND_SESSION, NICK_THIRD_SESSION]) {
      await registerTestSession(crowd.harness, crowd.nick.apiKey, { id: session, repo: REPO });
      await postRecords(crowd.harness, crowd.nick, {
        records: [
          deliveryRecord(session, "work_context", KEN_CONTEXT, "prompt_hint"),
          deliveryRecord(session, "claim", KEN_CLAIM, "prompt_hint"),
          deliveryRecord(session, "work_context", MIKE_CONTEXT, "prompt_hint"),
        ],
      });
    }
    await postRecords(crowd.harness, crowd.ken, {
      records: [deliveryRecord(KEN_SESSION, "work_context", NICK_CONTEXT, "prompt_hint")],
    });
    const nickPointers = [NICK_SESSION, NICK_SECOND_SESSION, NICK_THIRD_SESSION].flatMap((session) =>
      [KEN_CONTEXT, KEN_CLAIM, MIKE_CONTEXT].map((ref) => deliveryIdFor(session, ref, "prompt_hint")),
    );
    for (const id of nickPointers.slice(0, 8)) {
      await recordOutcome(crowd, crowd.nick, { ref: id, outcome: "followed" });
    }
    await recordOutcome(crowd, crowd.ken, { ref: NICK_CONTEXT, outcome: "overrode", reason: "kept mine" });
    await recordOutcome(crowd, crowd.mike, { ref: KEN_CONTEXT, outcome: "overrode", reason: "kept mine too" });
    crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);

    // Act
    const outcomes = await outcomesOf(crowd);

    // Assert — leaving Nick out, only two people's words remain
    expect(outcomes["withheld"]).toBe("too_few_recorders");
    expect(outcomes["figures"]).toBeNull();
  });

  test("review H1 (P7): when, leaving one person out, every other word is about that person's work, no figure prints", async () => {
    // Arrange — Nick, Mike, Anna and Lena speak only about Ken's work; Ken about theirs.
    // Before H1 this printed, and Ken, subtracting his own four, read how the team treated his work.
    const crowd = await createCrowd();
    await say(crowd, [
      ["nick", KEN_CONTEXT, "followed"],
      ["nick", KEN_CLAIM, "overrode"],
      ["mike", KEN_CONTEXT, "overrode"],
      ["mike", KEN_CLAIM, "followed"],
      ["anna", KEN_CONTEXT, "followed"],
      ["anna", KEN_CLAIM, "followed"],
      ["lena", KEN_CONTEXT, "followed"],
      ["lena", KEN_CLAIM, "overrode"],
      ["ken", NICK_CONTEXT, "followed"],
      ["ken", MIKE_CONTEXT, "not_relevant_now"],
      ["ken", ANNA_CONTEXT, "followed"],
      ["ken", LENA_CONTEXT, "followed"],
    ]);
    crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);

    // Act
    const outcomes = await outcomesOf(crowd);

    // Assert
    expect(outcomes["withheld"]).toBe("too_few_sources");
    expect(outcomes["figures"]).toBeNull();
  });

  test("review H1: when one person said most of it, the rest is too little to print", async () => {
    // Arrange — Nick five words, three others two each: eleven, but six without Nick
    const crowd = await createCrowd();
    await say(crowd, [
      ["nick", KEN_CONTEXT, "followed"],
      ["nick", KEN_CLAIM, "followed"],
      ["nick", MIKE_CONTEXT, "followed"],
      ["nick", ANNA_CONTEXT, "followed"],
      ["nick", LENA_CONTEXT, "followed"],
      ["mike", KEN_CONTEXT, "overrode"],
      ["mike", ANNA_CONTEXT, "followed"],
      ["anna", MIKE_CONTEXT, "followed"],
      ["anna", NICK_CONTEXT, "overrode"],
      ["lena", KEN_CONTEXT, "followed"],
      ["lena", NICK_CONTEXT, "followed"],
    ]);
    crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);

    // Act
    const outcomes = await outcomesOf(crowd);

    // Assert
    expect(outcomes["withheld"]).toBe("too_few_recorded");
    expect(outcomes["figures"]).toBeNull();
    expect(HINT_OUTCOME_DISCLOSURE_MINIMUMS).toEqual({ recorders: 3, sources: 3, recorded: 10 });
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

  test("review M3: enrolment stamps when outcomes first became recordable, and a re-enrolment never restamps it", async () => {
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
    expect(afterReturning).toBe(first);
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

describe("enrolment history (review M3)", () => {
  const put = async (world: OutcomeWorld, pilotEnrolled: boolean): Promise<Response> =>
    await world.harness.app.request("/api/team-settings", jsonRequest("PUT", TEST_ADMIN_TOKEN, { repo: REPO, pilotEnrolled }));

  test("a delivery from while the pilot was paused is outside the month, the rest of it inside", async () => {
    // Arrange — four deliveries at enrolment; paused an hour later; one delivery in the pause; re-enrolled
    const world = await createOutcomeWorld();
    world.harness.clock.advanceSeconds(SECONDS_PER_HOUR);
    await put(world, false);
    world.harness.clock.advanceSeconds(SECONDS_PER_HOUR);
    await postRecords(world.harness, world.mike, {
      records: [deliveryRecord(MIKE_SESSION, "work_context", NICK_CONTEXT, "prompt_hint", world.harness.clock.now().toISOString())],
    });
    world.harness.clock.advanceSeconds(SECONDS_PER_HOUR);
    await put(world, true);
    world.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);

    // Act
    const interventions = await julyInterventions(world);
    const block = await outcomesOf(world);

    // Assert — counted only while enrolled, and the block says the month had a pause
    expect(interventions).toBe(4);
    expect(block).toMatchObject({ recordableSinceIso: ENROLLED_ISO, countedFromIso: ENROLLED_ISO, pausedInPeriod: true });
  });

  test("a month the pilot was paused through is not recordable, and says when outcomes first became recordable", async () => {
    // Arrange — enrolled 2026-07-24, paused the same day, re-enrolled in September
    const world = await createOutcomeWorld();
    world.harness.clock.advanceSeconds(SECONDS_PER_HOUR);
    await put(world, false);
    world.harness.clock.advanceSeconds(40 * 86_400);
    await put(world, true);

    // Act — read in September: August is the closed month
    const block = await outcomesOf(world);

    // Assert
    expect(block).toMatchObject({
      periodStartIso: "2026-08-01T00:00:00.000Z",
      recordableSinceIso: ENROLLED_ISO,
      countedFromIso: null,
      withheld: "not_recordable",
    });
  });
});
