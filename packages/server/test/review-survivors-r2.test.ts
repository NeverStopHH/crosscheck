/**
 * THE ROUND-2 REVIEW'S SURVIVING MUTATIONS, EACH KILLED BY THE TEST IT NAMED
 * (review round 2, §4).
 *
 *   - R3: the write path reads only a helpful label IN EFFECT — a retracted
 *     helpful on a twin delivery never cancels the person's noise, so their
 *     own followed said again is written and stands;
 *   - R7: noise said again in a later month is a late word of that month —
 *     the re-assertion is what makes the pointer part of it.
 *
 * (R2, the break's own signer, is in pilot-report.test.ts beside proof 3.)
 * Against the hub as it runs: drafts pending, real passkeys, real ceremonies.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PIN_PRESENCE_TERMINAL, deliveryIdFor } from "@crosscheck/schema";

import { readPeriodAggregate } from "../src/services/outcome-population.ts";
import { assertViaUi, viewerOf } from "./fixtures/ceremony-driver.ts";
import { confirmPending, prepareConfirmer } from "./fixtures/confirm-driver.ts";
import type { Confirmer } from "./fixtures/confirm-driver.ts";
import {
  KEN_CONTEXT,
  NICK_SESSION,
  REPO,
  createOutcomeWorld,
  deliveryRecord,
  recordPersonOutcome,
} from "./fixtures/hint-outcome-world.ts";
import type { OutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import { jsonRequest, postRecords } from "./helpers.ts";

const MINUTE_S = 60;
const DAY_S = 86_400;
const AUGUST = { from: new Date("2026-08-01T00:00:00.000Z"), until: new Date("2026-09-01T00:00:00.000Z") };

const label = (world: OutcomeWorld, refId: string, mark: "noise" | "helpful"): Promise<Response> =>
  Promise.resolve(
    world.harness.app.request(
      "/api/pilot-marks",
      jsonRequest("POST", world.nick.apiKey, { repo: REPO, refKind: "hint_delivery", refId, mark, presence: PIN_PRESENCE_TERMINAL }),
    ),
  );

const confirmWith = async (world: OutcomeWorld, confirmer: Confirmer): Promise<void> => {
  world.harness.clock.advanceSeconds(MINUTE_S);
  const fresh = { ...confirmer, viewer: await viewerOf(world.harness, world.nick) };
  expect((await confirmPending(world.harness, world.nick, fresh)).status).toBe(200);
  world.harness.clock.advanceSeconds(MINUTE_S);
};

const mine = async (world: OutcomeWorld): Promise<Record<string, unknown>> =>
  ((await (
    await world.harness.app.request(`/api/hint-outcomes/mine?repo=${encodeURIComponent(REPO)}`, jsonRequest("GET", world.nick.apiKey))
  ).json()) as { data: Record<string, unknown> }).data;

describe("survivor R3: a retracted helpful on a twin never stands on the write path", () => {
  test("the person's followed said again after their noise is written and stands, whatever a retracted helpful said", async () => {
    // Arrange — own followed, then noise (P1); helpful on the pointer's tripwire twin (P2); P2 declared compromised
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const real = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
    expect((await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" })).status).toBe(201);
    await confirmWith(world, real);
    expect((await label(world, world.delivered.kenContext, "noise")).status).toBe(201);
    await confirmWith(world, real);
    const twin = deliveryIdFor(NICK_SESSION, KEN_CONTEXT, "tripwire");
    await postRecords(world.harness, world.nick, {
      records: [deliveryRecord(NICK_SESSION, "work_context", KEN_CONTEXT, "tripwire", world.harness.clock.now().toISOString())],
    });
    const planted = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
    expect((await label(world, twin, "helpful")).status).toBe(201);
    await confirmWith(world, planted);
    expect(
      (
        await assertViaUi(
          world.harness,
          await viewerOf(world.harness, world.nick),
          real.credential,
          { action: "revoke_passkey", subjectId: planted.passkeyId, reason: "compromised" },
          { signCount: real.nextCount() },
        )
      ).status,
    ).toBe(200);

    // Act — the person's own followed, said again, confirmed with P1 (the returned helpful left for later)
    expect((await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" })).status).toBe(201);
    world.harness.clock.advanceSeconds(MINUTE_S);
    const signed = await confirmPending(
      world.harness,
      world.nick,
      { ...real, viewer: await viewerOf(world.harness, world.nick) },
      (draft) => ({ decision: draft.kind === "outcome" ? "confirm" : "keep" }),
    );

    // Assert
    expect(signed.status).toBe(200);
    expect(await mine(world)).toMatchObject({ followed: 1, noise: 0 });
  });
});

describe("survivor R7: noise said again in a later month is that month's late word", () => {
  test("a July pointer whose noise is said again on 2 August counts late in August", async () => {
    // Arrange — July: noise, then the person's followed over it; 2 August: noise again, confirmed
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const real = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
    expect((await label(world, world.delivered.kenContext, "noise")).status).toBe(201);
    await confirmWith(world, real);
    expect((await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" })).status).toBe(201);
    await confirmWith(world, real);
    world.harness.clock.advanceSeconds(9 * DAY_S);
    expect((await label(world, world.delivered.kenContext, "noise")).status).toBe(201);
    await confirmWith(world, real);

    // Act
    const august = await readPeriodAggregate(world.harness.db, { repo: REPO, ...AUGUST, who: sql`true`, sourceIs: null });

    // Assert
    expect(august.late).toMatchObject({ noise: 1, followed: 0 });
  });
});
