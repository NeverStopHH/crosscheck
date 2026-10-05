/**
 * A team big enough for a shared outcome figure (07 §13.9, review #4/#10).
 *
 * The three-teammate world plus Anna, and enough unasked deliveries in July
 * 2026 that three people (Nick, Mike, Anna) can record ten words about four
 * people's work (Ken's context and claim, Mike's, Anna's and Nick's contexts):
 * the smallest population the team line and the source credit may print.
 *
 *   Nick → Ken's context, Ken's claim, Mike's context (world), Anna's context
 *   Mike → Ken's context (world), Ken's claim, Anna's context, Nick's context
 *   Anna → Ken's context, Mike's context, Nick's context
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
export const ANNA_CONTEXT = `wc_${ANNA_SESSION}`;
export const NICK_CONTEXT = `wc_${NICK_SESSION}`;

/** 2026-07-24 (the world's clock) to 2026-08-02: July becomes the last whole month. */
export const SECONDS_TO_AUGUST = 9 * 86_400;

export interface Crowd extends OutcomeWorld {
  readonly anna: TestDeveloper;
}

export const createCrowd = async (): Promise<Crowd> => {
  const world = await createOutcomeWorld();
  const anna = await createTestDeveloper(world.harness, "Anna", "anna-outcomes@example.com");
  await registerTestSession(world.harness, anna.apiKey, { id: ANNA_SESSION, repo: REPO });
  await postRecords(world.harness, anna, {
    records: [
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          id: ANNA_CONTEXT,
          sessionId: ANNA_SESSION,
          title: "Batch the uploads",
          description: undefined,
          createdAt: TEST_START_ISO,
        }),
        { sessionId: ANNA_SESSION },
      ),
      deliveryRecord(ANNA_SESSION, "work_context", KEN_CONTEXT, "prompt_hint"),
      deliveryRecord(ANNA_SESSION, "work_context", MIKE_CONTEXT, "prompt_hint"),
      deliveryRecord(ANNA_SESSION, "work_context", NICK_CONTEXT, "prompt_hint"),
    ],
  });
  await postRecords(world.harness, world.nick, {
    records: [deliveryRecord(NICK_SESSION, "work_context", ANNA_CONTEXT, "prompt_hint")],
  });
  await postRecords(world.harness, world.mike, {
    records: [
      deliveryRecord(MIKE_SESSION, "claim", KEN_CLAIM, "prompt_hint"),
      deliveryRecord(MIKE_SESSION, "work_context", ANNA_CONTEXT, "prompt_hint"),
      deliveryRecord(MIKE_SESSION, "work_context", NICK_CONTEXT, "prompt_hint"),
    ],
  });
  return { ...world, anna };
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
 * Ten recorded words by three people about four people's work, one delivery
 * left unmarked: followed 6 · overrode 2 · not relevant now 1 · noise 1 ·
 * unmarked 1, over 11 interventions. `skip` leaves one more word unsaid.
 */
export const recordTenWords = async (crowd: Crowd, options: { readonly skip?: boolean } = {}): Promise<void> => {
  const { nick, mike, anna } = crowd;
  await recordOutcome(crowd, nick, { ref: KEN_CONTEXT, outcome: "followed" });
  await recordOutcome(crowd, nick, { ref: KEN_CLAIM, outcome: "overrode", reason: "kept my own cache key" });
  await recordOutcome(crowd, nick, { ref: MIKE_CONTEXT, outcome: "not_relevant_now" });
  await recordOutcome(crowd, nick, { ref: ANNA_CONTEXT, outcome: "followed" });
  await recordOutcome(crowd, mike, { ref: KEN_CONTEXT, outcome: "followed" });
  await recordOutcome(crowd, mike, { ref: KEN_CLAIM, outcome: "followed" });
  await recordOutcome(crowd, mike, { ref: ANNA_CONTEXT, outcome: "overrode", reason: "batched on the hub instead" });
  await labelNoise(crowd, mike, hintDeliveryId(MIKE_SESSION, NICK_CONTEXT));
  await recordOutcome(crowd, anna, { ref: KEN_CONTEXT, outcome: "followed" });
  if (options.skip !== true) {
    await recordOutcome(crowd, anna, { ref: MIKE_CONTEXT, outcome: "followed" });
  }
};
