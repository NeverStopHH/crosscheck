/**
 * POST /api/hint-outcomes — what a delivered hint led to (1.0 spec 07 §13).
 *
 * WHAT THESE PIN, in order of how easily each could be lost:
 *
 *   · an outcome names the delivery it answers, resolved from what the hint
 *     PRINTED (a work-context or claim id) to the caller's OWN delivery — a
 *     teammate's delivery answers exactly like an id that does not exist;
 *   · it is append-only: a repeat is one row, a different word is a second
 *     row that supersedes the first, and nothing is ever deleted;
 *   · it never writes `pilot_marks`. An outcome is the one pilot record an
 *     agent may write, and the label table is the one it may not (PIL-6);
 *   · the reason is untrusted text: bounded, secret-scanned at the hub, and a
 *     hit drops the whole outcome rather than a redacted derivative.
 */
import { describe, expect, test } from "bun:test";
import { PIN_PRESENCE_TERMINAL, deliveryIdFor, hintDeliveryId } from "@crosscheck/schema";

import { hintOutcomes, pilotMarks } from "../src/db/schema.ts";
import {
  KEN_CLAIM,
  KEN_CONTEXT,
  MIKE_CONTEXT,
  MIKE_SESSION,
  NICK_SECOND_SESSION,
  NICK_SESSION,
  OTHER_REPO,
  REPO,
  createOutcomeWorld,
  deliveryRecord,
  enrol,
  readMine,
  recordOutcome,
} from "./fixtures/hint-outcome-world.ts";
import type { OutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import { labelNoise } from "./fixtures/hint-outcome-crowd.ts";
import { TEST_ADMIN_TOKEN, jsonRequest, postRecords, registerTestSession } from "./helpers.ts";

/** A synthetic AWS example key, the fixture every secret-scan test uses. */
const CREDENTIAL = "AKIAIOSFODNN7EXAMPLE";

const bodyOf = async (response: Response): Promise<Record<string, unknown>> =>
  ((await response.json()) as { data: Record<string, unknown> }).data;

const mineOf = async (world: OutcomeWorld): Promise<Record<string, unknown>> =>
  ((await (await readMine(world, world.nick)).json()) as { data: Record<string, unknown> }).data;

const markNoise = async (world: OutcomeWorld, deliveryId: string): Promise<Response> =>
  await world.harness.app.request(
    "/api/pilot-marks",
    jsonRequest("POST", world.nick.apiKey, {
      repo: REPO,
      refKind: "hint_delivery",
      refId: deliveryId,
      mark: "noise",
      presence: PIN_PRESENCE_TERMINAL,
    }),
  );

const errorOf = async (response: Response): Promise<{ code: string; message: string }> =>
  ((await response.json()) as { error: { code: string; message: string } }).error;

describe("POST /api/hint-outcomes", () => {
  test("the ref a hint printed records an outcome on the caller's own delivery", async () => {
    // Arrange
    const world = await createOutcomeWorld();

    // Act
    const response = await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });

    // Assert
    expect(response.status).toBe(201);
    expect(await bodyOf(response)).toMatchObject({
      deliveryId: world.delivered.kenContext,
      outcome: "followed",
      repeated: false,
      replaced: null,
    });
    const rows = await world.harness.db.select().from(hintOutcomes);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      deliveryId: world.delivered.kenContext,
      recordedBy: world.nick.developerId,
      repo: REPO,
      reason: null,
    });
  });

  test("a tripwire ask and a briefing pointer take an outcome by the ref they printed (D-O3)", async () => {
    // Arrange — the tripwire ask has its own delivery-id namespace
    const world = await createOutcomeWorld();
    await postRecords(world.harness, world.nick, {
      records: [deliveryRecord(NICK_SESSION, "claim", KEN_CLAIM, "tripwire")],
    });

    // Act — the tripwire's delivery is named by its own id; the briefing's by the ref it printed
    const tripwire = await recordOutcome(world, world.nick, {
      ref: deliveryIdFor(NICK_SESSION, KEN_CLAIM, "tripwire"),
      outcome: "overrode",
      reason: "kept my own cache key after the stop",
    });
    const briefing = await recordOutcome(world, world.nick, { ref: MIKE_CONTEXT, outcome: "followed" });

    // Assert
    expect(tripwire.status).toBe(201);
    expect(await bodyOf(tripwire)).toMatchObject({ deliveryId: deliveryIdFor(NICK_SESSION, KEN_CLAIM, "tripwire") });
    expect(briefing.status).toBe(201);
    expect(await bodyOf(briefing)).toMatchObject({ deliveryId: world.delivered.mikeContext });
  });

  test("a delivery id names the delivery directly", async () => {
    // Arrange
    const world = await createOutcomeWorld();

    // Act
    const response = await recordOutcome(world, world.nick, {
      ref: world.delivered.kenClaim,
      outcome: "overrode",
      reason: "kept the developer key; the repo key mixes two people's caches",
    });

    // Assert
    expect(response.status).toBe(201);
    expect(await bodyOf(response)).toMatchObject({ deliveryId: world.delivered.kenClaim });
  });

  test("saying the same thing twice is one row, and SAYS so", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });

    // Act
    const again = await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });

    // Assert
    expect(again.status).toBe(200);
    expect(await bodyOf(again)).toMatchObject({ repeated: true, stands: "followed" });
    expect(await world.harness.db.select().from(hintOutcomes)).toHaveLength(1);
  });

  test("review H2 (P3): the word the person's noise label superseded, said again, writes nothing and says the label stands", async () => {
    // Arrange — the agent said followed, then the person labelled it noise
    const world = await createOutcomeWorld();
    await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    world.harness.clock.advanceSeconds(60);
    await labelNoise(world, world.nick, world.delivered.kenContext);
    world.harness.clock.advanceSeconds(60);

    // Act — the agent, re-reading the clause, says followed again. #11 wrote it, for good.
    const again = await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    const view = await mineOf(world);

    // Assert
    expect(again.status).toBe(200);
    expect(await bodyOf(again)).toMatchObject({ repeated: true, stands: "noise" });
    expect(await world.harness.db.select().from(hintOutcomes)).toHaveLength(1);
    expect(view).toMatchObject({ followed: 0, noise: 1 });
  });

  test("review #11: a new word at the same instant as the noise label is written, and the answer says the label still stands", async () => {
    // Arrange — a tie goes to the label (D-O7)
    const world = await createOutcomeWorld();
    await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    world.harness.clock.advanceSeconds(60);
    await labelNoise(world, world.nick, world.delivered.kenContext);

    // Act
    const tied = await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "overrode", reason: "kept mine" });

    // Assert
    expect(await bodyOf(tied)).toMatchObject({ repeated: false, replaced: "noise", stands: "noise" });
  });

  test("review H2: the person re-asserts noise over a later word, and the answer says what now stands", async () => {
    // Arrange — followed; the person: noise; the agent: overrode (a new word, so it stands)
    const world = await createOutcomeWorld();
    await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    world.harness.clock.advanceSeconds(60);
    await labelNoise(world, world.nick, world.delivered.kenContext);
    world.harness.clock.advanceSeconds(60);
    await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "overrode", reason: "kept mine" });
    world.harness.clock.advanceSeconds(60);

    // Act — the person says noise again; one label row per person and delivery, so it is restamped
    const again = await markNoise(world, world.delivered.kenContext);
    const view = await mineOf(world);

    // Assert
    expect(again.status).toBe(201);
    expect(await bodyOf(again)).toMatchObject({ repeated: false, stands: "noise", replaced: "overrode" });
    expect(view).toMatchObject({ overrode: 0, noise: 1 });
  });

  test("review H2: a label that already stands, said again, is a repeat that says it stands", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    world.harness.clock.advanceSeconds(60);
    await labelNoise(world, world.nick, world.delivered.kenContext);
    world.harness.clock.advanceSeconds(60);

    // Act
    const again = await markNoise(world, world.delivered.kenContext);

    // Assert
    expect(again.status).toBe(200);
    expect(await bodyOf(again)).toMatchObject({ repeated: true, stands: "noise" });
  });

  test("review H2: two words in the same millisecond — the later one stands, every time", async () => {
    // Arrange — the clock does not move: every word below shares one instant
    const world = await createOutcomeWorld();

    // Act — on each of three pointers, three words back to back; the last is overrode
    const answers: Record<string, unknown>[] = [];
    for (const ref of [KEN_CONTEXT, KEN_CLAIM, MIKE_CONTEXT]) {
      await recordOutcome(world, world.nick, { ref, outcome: "followed" });
      await recordOutcome(world, world.nick, { ref, outcome: "not_relevant_now" });
      answers.push(await bodyOf(await recordOutcome(world, world.nick, { ref, outcome: "overrode", reason: "kept mine" })));
    }
    const view = await mineOf(world);

    // Assert — not a draw between rows that share one timestamp
    expect(answers.map((answer) => answer["stands"])).toEqual(["overrode", "overrode", "overrode"]);
    expect(view).toMatchObject({ followed: 0, notRelevantNow: 0, overrode: 3 });
  });

  test("a different word supersedes the first and deletes nothing", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    world.harness.clock.advanceSeconds(60);

    // Act
    const changed = await recordOutcome(world, world.nick, {
      ref: KEN_CONTEXT,
      outcome: "overrode",
      reason: "reverted it: the wider row broke the mobile layout",
    });

    // Assert — both rows stand; the answer names what was replaced
    expect(changed.status).toBe(201);
    expect(await bodyOf(changed)).toMatchObject({ repeated: false, replaced: "followed" });
    const rows = await world.harness.db.select().from(hintOutcomes);
    expect(rows.map((row) => row.outcome).sort()).toEqual(["followed", "overrode"]);
  });

  test("review #12: a delivery from before the repo could record outcomes is refused, and says why", async () => {
    // Arrange — a pointer delivered an hour before enrolment stamped the instant
    const world = await createOutcomeWorld();
    const earlier = new Date(world.harness.clock.now().getTime() - 3_600_000).toISOString();
    await postRecords(world.harness, world.nick, {
      records: [deliveryRecord(NICK_SESSION, "work_context", "wc_old_pointer", "prompt_hint", earlier)],
    });

    // Act — a 201 "shows in your --mine" here would be false: no figure ever counts it
    const response = await recordOutcome(world, world.nick, { ref: "wc_old_pointer", outcome: "followed" });

    // Assert
    expect(response.status).toBe(422);
    expect(await errorOf(response)).toMatchObject({ code: "before_outcomes" });
    expect(await world.harness.db.select().from(hintOutcomes)).toHaveLength(0);
  });

  test("review #12: a delivery older than every outcome figure's window is refused, and says why", async () => {
    // Arrange — 91 days on, the widest window (90) no longer reaches the delivery
    const world = await createOutcomeWorld();
    world.harness.clock.advanceSeconds(91 * 86_400);

    // Act
    const response = await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });

    // Assert
    expect(response.status).toBe(422);
    expect(await errorOf(response)).toMatchObject({ code: "past_window" });
    expect(await world.harness.db.select().from(hintOutcomes)).toHaveLength(0);
  });

  test("review LOW: an answer somebody asked for, named by its ref, is refused as pulled — not as never reached", async () => {
    // Arrange — Nick asked (get_diagnosis) and was answered with Ken's claim
    const world = await createOutcomeWorld();
    await postRecords(world.harness, world.nick, {
      records: [deliveryRecord(NICK_SESSION, "claim", "clm_ken_pulled", "suspect")],
    });

    // Act
    const response = await recordOutcome(world, world.nick, { ref: "clm_ken_pulled", outcome: "followed" });

    // Assert
    expect(response.status).toBe(422);
    expect(await errorOf(response)).toMatchObject({ code: "not_unsolicited" });
  });

  test("review LOW: a ref that arrived both unasked and pulled resolves to the unasked delivery", async () => {
    // Arrange — in a second session Nick later ASKED and was answered with Ken's context
    const world = await createOutcomeWorld();
    await registerTestSession(world.harness, world.nick.apiKey, { id: NICK_SECOND_SESSION, repo: REPO });
    world.harness.clock.advanceSeconds(60);
    const later = world.harness.clock.now().toISOString();
    await postRecords(world.harness, world.nick, {
      records: [deliveryRecord(NICK_SECOND_SESSION, "work_context", KEN_CONTEXT, "suspect", later)],
    });

    // Act
    const response = await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });

    // Assert
    expect(response.status).toBe(201);
    expect(await bodyOf(response)).toMatchObject({ deliveryId: world.delivered.kenContext });
  });

  test("review M4: a noise label on one delivery of a pointer stands for the pointer's other delivery", async () => {
    // Arrange — the same pointer as a prompt hint and a tripwire ask; the person labelled the hint noise
    const world = await createOutcomeWorld();
    await postRecords(world.harness, world.nick, {
      records: [deliveryRecord(NICK_SESSION, "work_context", KEN_CONTEXT, "tripwire")],
    });
    await labelNoise(world, world.nick, world.delivered.kenContext);
    world.harness.clock.advanceSeconds(60);

    // Act — the agent records on the tripwire delivery of the same pointer
    const response = await recordOutcome(world, world.nick, {
      ref: deliveryIdFor(NICK_SESSION, KEN_CONTEXT, "tripwire"),
      outcome: "overrode",
      reason: "kept the retry on the hub",
    });

    // Assert — what stood was the label, on the pointer
    expect(await bodyOf(response)).toMatchObject({ repeated: false, replaced: "noise", stands: "overrode" });
  });

  test("review M3: a hint delivered while the pilot was paused is refused, and says so", async () => {
    // Arrange — enrolled; paused; a hint arrives; enrolled again
    const world = await createOutcomeWorld();
    const put = async (pilotEnrolled: boolean): Promise<Response> =>
      await world.harness.app.request("/api/team-settings", jsonRequest("PUT", TEST_ADMIN_TOKEN, { repo: REPO, pilotEnrolled }));
    world.harness.clock.advanceSeconds(60);
    await put(false);
    world.harness.clock.advanceSeconds(60);
    await postRecords(world.harness, world.mike, {
      records: [deliveryRecord(MIKE_SESSION, "claim", KEN_CLAIM, "prompt_hint", world.harness.clock.now().toISOString())],
    });
    world.harness.clock.advanceSeconds(60);
    await put(true);

    // Act
    const response = await recordOutcome(world, world.mike, { ref: KEN_CLAIM, outcome: "followed" });

    // Assert
    expect(response.status).toBe(422);
    expect(await errorOf(response)).toMatchObject({ code: "while_paused" });
  });

  test("a teammate's delivery answers exactly like an id that does not exist", async () => {
    // Arrange — Ken never received a pointer at Mike's context; Nick did. A
    // distinct refusal would tell Ken what Nick was shown (§8.4, §11.9).
    const world = await createOutcomeWorld();

    // Act
    const byRef = await recordOutcome(world, world.ken, { ref: MIKE_CONTEXT, outcome: "followed" });
    const byDelivery = await recordOutcome(world, world.ken, {
      ref: world.delivered.mikeContext,
      outcome: "followed",
    });
    const missing = await recordOutcome(world, world.ken, { ref: "wc_nobody", outcome: "followed" });

    // Assert
    for (const response of [byRef, byDelivery, missing]) {
      expect(response.status).toBe(422);
      expect((await errorOf(response)).code).toBe("unknown_ref");
    }
    expect(await world.harness.db.select().from(hintOutcomes)).toHaveLength(0);
  });

  test("the named session's delivery is the one answered", async () => {
    // Arrange — Nick was pointed at Ken's claim in two sessions
    const world = await createOutcomeWorld();
    await registerTestSession(world.harness, world.nick.apiKey, { id: NICK_SECOND_SESSION, repo: REPO });
    world.harness.clock.advanceSeconds(60);
    await postRecords(world.harness, world.nick, {
      records: [
        deliveryRecord(
          NICK_SECOND_SESSION,
          "claim",
          KEN_CLAIM,
          "prompt_hint",
          world.harness.clock.now().toISOString(),
        ),
      ],
    });

    // Act
    const named = await recordOutcome(world, world.nick, {
      ref: KEN_CLAIM,
      outcome: "followed",
      session: NICK_SESSION,
    });
    const newest = await recordOutcome(world, world.nick, { ref: KEN_CLAIM, outcome: "not_relevant_now" });

    // Assert
    expect(await bodyOf(named)).toMatchObject({ deliveryId: hintDeliveryId(NICK_SESSION, KEN_CLAIM) });
    expect(await bodyOf(newest)).toMatchObject({ deliveryId: hintDeliveryId(NICK_SECOND_SESSION, KEN_CLAIM) });
  });

  test("an outcome never writes a pilot label — the one table an agent may not reach", async () => {
    // Arrange
    const world = await createOutcomeWorld();

    // Act
    await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    await recordOutcome(world, world.nick, { ref: MIKE_CONTEXT, outcome: "not_relevant_now" });

    // Assert
    expect(await world.harness.db.select().from(pilotMarks)).toHaveLength(0);
  });

  test("a repo nobody enrolled records nothing, and says so", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: false });

    // Act
    const response = await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });

    // Assert
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe("not_enrolled");
    expect(await world.harness.db.select().from(hintOutcomes)).toHaveLength(0);
  });

  test("a delivery of another repo is refused as another repo's", async () => {
    // Arrange — Nick's session on the other repo got Ken's context too
    const world = await createOutcomeWorld();
    const otherSession = "cc_aaaaaaaa-3333-4333-8333-333333333333";
    await registerTestSession(world.harness, world.nick.apiKey, { id: otherSession, repo: OTHER_REPO });
    await enrol(world.harness, OTHER_REPO);
    await postRecords(world.harness, world.nick, {
      records: [deliveryRecord(otherSession, "work_context", KEN_CONTEXT, "prompt_hint")],
    });

    // Act
    const response = await recordOutcome(world, world.nick, {
      ref: hintDeliveryId(otherSession, KEN_CONTEXT),
      outcome: "followed",
    });

    // Assert
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe("wrong_repo");
  });

  test("a reason that holds a secret drops the whole outcome", async () => {
    // Arrange
    const world = await createOutcomeWorld();

    // Act
    const response = await recordOutcome(world, world.nick, {
      ref: KEN_CONTEXT,
      outcome: "overrode",
      reason: `used my own key ${CREDENTIAL} instead`,
    });

    // Assert
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe("reason_secret");
    expect(await world.harness.db.select().from(hintOutcomes)).toHaveLength(0);
  });

  test("an override with no reason, or a NUL in one, is refused before anything is stored", async () => {
    // Arrange
    const world = await createOutcomeWorld();

    // Act
    const bare = await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "overrode" });
    const nul = await recordOutcome(world, world.nick, {
      ref: KEN_CONTEXT,
      outcome: "overrode",
      reason: "my way\u0000is better",
    });

    // Assert
    expect(bare.status).toBe(400);
    expect(nul.status).toBe(400);
    expect(await world.harness.db.select().from(hintOutcomes)).toHaveLength(0);
  });

  test("noise is not an outcome: the person's label is the one word for it", async () => {
    // Arrange
    const world = await createOutcomeWorld();

    // Act
    const response = await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "noise" });

    // Assert
    expect(response.status).toBe(400);
    expect(await world.harness.db.select().from(pilotMarks)).toHaveLength(0);
  });
});
