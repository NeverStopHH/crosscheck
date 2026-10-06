/**
 * GET /api/hint-outcomes/mine — one person's own hint outcomes (07 §13).
 *
 * "How often did crosscheck help me, from whom, and why — and how often did I
 * get the hint and still do it my way?" Answered for the CALLER and nobody
 * else: there is no parameter that names a person, so the view of someone
 * else cannot be asked for (§8.4 still refuses a per-developer breakdown of
 * the team). What a teammate learns is one count about their OWN work — how
 * often others followed it — with no name, no reason and no override beside it.
 *
 * NOISE IS THE LABEL. The view reads it from `pilot_marks`, the one noise
 * concept there is, and the later of an outcome and a noise label stands.
 */
import { describe, expect, test } from "bun:test";
import { PIN_PRESENCE_TERMINAL } from "@crosscheck/schema";

import { pilotMarks } from "../src/db/schema.ts";
import {
  KEN_CLAIM,
  KEN_CONTEXT,
  MIKE_CONTEXT,
  NICK_SESSION,
  REPO,
  createOutcomeWorld,
  deliveryRecord,
  readMine,
  recordOutcome,
  recordPersonOutcome,
} from "./fixtures/hint-outcome-world.ts";
import type { OutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import { SECONDS_TO_AUGUST, createCrowd, recordCrowdWords } from "./fixtures/hint-outcome-crowd.ts";
import { TEST_ADMIN_TOKEN, jsonRequest, postRecords, registerTestSession } from "./helpers.ts";
import type { TestDeveloper } from "./helpers.ts";

const SECONDS_PER_DAY = 86_400;
const KEN_SECOND_SESSION = "cc_bbbbbbbb-2222-4222-8222-222222222222";
const JULY = { periodStartIso: "2026-07-01T00:00:00.000Z", periodEndIso: "2026-08-01T00:00:00.000Z" };
const OVERRIDE_REASON = "kept the developer key; the repo key mixes two people's caches";

const viewOf = async (response: Response): Promise<Record<string, unknown>> =>
  ((await response.json()) as { data: Record<string, unknown> }).data;

const labelNoise = async (
  world: OutcomeWorld,
  developer: TestDeveloper,
  deliveryId: string,
): Promise<Response> =>
  await world.harness.app.request(
    "/api/pilot-marks",
    jsonRequest("POST", developer.apiKey, {
      repo: REPO,
      refKind: "hint_delivery",
      refId: deliveryId,
      mark: "noise",
      presence: PIN_PRESENCE_TERMINAL,
    }),
  );

const tally = (counts: Partial<Record<string, number>>): Record<string, number> => ({
  received: 0,
  followed: 0,
  overrode: 0,
  notRelevantNow: 0,
  noise: 0,
  unmarked: 0,
  ...counts,
});

describe("GET /api/hint-outcomes/mine", () => {
  test("a person sees what reached them, what each led to, and from whom", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    await recordOutcome(world, world.nick, { ref: KEN_CLAIM, outcome: "overrode", reason: OVERRIDE_REASON });
    await labelNoise(world, world.nick, world.delivered.mikeContext);

    // Act
    const view = await viewOf(await readMine(world, world.nick));

    // Assert
    expect(view).toMatchObject(tally({ received: 3, followed: 1, overrode: 1, noise: 1 }));
    expect(view["bySource"]).toEqual([
      { source: "Ken", ...tally({ received: 2, followed: 1, overrode: 1 }) },
      { source: "Mike", ...tally({ received: 1, noise: 1 }) },
    ]);
    expect(view["reasons"]).toEqual([{ outcome: "overrode", reason: OVERRIDE_REASON, source: "Ken" }]);
  });

  test("what nobody said anything about is unmarked, never a verdict", async () => {
    // Arrange
    const world = await createOutcomeWorld();

    // Act
    const view = await viewOf(await readMine(world, world.nick));

    // Assert
    expect(view).toMatchObject(tally({ received: 3, unmarked: 3 }));
  });

  test("the later word stands, between two outcomes and across the noise label", async () => {
    // Arrange — Ken's context: followed, then labelled noise by the person.
    // Mike's context: labelled noise, then the person said it was followed (their own later word).
    // Ken's claim: not relevant now, then overrode with a reason.
    const world = await createOutcomeWorld();
    await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed", reason: "reused it" });
    await labelNoise(world, world.nick, world.delivered.mikeContext);
    await recordOutcome(world, world.nick, { ref: KEN_CLAIM, outcome: "not_relevant_now", reason: "later" });
    world.harness.clock.advanceSeconds(60);
    await labelNoise(world, world.nick, world.delivered.kenContext);
    await recordPersonOutcome(world, world.nick, { ref: MIKE_CONTEXT, outcome: "followed" });
    await recordOutcome(world, world.nick, { ref: KEN_CLAIM, outcome: "overrode", reason: OVERRIDE_REASON });

    // Act
    const view = await viewOf(await readMine(world, world.nick));

    // Assert — and a superseded word's reason is not printed as current
    expect(view).toMatchObject(tally({ received: 3, followed: 1, overrode: 1, noise: 1 }));
    expect(view["reasons"]).toEqual([{ outcome: "overrode", reason: OVERRIDE_REASON, source: "Ken" }]);
  });

  test("an older hub's off_target mark is read as the noise it meant", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    await world.harness.db.insert(pilotMarks).values({
      id: "pm_legacy",
      repo: REPO,
      refKind: "hint_delivery",
      refId: world.delivered.kenClaim,
      mark: "off_target",
      markedBy: world.nick.developerId,
      captureMode: "human",
      createdAt: world.harness.clock.now(),
      reason: null,
    });

    // Act
    const view = await viewOf(await readMine(world, world.nick));

    // Assert
    expect(view).toMatchObject(tally({ received: 3, noise: 1, unmarked: 2 }));
  });

  test("nobody else's deliveries or outcomes reach my view", async () => {
    // Arrange — Mike follows the pointer HE got; Ken got nothing
    const world = await createOutcomeWorld();
    await recordOutcome(world, world.mike, { ref: KEN_CONTEXT, outcome: "followed" });

    // Act
    const nick = await viewOf(await readMine(world, world.nick));
    const ken = await viewOf(await readMine(world, world.ken));

    // Assert
    expect(nick).toMatchObject(tally({ received: 3, unmarked: 3 }));
    expect(ken).toMatchObject(tally({}));
    expect(ken["bySource"]).toEqual([]);
  });

  test("review #10, H1: a teammate's credit is the last whole month's follows, once 4 people recorded about their work — nothing about who or why", async () => {
    // Arrange — Nick, Mike, Anna and Lena each said something about Ken's work in July
    const crowd = await createCrowd();
    await recordCrowdWords(crowd);
    crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);

    // Act
    const ken = await viewOf(await readMine(crowd, crowd.ken));

    // Assert — one count; no teammate's reason about Ken's work reaches him
    expect(ken["yourWork"]).toEqual({ ...JULY, followed: 5, withheld: null });
    expect(JSON.stringify(ken)).not.toContain("kept my own cache key");
  });

  test("review H1: three people's words about a teammate's work print no count — leaving one out leaves two", async () => {
    // Arrange — Nick, Mike and Anna speak about Ken's work; Lena, who got it too, says nothing
    const crowd = await createCrowd();
    await recordOutcome(crowd, crowd.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    await recordOutcome(crowd, crowd.mike, { ref: KEN_CONTEXT, outcome: "followed" });
    await recordOutcome(crowd, crowd.anna, { ref: KEN_CONTEXT, outcome: "overrode", reason: OVERRIDE_REASON });
    crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);

    // Act
    const ken = await viewOf(await readMine(crowd, crowd.ken));

    // Assert — before H1 this printed "followed 2", and Ken, told by Nick what Nick said, knew Anna's
    expect(ken["yourWork"]).toEqual({ ...JULY, followed: null, withheld: "below_minimums" });
  });

  test("review #10: two people's words about a teammate's work print no count — a switch would show as a step", async () => {
    // Arrange — only Nick and Mike received Ken's work
    const world = await createOutcomeWorld();
    await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    await recordOutcome(world, world.nick, { ref: KEN_CLAIM, outcome: "overrode", reason: OVERRIDE_REASON });
    await recordOutcome(world, world.mike, { ref: KEN_CONTEXT, outcome: "followed" });
    world.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);

    // Act
    const ken = await viewOf(await readMine(world, world.ken));

    // Assert
    expect(ken["yourWork"]).toEqual({ ...JULY, followed: null, withheld: "below_minimums" });
    expect(JSON.stringify(ken)).not.toContain(OVERRIDE_REASON);
  });

  test("review #10: a word changed after the month never moves the credit", async () => {
    // Arrange — the review's P3: Ken's count dropped the moment Nick switched
    const crowd = await createCrowd();
    await recordCrowdWords(crowd);
    crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);
    const before = (await viewOf(await readMine(crowd, crowd.ken)))["yourWork"];

    // Act — and a minute passes, so the switch lies strictly in the past
    await recordOutcome(crowd, crowd.nick, { ref: KEN_CONTEXT, outcome: "overrode", reason: OVERRIDE_REASON });
    crowd.harness.clock.advanceSeconds(60);
    const after = (await viewOf(await readMine(crowd, crowd.ken)))["yourWork"];

    // Assert
    expect(after).toEqual(before);
  });

  test("review #10: while the first recordable month is still open there is no credit, and it says why", async () => {
    // Arrange — enrolled 2026-07-24; July has not ended, June was never recordable
    const crowd = await createCrowd();
    await recordCrowdWords(crowd);

    // Act
    const ken = await viewOf(await readMine(crowd, crowd.ken));

    // Assert
    expect(ken["yourWork"]).toEqual({
      periodStartIso: "2026-06-01T00:00:00.000Z",
      periodEndIso: "2026-07-01T00:00:00.000Z",
      followed: null,
      withheld: "not_recordable",
    });
  });

  test("review M4 (P6): one pointer delivered twice in a session is one hint, and one outcome covers it", async () => {
    // Arrange — Ken's context reached Nick's session as a prompt hint AND as a tripwire ask
    const world = await createOutcomeWorld();
    await postRecords(world.harness, world.nick, {
      records: [deliveryRecord(NICK_SESSION, "work_context", KEN_CONTEXT, "tripwire")],
    });

    // Act — one word on the pointer
    await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed", session: NICK_SESSION });
    const view = await viewOf(await readMine(world, world.nick));

    // Assert — Ken's context and claim: two hints from Ken, the context followed, nothing left unmarked of it
    const fromKen = (view["bySource"] as Record<string, unknown>[]).find((source) => source["source"] === "Ken");
    expect(fromKen).toEqual({ source: "Ken", ...tally({ received: 2, followed: 1, unmarked: 1 }) });
    expect(view).toMatchObject(tally({ received: 3, followed: 1, unmarked: 2 }));
  });

  test("a hint delivered before the repo could record outcomes is outside my view, not unmarked", async () => {
    // Arrange — a pointer delivered an hour before enrolment stamped the instant
    const world = await createOutcomeWorld();
    const earlier = new Date(world.harness.clock.now().getTime() - 3_600_000).toISOString();
    await postRecords(world.harness, world.nick, {
      records: [deliveryRecord(NICK_SESSION, "work_context", "wc_old_pointer", "prompt_hint", earlier)],
    });

    // Act
    const view = await viewOf(await readMine(world, world.nick));

    // Assert
    expect(view).toMatchObject(tally({ received: 3, unmarked: 3 }));
  });

  test("the window bounds what is counted", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    world.harness.clock.advanceSeconds(3 * SECONDS_PER_DAY);

    // Act
    const narrow = await viewOf(await readMine(world, world.nick, `repo=${encodeURIComponent(REPO)}&days=1`));
    const wide = await viewOf(await readMine(world, world.nick, `repo=${encodeURIComponent(REPO)}&days=7`));

    // Assert
    expect(narrow).toMatchObject({ days: 1, received: 0 });
    expect(wide).toMatchObject({ days: 7, received: 3 });
  });

  test("a repo nobody enrolled has no view, and says so", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: false });

    // Act
    const response = await readMine(world, world.nick);

    // Assert
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("not_enrolled");
  });
});

describe("enrolment history in the person's own view (review M3, P4)", () => {
  const put = async (world: OutcomeWorld, pilotEnrolled: boolean): Promise<Response> =>
    await world.harness.app.request("/api/team-settings", jsonRequest("PUT", TEST_ADMIN_TOKEN, { repo: REPO, pilotEnrolled }));

  test("a pause and a re-enrolment never erase what was recorded before them", async () => {
    // Arrange — Nick overrode Ken's claim in July; in August the repo leaves the pilot and comes back
    const world = await createOutcomeWorld();
    await recordOutcome(world, world.nick, { ref: KEN_CLAIM, outcome: "overrode", reason: OVERRIDE_REASON });
    world.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);
    await put(world, false);
    world.harness.clock.advanceSeconds(60);
    await put(world, true);

    // Act
    const view = await viewOf(await readMine(world, world.nick, `repo=${encodeURIComponent(REPO)}&days=90`));
    const later = await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });

    // Assert — the July word stands, its reason with it, and a July hint can still take one
    expect(view).toMatchObject(tally({ received: 3, overrode: 1, followed: 0, unmarked: 2 }));
    expect(JSON.stringify(view["reasons"])).toContain(OVERRIDE_REASON);
    expect(later.status).toBe(201);
  });
});

describe("ties and self-pointing hints (review M5: surviving mutations)", () => {
  test("M6: the person's own outcome and their noise label at the same instant — the label stands in the view", async () => {
    // Arrange — a tie the write path no longer makes (it stamps strictly later),
    // so it is a pair of rows from before that, read as D-O7 says
    const world = await createOutcomeWorld();
    await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    await world.harness.db.insert(pilotMarks).values({
      id: "pm_tied",
      repo: REPO,
      refKind: "hint_delivery",
      refId: world.delivered.kenContext,
      mark: "noise",
      markedBy: world.nick.developerId,
      captureMode: "human",
      createdAt: world.harness.clock.now(),
      reason: null,
    });

    // Act
    const view = await viewOf(await readMine(world, world.nick));

    // Assert
    expect(view).toMatchObject(tally({ received: 3, noise: 1, unmarked: 2 }));
  });

  test("M5: a hint pointing at the author's own work is never part of the author's credit", async () => {
    // Arrange — the printed crowd; and Ken, in a second session, followed a pointer at his own context
    const crowd = await createCrowd();
    await recordCrowdWords(crowd);
    await registerTestSession(crowd.harness, crowd.ken.apiKey, { id: KEN_SECOND_SESSION, repo: REPO });
    await postRecords(crowd.harness, crowd.ken, {
      records: [deliveryRecord(KEN_SECOND_SESSION, "work_context", KEN_CONTEXT, "prompt_hint")],
    });
    await recordOutcome(crowd, crowd.ken, { ref: KEN_CONTEXT, outcome: "followed", session: KEN_SECOND_SESSION });
    crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);

    // Act
    const ken = await viewOf(await readMine(crowd, crowd.ken));

    // Assert — the four teammates' five follows, not six
    expect(ken["yourWork"]).toEqual({ ...JULY, followed: 5, withheld: null });
  });
});
