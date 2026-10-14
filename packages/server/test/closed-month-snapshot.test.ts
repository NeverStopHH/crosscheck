/**
 * A CLOSED MONTH IS A SNAPSHOT TAKEN AT ITS CLOSE (round-2 review R2-H1, the
 * owner's decision). Signer standing is read as of the month's END, never at
 * the read: a passkey retired afterwards, a cool-off ending afterwards, or a
 * passkey declared compromised afterwards never moves the month — two reads of
 * it can never single out the person whose passkey changed. A compromise adds
 * a correction line beneath it instead; a confirmation whose passkey gains
 * standing after the month closed counts in the month it gained standing,
 * marked late, like any late word.
 *
 * Against the hub as it runs: a five-person team, drafts pending, every word
 * confirmed with a real passkey, the real admin and passkey revoke routes.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { readPeriodAggregate } from "../src/services/outcome-population.ts";
import { assertViaUi, viewerOf } from "./fixtures/ceremony-driver.ts";
import { confirmPending, prepareConfirmer } from "./fixtures/confirm-driver.ts";
import type { Confirmer } from "./fixtures/confirm-driver.ts";
import {
  ANNA_CONTEXT,
  ANNA_SESSION,
  LENA_CONTEXT,
  LENA_SESSION,
  NICK_CONTEXT,
  SECONDS_TO_AUGUST,
  addTeammate,
  recordCrowdWords,
} from "./fixtures/hint-outcome-crowd.ts";
import type { Crowd } from "./fixtures/hint-outcome-crowd.ts";
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
} from "./fixtures/hint-outcome-world.ts";
import { TEST_ADMIN_TOKEN, jsonRequest, postRecords } from "./helpers.ts";
import type { TestDeveloper } from "./helpers.ts";

const DAY_S = 86_400;
const HOUR_S = 3_600;
const JULY = { from: new Date("2026-07-01T00:00:00.000Z"), until: new Date("2026-08-01T00:00:00.000Z") };
const AUGUST = { from: new Date("2026-08-01T00:00:00.000Z"), until: new Date("2026-09-01T00:00:00.000Z") };

type Ref = readonly ["work_context" | "claim", string];

/** The five-person team of fixtures/hint-outcome-crowd.ts, with drafts left pending. */
const pendingCrowd = async (): Promise<Crowd> => {
  const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
  const anna = await addTeammate(world, "Anna", ANNA_SESSION);
  const lena = await addTeammate(world, "Lena", LENA_SESSION);
  const ctx = (ref: string): Ref => ["work_context", ref];
  const kenClaim: Ref = ["claim", KEN_CLAIM];
  const deliver = (developer: TestDeveloper, session: string, refs: readonly Ref[]) =>
    postRecords(world.harness, developer, { records: refs.map(([kind, ref]) => deliveryRecord(session, kind, ref, "prompt_hint")) });
  await deliver(world.nick, NICK_SESSION, [ctx(ANNA_CONTEXT), ctx(LENA_CONTEXT)]);
  await deliver(world.ken, KEN_SESSION, [ctx(NICK_CONTEXT), ctx(MIKE_CONTEXT), ctx(ANNA_CONTEXT), ctx(LENA_CONTEXT)]);
  await deliver(world.mike, MIKE_SESSION, [kenClaim, ctx(NICK_CONTEXT), ctx(ANNA_CONTEXT), ctx(LENA_CONTEXT)]);
  await deliver(anna, ANNA_SESSION, [ctx(KEN_CONTEXT), kenClaim, ctx(NICK_CONTEXT), ctx(MIKE_CONTEXT), ctx(LENA_CONTEXT)]);
  await deliver(lena, LENA_SESSION, [ctx(KEN_CONTEXT), kenClaim, ctx(NICK_CONTEXT), ctx(MIKE_CONTEXT), ctx(ANNA_CONTEXT)]);
  return { ...world, anna, lena };
};

const teamLine = async (crowd: Crowd): Promise<Record<string, unknown>> => {
  const response = await crowd.harness.app.request(`/api/pilot/report?repo=${encodeURIComponent(REPO)}`, jsonRequest("GET", crowd.nick.apiKey));
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: { outcomes: Record<string, unknown> } }).data.outcomes;
};

/** July: the crowd's fifteen words and Ken's three, each person confirming with their own passkey. Returns Ken's. */
const julyConfirmed = async (crowd: Crowd): Promise<Confirmer> => {
  await recordCrowdWords(crowd);
  expect((await recordOutcome(crowd, crowd.ken, { ref: NICK_CONTEXT, outcome: "followed" })).status).toBe(201);
  expect((await recordOutcome(crowd, crowd.ken, { ref: MIKE_CONTEXT, outcome: "overrode", reason: "kept the old loop" })).status).toBe(201);
  expect((await recordOutcome(crowd, crowd.ken, { ref: ANNA_CONTEXT, outcome: "followed" })).status).toBe(201);
  crowd.harness.clock.advanceSeconds(60);
  let kens: Confirmer | undefined;
  for (const person of [crowd.nick, crowd.mike, crowd.anna, crowd.lena, crowd.ken]) {
    const confirmer = await prepareConfirmer(crowd.harness, person, { pastCoolOff: true });
    expect((await confirmPending(crowd.harness, person, confirmer)).status).toBe(200);
    kens = person === crowd.ken ? confirmer : kens;
  }
  if (kens === undefined) {
    throw new Error("Ken confirmed nothing");
  }
  crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);
  return kens;
};

describe("R2-H1: July, read twice in August, is the same July", () => {
  test("N1: the admin retiring Ken's lost laptop moves nothing, and adds no line", async () => {
    // Arrange
    const crowd = await pendingCrowd();
    const kens = await julyConfirmed(crowd);
    const before = await teamLine(crowd);

    // Act
    const retired = await crowd.harness.app.request(
      `/api/developers/${crowd.ken.developerId}/passkeys/${kens.passkeyId}/revoke`,
      jsonRequest("POST", TEST_ADMIN_TOKEN, {}),
    );
    crowd.harness.clock.advanceSeconds(60);
    const after = await teamLine(crowd);

    // Assert
    expect(retired.status).toBe(200);
    expect(before["periodStartIso"]).toBe("2026-07-01T00:00:00.000Z");
    expect(before["withheld"]).toBeNull();
    expect(after["figures"]).toEqual(before["figures"]);
    expect(after["laterRetracted"]).toBeNull();
  }, 120_000);

  test("Ken's passkey declared compromised in August: July's figures stay as they closed, with a correction line beneath", async () => {
    // Arrange — Ken enrols a second passkey and declares the first compromised
    const crowd = await pendingCrowd();
    const kens = await julyConfirmed(crowd);
    const before = await teamLine(crowd);
    const second = await prepareConfirmer(crowd.harness, crowd.ken, { pastCoolOff: true });

    // Act
    const declared = await assertViaUi(
      crowd.harness,
      await viewerOf(crowd.harness, crowd.ken),
      second.credential,
      { action: "revoke_passkey", subjectId: kens.passkeyId, reason: "compromised" },
      { signCount: second.nextCount() },
    );
    crowd.harness.clock.advanceSeconds(60);
    const after = await teamLine(crowd);

    // Assert — one person's words: the correction names no count, only that there is one
    expect(declared.status).toBe(200);
    expect(after["figures"]).toEqual(before["figures"]);
    expect(before["laterRetracted"]).toBeNull();
    expect(after["laterRetracted"]).toEqual({ withheld: "below_minimums", count: null });
  }, 120_000);

  test("N2: a July word whose passkey's cool-off ends on 1 August never moves July — it counts in August, marked late", async () => {
    // Arrange — 31 July 23:00: a fresh passkey confirms a July word
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    world.harness.clock.advanceSeconds(7 * DAY_S + 14 * HOUR_S);
    const confirmer = await prepareConfirmer(world.harness, world.nick);
    expect((await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed", session: NICK_SESSION })).status).toBe(201);
    expect((await confirmPending(world.harness, world.nick, confirmer)).status).toBe(200);
    const read = (period: typeof JULY) => readPeriodAggregate(world.harness.db, { repo: REPO, ...period, who: sql`true`, sourceIs: null });

    // Act — July read on 1 August at 01:00, and again on 2 August, after the cool-off ended
    world.harness.clock.advanceSeconds(2 * HOUR_S);
    const early = await read(JULY);
    world.harness.clock.advanceSeconds(23 * HOUR_S);
    const later = await read(JULY);
    const august = await read(AUGUST);

    // Assert
    expect([early.followed, later.followed]).toEqual([0, 0]);
    expect(august).toMatchObject({ followed: 0, late: { followed: 1 } });
  });
});
