/**
 * Three teammates on one enrolled repo, for the hint-outcome tests (07 §13).
 *
 * Ken owns a work context and a claim on it; Mike owns a work context. Nick
 * has received three unasked deliveries — Ken's context (a mid-prompt hint),
 * Ken's claim (a mid-prompt hint) and Mike's context (the briefing) — and
 * Mike has received one, pointing at Ken's context. Every id is the one ingest
 * requires (`hintDeliveryId`), and nothing here reaches a real hub.
 */
import { deliveryIdFor, hintDeliveryId } from "@crosscheck/schema";

import {
  TEST_ADMIN_TOKEN,
  TEST_START_ISO,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validClaimBody,
  validWorkContextBody,
} from "../helpers.ts";
import type { TestDeveloper, TestHarness } from "../helpers.ts";

export const REPO = "github.com/acme/api";
export const OTHER_REPO = "github.com/acme/web";

export const NICK_SESSION = "cc_aaaaaaaa-1111-4111-8111-111111111111";
export const NICK_SECOND_SESSION = "cc_aaaaaaaa-2222-4222-8222-222222222222";
export const KEN_SESSION = "cc_bbbbbbbb-1111-4111-8111-111111111111";
export const MIKE_SESSION = "cc_cccccccc-1111-4111-8111-111111111111";

export const KEN_CONTEXT = `wc_${KEN_SESSION}`;
export const KEN_CLAIM = "clm_ken_cache_key";
export const MIKE_CONTEXT = `wc_${MIKE_SESSION}`;

export interface OutcomeWorld {
  readonly harness: TestHarness;
  readonly nick: TestDeveloper;
  readonly ken: TestDeveloper;
  readonly mike: TestDeveloper;
  /** Nick's deliveries, by what they pointed at. */
  readonly delivered: {
    readonly kenContext: string;
    readonly kenClaim: string;
    readonly mikeContext: string;
    /** Mike's one delivery: Ken's context. */
    readonly mikeGotKen: string;
  };
}

const ownContext = (
  sessionId: string,
  title: string,
): Record<string, unknown> =>
  recordEnvelope(
    "work_context",
    validWorkContextBody({
      id: `wc_${sessionId}`,
      sessionId,
      title,
      description: undefined,
      createdAt: TEST_START_ISO,
    }),
    { sessionId },
  );

export const deliveryRecord = (
  sessionId: string,
  refKind: "work_context" | "claim",
  refId: string,
  channel: string,
  deliveredAt: string = TEST_START_ISO,
): Record<string, unknown> =>
  recordEnvelope(
    "hint_delivery",
    { id: deliveryIdFor(sessionId, refId, channel), sessionId, refKind, refId, channel, deliveredAt },
    { sessionId },
  );

const seat = async (
  harness: TestHarness,
  name: string,
  email: string,
  sessionId: string,
): Promise<TestDeveloper> => {
  const developer = await createTestDeveloper(harness, name, email);
  await registerTestSession(harness, developer.apiKey, { id: sessionId, repo: REPO });
  return developer;
};

export const enrol = async (harness: TestHarness, repo: string = REPO): Promise<void> => {
  await harness.app.request(
    "/api/team-settings",
    jsonRequest("PUT", TEST_ADMIN_TOKEN, { repo, pilotEnrolled: true }),
  );
};

export const createOutcomeWorld = async (
  options: { readonly enrolled: boolean; readonly drafts?: "pending" | "confirmed_at_once" } = { enrolled: true },
): Promise<OutcomeWorld> => {
  const harness = await createTestHarness(options.drafts === undefined ? {} : { drafts: options.drafts });
  const nick = await seat(harness, "Nick", "nick-outcomes@example.com", NICK_SESSION);
  const ken = await seat(harness, "Ken", "ken-outcomes@example.com", KEN_SESSION);
  const mike = await seat(harness, "Mike", "mike-outcomes@example.com", MIKE_SESSION);
  await postRecords(harness, ken, {
    records: [
      ownContext(KEN_SESSION, "Widen the filter row"),
      recordEnvelope(
        "claim",
        validClaimBody({
          id: KEN_CLAIM,
          workContextId: KEN_CONTEXT,
          authorSessionId: KEN_SESSION,
          body: "the cache is keyed by repo, not by developer",
        }),
        { sessionId: KEN_SESSION },
      ),
    ],
  });
  await postRecords(harness, mike, {
    records: [
      ownContext(MIKE_SESSION, "CSV export drops the header"),
      deliveryRecord(MIKE_SESSION, "work_context", KEN_CONTEXT, "prompt_hint"),
    ],
  });
  await postRecords(harness, nick, {
    records: [
      ownContext(NICK_SESSION, "Rework the importer"),
      deliveryRecord(NICK_SESSION, "work_context", KEN_CONTEXT, "prompt_hint"),
      deliveryRecord(NICK_SESSION, "claim", KEN_CLAIM, "prompt_hint"),
      deliveryRecord(NICK_SESSION, "work_context", MIKE_CONTEXT, "briefing"),
    ],
  });
  if (options.enrolled) {
    await enrol(harness);
  }
  return {
    harness,
    nick,
    ken,
    mike,
    delivered: {
      kenContext: hintDeliveryId(NICK_SESSION, KEN_CONTEXT),
      kenClaim: hintDeliveryId(NICK_SESSION, KEN_CLAIM),
      mikeContext: hintDeliveryId(NICK_SESSION, MIKE_CONTEXT),
      mikeGotKen: hintDeliveryId(MIKE_SESSION, KEN_CONTEXT),
    },
  };
};

export const recordOutcome = async (
  world: OutcomeWorld,
  developer: TestDeveloper,
  body: Record<string, unknown>,
): Promise<Response> =>
  await world.harness.app.request(
    "/api/hint-outcomes",
    jsonRequest("POST", developer.apiKey, { repo: REPO, ...body }),
  );

/** The person's own word — the route `crosscheck followed / overrode` posts to (07 §13.12). */
export const recordPersonOutcome = async (
  world: OutcomeWorld,
  developer: TestDeveloper,
  body: Record<string, unknown>,
): Promise<Response> =>
  await world.harness.app.request(
    "/api/hint-outcomes/person",
    jsonRequest("POST", developer.apiKey, { repo: REPO, ...body }),
  );

export const readMine = async (
  world: OutcomeWorld,
  developer: TestDeveloper,
  query: string = `repo=${encodeURIComponent(REPO)}`,
): Promise<Response> =>
  await world.harness.app.request(
    `/api/hint-outcomes/mine?${query}`,
    jsonRequest("GET", developer.apiKey),
  );
