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
 *     otherwise it says only "below_minimums" (review M1), with no count. A
 *     team of three never meets them.
 *
 * IT STARTS WHERE OUTCOMES COULD BE RECORDED (the H1 lesson): a delivery from
 * before `pilot_outcomes_since` is outside the population, never "unmarked".
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  HINT_OUTCOME_DISCLOSURE_MINIMUMS,
  PIN_PRESENCE_TERMINAL,
  deliveryIdFor,
  hintDeliveryId,
} from "@crosscheck/schema";

import { lastWholeMonth, readPeriodAggregate } from "../src/services/outcome-population.ts";

import {
  ANNA_CONTEXT,
  ANNA_SESSION,
  LENA_CONTEXT,
  LENA_SESSION,
  SECONDS_TO_AUGUST,
  createCrowd,
  deliverTo,
  labelNoise,
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
  enrol,
  readMine,
  recordOutcome,
  recordPersonOutcome,
} from "./fixtures/hint-outcome-world.ts";
import type { OutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import { TEST_ADMIN_TOKEN, jsonRequest, postRecords, registerTestSession } from "./helpers.ts";

const SECONDS_PER_HOUR = 3600;
const JULY = { periodStartIso: "2026-07-01T00:00:00.000Z", periodEndIso: "2026-08-01T00:00:00.000Z" };
const ENROLLED_ISO = "2026-07-24T09:00:00.000Z";

const NICK_CONTEXT = `wc_${NICK_SESSION}`;
const NICK_THIRD_SESSION = "cc_aaaaaaaa-3333-4333-8333-333333333333";
const MIKE_SECOND = "cc_cccccccc-2222-4222-8222-222222222222";
const ANNA_SECOND = "cc_dddddddd-2222-4222-8222-222222222222";
const LENA_SECOND = "cc_eeeeeeee-2222-4222-8222-222222222222";
const MAIN_SESSIONS = { nick: NICK_SESSION, mike: MIKE_SESSION, anna: ANNA_SESSION, lena: LENA_SESSION } as const;

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
    at: world.harness.clock.now(),
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
      reconstructed: false,
      withheld: null,
      figures: { interventions: 24, followed: 9, overrode: 3, notRelevantNow: 2, noise: 1, unmarked: 9 },
    });
  });

  test("review M-2: a repo that left still reports the closed month it was enrolled for, from its intervals", async () => {
    // Arrange — July's words, then the team leaves on the second of August
    const crowd = await createCrowd();
    await recordCrowdWords(crowd);
    crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);
    await crowd.harness.app.request(
      "/api/team-settings",
      jsonRequest("PUT", TEST_ADMIN_TOKEN, { repo: REPO, pilotEnrolled: false }),
    );

    // Act
    const outcomes = await outcomesOf(crowd);

    // Assert — July had an enrolled interval: never "none could be recorded"
    expect(outcomes).toMatchObject({ ...JULY, withheld: null, countedFromIso: ENROLLED_ISO });
    expect(outcomes["figures"]).toMatchObject({ interventions: 24, followed: 9 });
  });

  test("survivor R5: a month the team left part-way through, never to return, says only its enrolled time was counted", async () => {
    // Arrange — July's words, then the team leaves on 28 July: one interval, ending inside the month
    const crowd = await createCrowd();
    await recordCrowdWords(crowd);
    crowd.harness.clock.advanceSeconds(4 * 86_400);
    await crowd.harness.app.request(
      "/api/team-settings",
      jsonRequest("PUT", TEST_ADMIN_TOKEN, { repo: REPO, pilotEnrolled: false }),
    );
    crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);

    // Act
    const outcomes = await outcomesOf(crowd);

    // Assert
    expect(outcomes).toMatchObject({ ...JULY, pausedInPeriod: true });
  });

  test("review M-3: a month counted over an enrolment an upgrade reconstructed says so — the team line and the credit", async () => {
    // Arrange — the same July, its interval inferred by an upgrade from what was recorded
    const crowd = await createCrowd();
    await recordCrowdWords(crowd);
    await crowd.harness.db.execute(sql`UPDATE pilot_enrolments SET reconstructed = true`);
    crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);

    // Act
    const outcomes = await outcomesOf(crowd);
    const ken = ((await (await readMine(crowd, crowd.ken)).json()) as { data: { yourWork: Record<string, unknown> } }).data;

    // Assert
    expect(outcomes).toMatchObject({ reconstructed: true, withheld: null });
    expect(ken.yourWork).toMatchObject({ followed: 5, reconstructed: true });
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
    expect(outcomes["withheld"]).toBe("below_minimums");
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
    expect(outcomes["withheld"]).toBe("below_minimums");
    expect(outcomes["figures"]).toBeNull();
  });

  test("review M1 (P2): a withheld month names no minimum and carries no count", async () => {
    // Arrange — the review's P2: before M1, "too_few_recorded" with a count of 9 told Nick that
    // Ken and Mike had recorded exactly one word each
    const world = await createOutcomeWorld();
    await postRecords(world.harness, world.ken, {
      records: [deliveryRecord(KEN_SESSION, "work_context", NICK_CONTEXT, "prompt_hint")],
    });
    await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    await recordOutcome(world, world.ken, { ref: NICK_CONTEXT, outcome: "overrode", reason: "kept mine" });
    await recordOutcome(world, world.mike, { ref: KEN_CONTEXT, outcome: "overrode", reason: "kept mine too" });
    world.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);

    // Act
    const outcomes = await outcomesOf(world);

    // Assert — one generic word; no count anywhere in the block
    expect(outcomes["withheld"]).toBe("below_minimums");
    expect(outcomes["figures"]).toBeNull();
    expect(Object.keys(outcomes).sort()).toEqual([
      "countedFromIso",
      "figures",
      "pausedInPeriod",
      "periodEndIso",
      "periodStartIso",
      "reconstructed",
      "recordableSinceIso",
      "withheld",
    ]);
  });

  test("review H1: three people with plenty of words about plenty of work still print nothing", async () => {
    // Arrange — Nick, Mike and Anna each record five; fifteen words about five people's work.
    // Only the people-minimum fails: leaving out any one of them leaves two.
    const crowd = await createCrowd();
    await say(crowd, [
      ["nick", KEN_CONTEXT, "followed"],
      ["nick", KEN_CLAIM, "overrode"],
      ["nick", MIKE_CONTEXT, "followed"],
      ["nick", ANNA_CONTEXT, "followed"],
      ["nick", LENA_CONTEXT, "followed"],
      ["mike", KEN_CONTEXT, "followed"],
      ["mike", KEN_CLAIM, "followed"],
      ["mike", NICK_CONTEXT, "overrode"],
      ["mike", ANNA_CONTEXT, "followed"],
      ["mike", LENA_CONTEXT, "followed"],
      ["anna", KEN_CONTEXT, "followed"],
      ["anna", KEN_CLAIM, "followed"],
      ["anna", NICK_CONTEXT, "followed"],
      ["anna", MIKE_CONTEXT, "overrode"],
      ["anna", LENA_CONTEXT, "followed"],
    ]);
    crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);

    // Act
    const outcomes = await outcomesOf(crowd);

    // Assert
    expect(outcomes["withheld"]).toBe("below_minimums");
    expect(outcomes["figures"]).toBeNull();
  });

  test("review H1 (P7): when, leaving one person out, every other word is about that person's work, no figure prints", async () => {
    // Arrange — Nick, Mike, Anna and Lena speak only about Ken's work, from two sessions each;
    // Ken about theirs. Before H1 this printed, and Ken, subtracting his own four, read how the
    // team treated his work. Only the sources minimum fails: sixteen words remain without Ken.
    const crowd = await createCrowd();
    const seconds = { nick: NICK_SECOND_SESSION, mike: MIKE_SECOND, anna: ANNA_SECOND, lena: LENA_SECOND } as const;
    for (const who of ["nick", "mike", "anna", "lena"] as const) {
      await registerTestSession(crowd.harness, crowd[who].apiKey, { id: seconds[who], repo: REPO });
      await deliverTo(crowd, crowd[who], seconds[who], [
        ["work_context", KEN_CONTEXT],
        ["claim", KEN_CLAIM],
      ]);
      const pointers = [MAIN_SESSIONS[who], seconds[who]].flatMap((session) => [
        deliveryIdFor(session, KEN_CONTEXT, "prompt_hint"),
        deliveryIdFor(session, KEN_CLAIM, "prompt_hint"),
      ]);
      for (const id of pointers) {
        await recordOutcome(crowd, crowd[who], { ref: id, outcome: "followed" });
      }
    }
    await say(crowd, [
      ["ken", NICK_CONTEXT, "followed"],
      ["ken", MIKE_CONTEXT, "not_relevant_now"],
      ["ken", ANNA_CONTEXT, "followed"],
      ["ken", LENA_CONTEXT, "followed"],
    ]);
    crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);

    // Act
    const outcomes = await outcomesOf(crowd);

    // Assert
    expect(outcomes["withheld"]).toBe("below_minimums");
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
    expect(outcomes["withheld"]).toBe("below_minimums");
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
    const interventions = await julyInterventions(world);

    // Assert — the world's four, not five
    expect(interventions).toBe(4);
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
      withheld: "not_recordable",
      figures: null,
    });
    expect(outcomes).not.toHaveProperty("interventions");
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

describe("a pointer across a month boundary (review LOW, probe E)", () => {
  const monthAggregate = async (world: OutcomeWorld): Promise<{ interventions: number; followed: number }> => {
    const month = lastWholeMonth(world.harness.clock.now());
    return await readPeriodAggregate(world.harness.db, {
      repo: REPO,
      from: month.start,
      until: month.end,
      who: sql`true`,
      sourceIs: null,
      at: world.harness.clock.now(),
    });
  };

  test("a July pointer whose tripwire twin arrives in August counts in July only", async () => {
    // Arrange — followed in July; the same pointer asked about again on the first of August
    const world = await createOutcomeWorld();
    await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    world.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);
    const july = await monthAggregate(world);
    await postRecords(world.harness, world.nick, {
      records: [deliveryRecord(NICK_SESSION, "work_context", KEN_CONTEXT, "tripwire", world.harness.clock.now().toISOString())],
    });
    world.harness.clock.advanceSeconds(31 * 86_400);

    // Act
    const august = await monthAggregate(world);

    // Assert — one intervention, counted once, in the month it was first delivered
    expect(july).toMatchObject({ followed: 1 });
    expect(august).toMatchObject({ interventions: 0, followed: 0 });
  });
});

describe("the closed month's edges (review M5: surviving mutations)", () => {
  test("M1: a noise label made after the month never moves the month's figures", async () => {
    // Arrange — a printed July; in August Nick labels a July hint noise, and a minute passes
    const crowd = await createCrowd();
    await recordCrowdWords(crowd);
    crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);
    const before = await outcomesOf(crowd);

    // Act
    await labelNoise(crowd, crowd.nick, crowd.delivered.kenContext);
    crowd.harness.clock.advanceSeconds(60);
    const after = await outcomesOf(crowd);

    // Assert
    expect(before["figures"]).not.toBeNull();
    expect(after).toEqual(before);
  });

  test("M2: a delivery dated after the month ended is not in it, even when the hub got it before", async () => {
    // Arrange — 23:59 on July 31 by the hub's clock; the connector's clock already says August
    const world = await createOutcomeWorld();
    world.harness.clock.advanceSeconds(7 * 86_400 + 14 * SECONDS_PER_HOUR + 59 * 60);
    await postRecords(world.harness, world.mike, {
      records: [deliveryRecord(MIKE_SESSION, "work_context", NICK_CONTEXT, "prompt_hint", "2026-08-01T00:01:00.000Z")],
    });
    world.harness.clock.advanceSeconds(2 * 86_400);

    // Act
    const interventions = await julyInterventions(world);

    // Assert — the world's four July hints, not five
    expect(interventions).toBe(4);
  });

  test("M11: an enrolment that starts exactly at the month's end makes nothing of that month recordable", async () => {
    // Arrange — enrolled at 2026-08-01T00:00:00.000Z sharp; read in August, the closed month is July
    const world = await createOutcomeWorld({ enrolled: false });
    world.harness.clock.advanceSeconds(7 * 86_400 + 15 * SECONDS_PER_HOUR);
    expect(world.harness.clock.now().toISOString()).toBe("2026-08-01T00:00:00.000Z");
    await enrol(world.harness);
    world.harness.clock.advanceSeconds(86_400);

    // Act
    const outcomes = await outcomesOf(world);

    // Assert
    expect(outcomes).toMatchObject({ periodStartIso: "2026-07-01T00:00:00.000Z", withheld: "not_recordable", countedFromIso: null });
  });
});

describe("round-6 HIGH-1: a helpful label lives on the label axis, never deleting an outcome", () => {
  const helpful = async (crowd: Crowd, who: Crowd["nick"], deliveryId: string): Promise<void> => {
    const response = await crowd.harness.app.request(
      "/api/pilot-marks",
      jsonRequest("POST", who.apiKey, {
        repo: REPO,
        refKind: "hint_delivery",
        refId: deliveryId,
        mark: "helpful",
        presence: PIN_PRESENCE_TERMINAL,
      }),
    );
    expect(response.status).toBe(201);
  };

  test("the reviewer's July: helpful under two agent follows and over the person's own override changes no figure", async () => {
    // Arrange — Nick: helpful on Ken's context (his agent said followed); Mike: helpful on Ken's
    // claim (his agent said followed); Nick: his own overrode on Lena's context, THEN helpful
    const crowd = await createCrowd();
    await recordCrowdWords(crowd);
    crowd.harness.clock.advanceSeconds(60);
    await helpful(crowd, crowd.nick, hintDeliveryId(NICK_SESSION, KEN_CONTEXT));
    await helpful(crowd, crowd.mike, hintDeliveryId(MIKE_SESSION, KEN_CLAIM));
    await recordPersonOutcome(crowd, crowd.nick, { ref: LENA_CONTEXT, outcome: "overrode", reason: "kept my own header parser" });
    crowd.harness.clock.advanceSeconds(60);
    await helpful(crowd, crowd.nick, hintDeliveryId(NICK_SESSION, LENA_CONTEXT));
    crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);

    // Act
    const nick = ((await (await readMine(crowd, crowd.nick)).json()) as { data: Record<string, unknown> }).data;
    const ken = ((await (await readMine(crowd, crowd.ken)).json()) as { data: Record<string, unknown> }).data;
    const team = await outcomesOf(crowd);

    // Assert — the agents' follows stay, the person's override and its reason stand, and the
    // credit and the team line keep their figures (before: followed 1, the override gone, both withheld)
    expect(nick).toMatchObject({ received: 5, followed: 2, overrode: 2, notRelevantNow: 1, unmarked: 0 });
    expect(JSON.stringify(nick["reasons"])).toContain("kept my own header parser");
    expect(ken["yourWork"]).toMatchObject({ followed: 5, withheld: null });
    expect(team).toMatchObject({ withheld: null, figures: { followed: 9, overrode: 4, unmarked: 8 } });
  });

  test("the helpful line: the person's own labels, per source, and nothing new reaches the credit or the team line", async () => {
    // Arrange — the same July
    const crowd = await createCrowd();
    await recordCrowdWords(crowd);
    crowd.harness.clock.advanceSeconds(60);
    await helpful(crowd, crowd.nick, hintDeliveryId(NICK_SESSION, KEN_CONTEXT));
    await helpful(crowd, crowd.mike, hintDeliveryId(MIKE_SESSION, KEN_CLAIM));
    await recordPersonOutcome(crowd, crowd.nick, { ref: LENA_CONTEXT, outcome: "overrode", reason: "kept my own header parser" });
    crowd.harness.clock.advanceSeconds(60);
    await helpful(crowd, crowd.nick, hintDeliveryId(NICK_SESSION, LENA_CONTEXT));
    crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);

    // Act
    const nick = ((await (await readMine(crowd, crowd.nick)).json()) as { data: Record<string, unknown> }).data;
    const ken = ((await (await readMine(crowd, crowd.ken)).json()) as { data: Record<string, unknown> }).data;
    const team = await outcomesOf(crowd);

    // Assert — Nick's two labels on his own line; Mike's label is Mike's alone; neither the
    // credit nor the team line carries a helpful count
    const sources = nick["bySource"] as readonly { readonly source: string; readonly helpful: number }[];
    expect(nick["helpful"]).toBe(2);
    expect(sources.map((row) => [row.source, row.helpful])).toEqual([["Anna", 0], ["Ken", 1], ["Lena", 1], ["Mike", 0]]);
    expect(ken["helpful"]).toBe(0);
    expect(JSON.stringify(ken["yourWork"])).not.toContain("helpful");
    expect(JSON.stringify(team)).not.toContain("helpful");
  });
});

describe("labels are append-only (review H-B)", () => {
  test("probe A: Mike's July noise label, said again in August over an August word, never moves July", async () => {
    // Arrange — a printed July that holds Mike's July noise label on his pointer at Nick's work
    const crowd = await createCrowd();
    await recordCrowdWords(crowd);
    crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);
    const before = await outcomesOf(crowd);

    // Act — in August a word lands on that pointer, and Mike says noise again
    await recordOutcome(crowd, crowd.mike, { ref: NICK_CONTEXT, outcome: "followed" });
    crowd.harness.clock.advanceSeconds(60);
    await labelNoise(crowd, crowd.mike, hintDeliveryId(MIKE_SESSION, NICK_CONTEXT));
    crowd.harness.clock.advanceSeconds(60);
    const after = await outcomesOf(crowd);

    // Assert — the restamp moved July (noise 1 → 0); a new row never does
    expect(before["figures"]).toMatchObject({ noise: 1 });
    expect(after).toEqual(before);
  });

  test("a re-assertion made in August is read from August on — July keeps the word that stood at its end", async () => {
    // Arrange — in July, after Mike's noise label, Mike's own newer word on that pointer stood: followed
    const crowd = await createCrowd();
    await recordCrowdWords(crowd);
    crowd.harness.clock.advanceSeconds(60);
    await recordPersonOutcome(crowd, crowd.mike, { ref: NICK_CONTEXT, outcome: "followed" });
    crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);
    const before = await outcomesOf(crowd);

    // Act — in August Mike says noise again
    await labelNoise(crowd, crowd.mike, hintDeliveryId(MIKE_SESSION, NICK_CONTEXT));
    crowd.harness.clock.advanceSeconds(60);
    const after = await outcomesOf(crowd);

    // Assert
    expect(before["figures"]).toMatchObject({ noise: 0 });
    expect(after).toEqual(before);
  });
});
