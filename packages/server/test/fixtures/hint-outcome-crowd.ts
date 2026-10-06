/**
 * A team big enough for a shared outcome figure (07 §13.9–§13.11).
 *
 * THE SUBTRACTION-SAFE MINIMUMS (review H1) are viewer-independent: leaving
 * out ANY one person's words, at least three people's words about at least
 * three people's work, ten or more, must remain. A team of three never meets
 * them, so this is five: the three-teammate world plus Anna and Lena, each
 * with a work context, and every one of them pointed at every other's work
 * in July 2026 (Nick and the others at Ken's claim too):
 *
 *   Nick → Ken's context, Ken's claim, Mike's context (world), Anna's, Lena's
 *   Ken  → Nick's context, Mike's, Anna's, Lena's
 *   Mike → Ken's context (world), Ken's claim, Nick's, Anna's, Lena's
 *   Anna → Ken's context, Ken's claim, Nick's, Mike's, Lena's
 *   Lena → Ken's context, Ken's claim, Nick's, Mike's, Anna's
 *
 * `recordCrowdWords` has four of them record fifteen words; Ken records none.
 */
import { PIN_PRESENCE_TERMINAL, hintDeliveryId } from "@crosscheck/schema";

import {
  TEST_START_ISO,
  createTestDeveloper,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validWorkContextBody,
} from "../helpers.ts";
import type { TestDeveloper } from "../helpers.ts";
import {
  KEN_CLAIM,
  KEN_CONTEXT,
  KEN_SESSION,
  MIKE_CONTEXT,
  MIKE_SESSION,
  NICK_SESSION,
  REPO,
  createOutcomeWorld,
  deliveryRecord,
  recordOutcome,
} from "./hint-outcome-world.ts";
import type { OutcomeWorld } from "./hint-outcome-world.ts";

export const ANNA_SESSION = "cc_dddddddd-1111-4111-8111-111111111111";
export const LENA_SESSION = "cc_eeeeeeee-1111-4111-8111-111111111111";
export const ANNA_CONTEXT = `wc_${ANNA_SESSION}`;
export const LENA_CONTEXT = `wc_${LENA_SESSION}`;
export const NICK_CONTEXT = `wc_${NICK_SESSION}`;

/** 2026-07-24 (the world's clock) to 2026-08-02: July becomes the last whole month. */
export const SECONDS_TO_AUGUST = 9 * 86_400;

export interface Crowd extends OutcomeWorld {
  readonly anna: TestDeveloper;
  readonly lena: TestDeveloper;
}

type Pointer = readonly ["work_context" | "claim", string];

const context = (ref: string): Pointer => ["work_context", ref];

/** Seats a teammate with a session and a work context of their own on the repo. */
export const addTeammate = async (
  world: OutcomeWorld,
  name: string,
  sessionId: string,
): Promise<TestDeveloper> => {
  const developer = await createTestDeveloper(world.harness, name, `${name.toLowerCase()}-outcomes@example.com`);
  await registerTestSession(world.harness, developer.apiKey, { id: sessionId, repo: REPO });
  await postRecords(world.harness, developer, {
    records: [
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          id: `wc_${sessionId}`,
          sessionId,
          title: `${name}'s work`,
          description: undefined,
          createdAt: TEST_START_ISO,
        }),
        { sessionId },
      ),
    ],
  });
  return developer;
};

/** Unasked prompt hints to one session, at the world's start (inside the enrolment). */
export const deliverTo = async (
  world: OutcomeWorld,
  developer: TestDeveloper,
  sessionId: string,
  pointers: readonly Pointer[],
): Promise<void> => {
  await postRecords(world.harness, developer, {
    records: pointers.map(([kind, ref]) => deliveryRecord(sessionId, kind, ref, "prompt_hint")),
  });
};

export const createCrowd = async (): Promise<Crowd> => {
  const world = await createOutcomeWorld();
  const anna = await addTeammate(world, "Anna", ANNA_SESSION);
  const lena = await addTeammate(world, "Lena", LENA_SESSION);
  const kenClaim: Pointer = ["claim", KEN_CLAIM];
  await deliverTo(world, world.nick, NICK_SESSION, [context(ANNA_CONTEXT), context(LENA_CONTEXT)]);
  await deliverTo(world, world.ken, KEN_SESSION, [
    context(NICK_CONTEXT),
    context(MIKE_CONTEXT),
    context(ANNA_CONTEXT),
    context(LENA_CONTEXT),
  ]);
  await deliverTo(world, world.mike, MIKE_SESSION, [
    kenClaim,
    context(NICK_CONTEXT),
    context(ANNA_CONTEXT),
    context(LENA_CONTEXT),
  ]);
  await deliverTo(world, anna, ANNA_SESSION, [
    context(KEN_CONTEXT),
    kenClaim,
    context(NICK_CONTEXT),
    context(MIKE_CONTEXT),
    context(LENA_CONTEXT),
  ]);
  await deliverTo(world, lena, LENA_SESSION, [
    context(KEN_CONTEXT),
    kenClaim,
    context(NICK_CONTEXT),
    context(MIKE_CONTEXT),
    context(ANNA_CONTEXT),
  ]);
  return { ...world, anna, lena };
};

export const labelNoise = async (crowd: OutcomeWorld, developer: TestDeveloper, deliveryId: string): Promise<void> => {
  await crowd.harness.app.request(
    "/api/pilot-marks",
    jsonRequest("POST", developer.apiKey, {
      repo: REPO,
      refKind: "hint_delivery",
      refId: deliveryId,
      mark: "noise",
      presence: PIN_PRESENCE_TERMINAL,
    }),
  );
};

/**
 * Fifteen recorded words by four people (Nick 4, Mike 4, Anna 4, Lena 3) about
 * five people's work; Ken records nothing. Over 24 interventions: followed 9 ·
 * overrode 3 · not relevant now 2 · noise 1 · unmarked 9. Leaving out any one
 * recorder, three people's words about three or more people's work remain, 11
 * or more — the minimums are met. About Ken's work, four people recorded and
 * five of their words are "followed".
 */
export const recordCrowdWords = async (crowd: Crowd): Promise<void> => {
  const { nick, mike, anna, lena } = crowd;
  await recordOutcome(crowd, nick, { ref: KEN_CONTEXT, outcome: "followed" });
  await recordOutcome(crowd, nick, { ref: KEN_CLAIM, outcome: "overrode", reason: "kept my own cache key" });
  await recordOutcome(crowd, nick, { ref: MIKE_CONTEXT, outcome: "not_relevant_now" });
  await recordOutcome(crowd, nick, { ref: ANNA_CONTEXT, outcome: "followed" });
  await recordOutcome(crowd, mike, { ref: KEN_CONTEXT, outcome: "followed" });
  await recordOutcome(crowd, mike, { ref: KEN_CLAIM, outcome: "followed" });
  await recordOutcome(crowd, mike, { ref: ANNA_CONTEXT, outcome: "overrode", reason: "batched on the hub instead" });
  await labelNoise(crowd, mike, hintDeliveryId(MIKE_SESSION, NICK_CONTEXT));
  await recordOutcome(crowd, anna, { ref: KEN_CONTEXT, outcome: "followed" });
  await recordOutcome(crowd, anna, { ref: MIKE_CONTEXT, outcome: "followed" });
  await recordOutcome(crowd, anna, { ref: NICK_CONTEXT, outcome: "followed" });
  await recordOutcome(crowd, anna, { ref: LENA_CONTEXT, outcome: "not_relevant_now" });
  await recordOutcome(crowd, lena, { ref: KEN_CONTEXT, outcome: "followed" });
  await recordOutcome(crowd, lena, { ref: NICK_CONTEXT, outcome: "overrode", reason: "kept the old importer" });
  await recordOutcome(crowd, lena, { ref: MIKE_CONTEXT, outcome: "followed" });
};
