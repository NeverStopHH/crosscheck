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
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { DbExecutor } from "../src/db/client.ts";
import { lockPointer } from "../src/services/pointer-standing.ts";
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
  recordPersonOutcome,
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
    // Arrange — the agent's word, said in the label's own instant: the label stands (D-O7, §13.12)
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
    // Arrange — followed; the person: noise; the person again: overrode (their own later word, so it stands)
    const world = await createOutcomeWorld();
    await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    world.harness.clock.advanceSeconds(60);
    await labelNoise(world, world.nick, world.delivered.kenContext);
    world.harness.clock.advanceSeconds(60);
    await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "overrode", reason: "kept mine" });
    world.harness.clock.advanceSeconds(60);

    // Act — the person says noise again: a re-assertion row of its own (review H-B)
    const again = await markNoise(world, world.delivered.kenContext);
    const view = await mineOf(world);

    // Assert
    expect(again.status).toBe(201);
    expect(await bodyOf(again)).toMatchObject({ repeated: false, stands: "noise", replaced: "overrode" });
    expect(view).toMatchObject({ overrode: 0, noise: 1 });
  });

  test("review H-B: noise said again is a new row — the first label's instant never moves, and the new reason is kept", async () => {
    // Arrange — the same history as above: followed, the person's noise, the person's overrode
    const world = await createOutcomeWorld();
    await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    world.harness.clock.advanceSeconds(60);
    await labelNoise(world, world.nick, world.delivered.kenContext);
    const labelledAt = world.harness.clock.now().toISOString();
    world.harness.clock.advanceSeconds(60);
    await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "overrode", reason: "kept mine" });
    world.harness.clock.advanceSeconds(60);

    // Act — the person says noise again, with a sentence this time
    const again = await world.harness.app.request(
      "/api/pilot-marks",
      jsonRequest("POST", world.nick.apiKey, {
        repo: REPO,
        refKind: "hint_delivery",
        refId: world.delivered.kenContext,
        mark: "noise",
        reason: "still off target",
        presence: PIN_PRESENCE_TERMINAL,
      }),
    );

    // Assert — the label row is untouched; the re-assertion is its own row, with its reason
    expect(await bodyOf(again)).toMatchObject({ repeated: false, stands: "noise", replaced: "overrode" });
    const labels = await world.harness.db.select().from(pilotMarks);
    expect(labels.map((label) => label.createdAt.toISOString())).toEqual([labelledAt]);
    const reasserted = await world.harness.db.execute(sql`SELECT reason FROM noise_reassertions`);
    expect(reasserted.rows).toEqual([{ reason: "still off target" }]);
    // and said a third time, while the re-assertion stands, it is a repeat that writes nothing
    world.harness.clock.advanceSeconds(60);
    const third = await markNoise(world, world.delivered.kenContext);
    expect(await bodyOf(third)).toMatchObject({ repeated: true, stands: "noise" });
  });

  test("review H-B (R7): a person's helpful label, then their noise, makes noise stand; the first label stays", async () => {
    // Arrange — the person said helpful first
    const world = await createOutcomeWorld();
    await world.harness.app.request(
      "/api/pilot-marks",
      jsonRequest("POST", world.nick.apiKey, {
        repo: REPO,
        refKind: "hint_delivery",
        refId: world.delivered.kenContext,
        mark: "helpful",
        presence: PIN_PRESENCE_TERMINAL,
      }),
    );
    world.harness.clock.advanceSeconds(60);

    // Act — their own later word: noise
    const noise = await markNoise(world, world.delivered.kenContext);
    const view = await mineOf(world);

    // Assert — the outcome figures follow the person's newest word; precision's label stays helpful
    expect(await bodyOf(noise)).toMatchObject({ repeated: false, stands: "noise" });
    expect(view).toMatchObject({ noise: 1 });
    const labels = await world.harness.db.select().from(pilotMarks);
    expect(labels.map((label) => label.mark)).toEqual(["helpful"]);
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

    // Act — the person records on the tripwire delivery of the same pointer
    const response = await recordPersonOutcome(world, world.nick, {
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

  test("review LOW (probe D): off and on again in one millisecond leaves the repo enrolled, with an open interval", async () => {
    // Arrange — the clock does not move between the two writes
    const world = await createOutcomeWorld();
    const put = async (pilotEnrolled: boolean): Promise<Response> =>
      await world.harness.app.request("/api/team-settings", jsonRequest("PUT", TEST_ADMIN_TOKEN, { repo: REPO, pilotEnrolled }));
    await put(false);
    await put(true);

    // Act
    const recorded = await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    const open = await world.harness.db.execute(sql`SELECT count(*)::int AS n FROM pilot_enrolments WHERE ended_at IS NULL`);

    // Assert
    expect(recorded.status).toBe(201);
    expect(open.rows).toEqual([{ n: 1 }]);
  });

  test("survivor R6: a settings write while already enrolled opens no second interval", async () => {
    // Arrange — enrolled already; enrolled said again, and the pin policy changed
    const world = await createOutcomeWorld();
    world.harness.clock.advanceSeconds(60);
    const again = await world.harness.app.request(
      "/api/team-settings",
      jsonRequest("PUT", TEST_ADMIN_TOKEN, { repo: REPO, pilotEnrolled: true }),
    );
    world.harness.clock.advanceSeconds(60);

    // Act
    const policy = await world.harness.app.request(
      "/api/team-settings",
      jsonRequest("PUT", TEST_ADMIN_TOKEN, { repo: REPO, pinPolicy: "anyone" }),
    );
    const intervals = await world.harness.db.execute(sql`SELECT ended_at AS e FROM pilot_enrolments`);

    // Assert
    expect([again.status, policy.status]).toEqual([200, 200]);
    expect(intervals.rows).toEqual([{ e: null }]);
  });

  test("round-5 MEDIUM-2 (Q14): an uncountable delivery never borrows another session's delivery of the same ref", async () => {
    // Arrange — session A got the ref during a pause; session B got it after, countably — two pointers
    const world = await createOutcomeWorld();
    await registerTestSession(world.harness, world.nick.apiKey, { id: NICK_SECOND_SESSION, repo: REPO });
    const put = async (pilotEnrolled: boolean): Promise<Response> =>
      await world.harness.app.request("/api/team-settings", jsonRequest("PUT", TEST_ADMIN_TOKEN, { repo: REPO, pilotEnrolled }));
    world.harness.clock.advanceSeconds(60);
    await put(false);
    world.harness.clock.advanceSeconds(60);
    await postRecords(world.harness, world.nick, {
      records: [deliveryRecord(NICK_SESSION, "work_context", "wc_two_sessions", "prompt_hint", world.harness.clock.now().toISOString())],
    });
    world.harness.clock.advanceSeconds(60);
    await put(true);
    world.harness.clock.advanceSeconds(60);
    await postRecords(world.harness, world.nick, {
      records: [deliveryRecord(NICK_SECOND_SESSION, "work_context", "wc_two_sessions", "prompt_hint", world.harness.clock.now().toISOString())],
    });

    // Act — named by session A's own delivery id
    const response = await recordOutcome(world, world.nick, {
      ref: hintDeliveryId(NICK_SESSION, "wc_two_sessions"),
      outcome: "followed",
    });

    // Assert — refused for what it is; a twin is the SAME pointer, never another session's
    expect(response.status).toBe(422);
    expect(await errorOf(response)).toMatchObject({ code: "while_paused" });
  });

  test("review H-A: a pointer's twin older than every window records on its twin inside it", async () => {
    // Arrange — one long session: the prompt hint 91 days ago, its tripwire twin today
    const world = await createOutcomeWorld();
    world.harness.clock.advanceSeconds(91 * 86_400);
    await postRecords(world.harness, world.nick, {
      records: [deliveryRecord(NICK_SESSION, "work_context", KEN_CONTEXT, "tripwire", world.harness.clock.now().toISOString())],
    });

    // Act — the old twin's own id
    const response = await recordOutcome(world, world.nick, { ref: world.delivered.kenContext, outcome: "followed" });

    // Assert
    expect(response.status).toBe(201);
    expect(await bodyOf(response)).toMatchObject({ deliveryId: deliveryIdFor(NICK_SESSION, KEN_CONTEXT, "tripwire") });
  });

  test("review H-A: a pointer's twin delivered while the pilot was paused records on its countable twin", async () => {
    // Arrange — the pointer's prompt hint arrived enrolled; its tripwire twin during a pause
    const world = await createOutcomeWorld();
    const put = async (pilotEnrolled: boolean): Promise<Response> =>
      await world.harness.app.request("/api/team-settings", jsonRequest("PUT", TEST_ADMIN_TOKEN, { repo: REPO, pilotEnrolled }));
    world.harness.clock.advanceSeconds(60);
    await put(false);
    world.harness.clock.advanceSeconds(60);
    await postRecords(world.harness, world.nick, {
      records: [deliveryRecord(NICK_SESSION, "work_context", KEN_CONTEXT, "tripwire", world.harness.clock.now().toISOString())],
    });
    world.harness.clock.advanceSeconds(60);
    await put(true);

    // Act — the newest twin, as a candidate list collapses the pointer to it
    const response = await recordOutcome(world, world.nick, {
      ref: deliveryIdFor(NICK_SESSION, KEN_CONTEXT, "tripwire"),
      outcome: "followed",
    });

    // Assert
    expect(response.status).toBe(201);
    expect(await bodyOf(response)).toMatchObject({ deliveryId: world.delivered.kenContext });
  });

  test("review H-A: a pointer's twin from before outcomes were recordable records on its countable twin", async () => {
    // Arrange — an older tripwire twin, delivered an hour before enrolment
    const world = await createOutcomeWorld();
    const earlier = new Date(world.harness.clock.now().getTime() - 3_600_000).toISOString();
    await postRecords(world.harness, world.nick, {
      records: [deliveryRecord(NICK_SESSION, "work_context", KEN_CONTEXT, "tripwire", earlier)],
    });

    // Act
    const response = await recordOutcome(world, world.nick, {
      ref: deliveryIdFor(NICK_SESSION, KEN_CONTEXT, "tripwire"),
      outcome: "followed",
    });

    // Assert
    expect(response.status).toBe(201);
    expect(await bodyOf(response)).toMatchObject({ deliveryId: world.delivered.kenContext });
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

describe("round-5 LOW-5: a word from before the channel was stamped is the agent's", () => {
  /** A row as a hub before `recorded_via` wrote it: no channel at all. */
  const legacyWord = async (world: OutcomeWorld, outcome: "followed" | "overrode", at: Date): Promise<void> => {
    await world.harness.db.insert(hintOutcomes).values({
      id: `ho_legacy_${outcome}`,
      repo: REPO,
      deliveryId: world.delivered.kenContext,
      outcome,
      reason: outcome === "overrode" ? "kept mine" : null,
      recordedBy: world.nick.developerId,
      createdAt: at,
    });
  };

  test("Q1: the agent saying a pre-channel word again is a repeat — that row was the agent's", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    await legacyWord(world, "followed", world.harness.clock.now());
    world.harness.clock.advanceSeconds(60);

    // Act
    const agent = await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });

    // Assert
    expect(agent.status).toBe(200);
    expect(await bodyOf(agent)).toMatchObject({ repeated: true });
  });

  test("Q2: the agent's newer word stands over a pre-channel word — that row was never the person's", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    await legacyWord(world, "followed", world.harness.clock.now());
    world.harness.clock.advanceSeconds(60);

    // Act
    const agent = await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "overrode", reason: "kept mine" });

    // Assert
    expect(await bodyOf(agent)).toMatchObject({ replaced: "followed", stands: "overrode" });
  });

  test("Q3: a newer pre-channel word never ranks above the person's own in the view", async () => {
    // Arrange — the person's followed, then a newer row with no channel
    const world = await createOutcomeWorld();
    await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    world.harness.clock.advanceSeconds(60);
    await legacyWord(world, "overrode", world.harness.clock.now());

    // Act
    const view = await mineOf(world);

    // Assert — NULL is the agent's side, never sorted above the person's word
    expect(view).toMatchObject({ followed: 1, overrode: 0 });
  });
});

describe("survivors R10, R11: the order of words on one pointer", () => {
  test("R10: noise said again in the same millisecond as an outcome that was stamped past it still stands", async () => {
    // Arrange — the clock never moves: the label at t, the person's overrode bumped to t+1ms
    const world = await createOutcomeWorld();
    await labelNoise(world, world.nick, world.delivered.kenContext);
    await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "overrode", reason: "kept mine" });

    // Act — the person says noise again, still at t
    const again = await markNoise(world, world.delivered.kenContext);
    const view = await mineOf(world);

    // Assert — stamped past the overrode's bumped instant, not at the clock's
    expect(await bodyOf(again)).toMatchObject({ repeated: false, stands: "noise", replaced: "overrode" });
    expect(view).toMatchObject({ overrode: 0, noise: 1 });
  });

  test("review LOW: the person's outcome said in their label's own millisecond is stamped past the label, and stands", async () => {
    // Arrange — the clock never moves: the noise label at t
    const world = await createOutcomeWorld();
    await labelNoise(world, world.nick, world.delivered.kenContext);

    // Act — the person's followed, still at t: a tie would leave the label standing (D-O7)
    const person = await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    const view = await mineOf(world);

    // Assert
    expect(await bodyOf(person)).toMatchObject({ repeated: false, replaced: "noise", stands: "followed" });
    expect(view).toMatchObject({ followed: 1, noise: 0 });
  });

  test("R11: the pointer's deliveries are locked FOR UPDATE, in id order", async () => {
    // Arrange — PGlite has one connection, so a second writer cannot be staged to wait on the
    // lock; what is pinned is the SQL that takes it: FOR UPDATE, in one order, so two writers
    // on the same pointer queue rather than deadlock (review LOW)
    const issued: SQL[] = [];
    const executor = {
      execute: async (query: SQL) => {
        issued.push(query);
        return await Promise.resolve({ rows: [] });
      },
    } as unknown as DbExecutor;

    // Act
    await lockPointer(executor, { sessionId: NICK_SESSION, refId: KEN_CONTEXT });

    // Assert
    expect(issued.map((query) => new PgDialect().sqlToQuery(query).sql)).toEqual([
      "SELECT d.id FROM hint_deliveries d WHERE d.session_id = $1 AND d.ref_id = $2 ORDER BY d.id FOR UPDATE",
    ]);
  });
});

describe("a person's word is never overturned by an agent's (07 §13.12)", () => {
  test("the agent's later word is recorded, but the person's noise label still stands", async () => {
    // Arrange — the person labelled the hint noise
    const world = await createOutcomeWorld();
    await labelNoise(world, world.nick, world.delivered.kenContext);
    world.harness.clock.advanceSeconds(60);

    // Act — the agent, reading the clause, says followed
    const agent = await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    const view = await mineOf(world);

    // Assert
    expect(agent.status).toBe(201);
    expect(await bodyOf(agent)).toMatchObject({ repeated: false, stands: "noise" });
    expect(view).toMatchObject({ followed: 0, noise: 1 });
    expect(await world.harness.db.select().from(hintOutcomes)).toHaveLength(1);
  });

  test("the agent's later word never overturns the person's own followed", async () => {
    // Arrange — the person said followed at a terminal (`crosscheck followed`)
    const world = await createOutcomeWorld();
    await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    world.harness.clock.advanceSeconds(60);

    // Act
    const agent = await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "overrode", reason: "kept mine" });
    const view = await mineOf(world);

    // Assert
    expect(await bodyOf(agent)).toMatchObject({ repeated: false, replaced: "followed", stands: "followed" });
    expect(view).toMatchObject({ followed: 1, overrode: 0 });
  });

  test("only the person's own later word changes what the person said", async () => {
    // Arrange — the person: followed; the agent: overrode (recorded, not standing)
    const world = await createOutcomeWorld();
    await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    world.harness.clock.advanceSeconds(60);
    await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "overrode", reason: "kept mine" });
    world.harness.clock.advanceSeconds(60);

    // Act — the person changes their own mind
    const person = await recordPersonOutcome(world, world.nick, {
      ref: KEN_CONTEXT,
      outcome: "not_relevant_now",
    });
    const view = await mineOf(world);

    // Assert
    expect(await bodyOf(person)).toMatchObject({ repeated: false, replaced: "followed", stands: "not_relevant_now" });
    expect(view).toMatchObject({ followed: 0, overrode: 0, notRelevantNow: 1 });
  });

  test("survivor R19: the same word with a revised reason is a write, the revised reason lands, and the answer says it was revised", async () => {
    // Arrange — the owner overrode, with a first reason
    const world = await createOutcomeWorld();
    await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "overrode", reason: "kept mine" });
    world.harness.clock.advanceSeconds(60);

    // Act — the same word, the reason said better
    const revised = await recordPersonOutcome(world, world.nick, {
      ref: KEN_CONTEXT,
      outcome: "overrode",
      reason: "kept the developer key: the repo key mixes two people's caches",
    });
    const view = await mineOf(world);

    // Assert
    expect(revised.status).toBe(201);
    expect(await bodyOf(revised)).toMatchObject({ repeated: false, reasonRevised: true, stands: "overrode" });
    expect(view["reasons"]).toEqual([
      { outcome: "overrode", reason: "kept the developer key: the repo key mixes two people's caches", source: "Ken" },
    ]);
  });

  test("survivor M7: the person's own outcome and their label at one instant — the label stands, and the answer says so", async () => {
    // Arrange — a tie the write path no longer makes (it stamps strictly later): a legacy pair of rows
    const world = await createOutcomeWorld();
    const at = world.harness.clock.now();
    await world.harness.db.insert(hintOutcomes).values({
      id: "ho_tied",
      repo: REPO,
      deliveryId: world.delivered.kenContext,
      outcome: "followed",
      reason: null,
      recordedBy: world.nick.developerId,
      createdAt: at,
      recordedVia: "person",
    });
    await world.harness.db.insert(pilotMarks).values({
      id: "pm_tied",
      repo: REPO,
      refKind: "hint_delivery",
      refId: world.delivered.kenContext,
      mark: "noise",
      markedBy: world.nick.developerId,
      captureMode: "human",
      createdAt: at,
      reason: null,
    });
    world.harness.clock.advanceSeconds(60);

    // Act — the agent says something new
    const agent = await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "overrode", reason: "kept mine" });

    // Assert — what stood was the label (D-O7), and it still stands
    expect(await bodyOf(agent)).toMatchObject({ repeated: false, replaced: "noise", stands: "noise" });
  });

  test("a repeat is judged within one channel: the agent agreeing with the person is its own word, recorded", async () => {
    // Arrange — the person said followed at a terminal
    const world = await createOutcomeWorld();
    await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    world.harness.clock.advanceSeconds(60);

    // Act — the agent says the same
    const agent = await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });

    // Assert
    expect(agent.status).toBe(201);
    expect(await bodyOf(agent)).toMatchObject({ repeated: false, stands: "followed" });
    expect(await world.harness.db.select().from(hintOutcomes)).toHaveLength(2);
  });

  test("the person's same word again, after their own noise label, is a new word that stands — not a repeat", async () => {
    // Arrange — the person: followed at a terminal, then noise
    const world = await createOutcomeWorld();
    await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    world.harness.clock.advanceSeconds(60);
    await labelNoise(world, world.nick, world.delivered.kenContext);
    world.harness.clock.advanceSeconds(60);

    // Act — the person says followed once more
    const again = await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    const view = await mineOf(world);

    // Assert
    expect(again.status).toBe(201);
    expect(await bodyOf(again)).toMatchObject({ repeated: false, replaced: "noise", stands: "followed" });
    expect(view).toMatchObject({ followed: 1, noise: 0 });
  });

  test("round-5 LOW-4 (P3): the person's helpful label is never overturned by their agent's word", async () => {
    // Arrange — the person labelled the hint helpful
    const world = await createOutcomeWorld();
    world.harness.clock.advanceSeconds(60);
    await world.harness.app.request(
      "/api/pilot-marks",
      jsonRequest("POST", world.nick.apiKey, {
        repo: REPO,
        refKind: "hint_delivery",
        refId: world.delivered.kenContext,
        mark: "helpful",
        presence: PIN_PRESENCE_TERMINAL,
      }),
    );
    world.harness.clock.advanceSeconds(60);

    // Act — the agent says the hint was not needed
    const agent = await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "not_relevant_now" });
    const view = await mineOf(world);

    // Assert — recorded, but the person's verdict stands; a verdict is not an outcome, so the
    // intervention stays where the label alone left it: unmarked
    expect(await bodyOf(agent)).toMatchObject({ repeated: false, replaced: "helpful", stands: "helpful" });
    expect(view).toMatchObject({ notRelevantNow: 0, unmarked: 3 });
  });

  test("round-5 LOW-4: of the person's two labels on one pointer, the newer stands — noise, then helpful", async () => {
    // Arrange — noise on the prompt hint; later, helpful on its tripwire twin (one label per delivery)
    const world = await createOutcomeWorld();
    await postRecords(world.harness, world.nick, {
      records: [deliveryRecord(NICK_SESSION, "work_context", KEN_CONTEXT, "tripwire")],
    });
    await labelNoise(world, world.nick, world.delivered.kenContext);
    world.harness.clock.advanceSeconds(60);
    await world.harness.app.request(
      "/api/pilot-marks",
      jsonRequest("POST", world.nick.apiKey, {
        repo: REPO,
        refKind: "hint_delivery",
        refId: deliveryIdFor(NICK_SESSION, KEN_CONTEXT, "tripwire"),
        mark: "helpful",
        presence: PIN_PRESENCE_TERMINAL,
      }),
    );
    world.harness.clock.advanceSeconds(60);

    // Act
    const agent = await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });

    // Assert
    expect(await bodyOf(agent)).toMatchObject({ replaced: "helpful", stands: "helpful" });
  });

  test("round-5 LOW-4: the person's own later outcome changes what their helpful label stood at", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    await world.harness.app.request(
      "/api/pilot-marks",
      jsonRequest("POST", world.nick.apiKey, {
        repo: REPO,
        refKind: "hint_delivery",
        refId: world.delivered.kenContext,
        mark: "helpful",
        presence: PIN_PRESENCE_TERMINAL,
      }),
    );
    world.harness.clock.advanceSeconds(60);

    // Act
    const person = await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    const view = await mineOf(world);

    // Assert
    expect(await bodyOf(person)).toMatchObject({ replaced: "helpful", stands: "followed" });
    expect(view).toMatchObject({ followed: 1 });
  });

  test("the channel is the route's, never the body's: an agent cannot claim to be the person", async () => {
    // Arrange
    const world = await createOutcomeWorld();

    // Act — the agent's route, with a body that claims otherwise
    await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed", recordedVia: "person" });
    await recordPersonOutcome(world, world.nick, { ref: KEN_CLAIM, outcome: "followed", recordedVia: "agent" });

    // Assert
    const rows = await world.harness.db.execute(
      sql`SELECT d.ref_id AS ref, o.recorded_via AS via FROM hint_outcomes o JOIN hint_deliveries d ON d.id = o.delivery_id ORDER BY d.ref_id`,
    );
    expect(rows.rows).toEqual([
      { ref: KEN_CLAIM, via: "person" },
      { ref: KEN_CONTEXT, via: "agent" },
    ]);
  });
});
