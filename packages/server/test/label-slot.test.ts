/**
 * A RETRACTED OR VOIDED LABEL FREES ITS SLOT (round-2 review R2-M1). One label
 * per person per delivery is the precision figure's unit — but a label whose
 * confirmation was retracted (compromised) or never stood (revoked in its
 * cool-off) is nobody's word, so it must not hold that one place: the person's
 * own label on the same hint, confirmed with their own passkey, is written and
 * counts. N4 of the review, against the hub as it runs.
 */
import { describe, expect, test } from "bun:test";
import { PIN_PRESENCE_TERMINAL } from "@crosscheck/schema";

import { pilotMarks } from "../src/db/schema.ts";
import { assertViaUi, viewerOf } from "./fixtures/ceremony-driver.ts";
import { confirmPending, prepareConfirmer } from "./fixtures/confirm-driver.ts";
import type { Confirmer } from "./fixtures/confirm-driver.ts";
import { REPO, createOutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import type { OutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import { jsonRequest } from "./helpers.ts";

const MINUTE_S = 60;

const helpful = (world: OutcomeWorld): Promise<Response> =>
  Promise.resolve(
    world.harness.app.request(
      "/api/pilot-marks",
      jsonRequest("POST", world.nick.apiKey, {
        repo: REPO,
        refKind: "hint_delivery",
        refId: world.delivered.kenContext,
        mark: "helpful",
        presence: PIN_PRESENCE_TERMINAL,
      }),
    ),
  );

const mine = async (world: OutcomeWorld): Promise<Record<string, unknown>> =>
  ((await (
    await world.harness.app.request(`/api/hint-outcomes/mine?repo=${encodeURIComponent(REPO)}`, jsonRequest("GET", world.nick.apiKey))
  ).json()) as { data: Record<string, unknown> }).data;

const confirmWith = async (world: OutcomeWorld, confirmer: Confirmer): Promise<void> => {
  world.harness.clock.advanceSeconds(MINUTE_S);
  const fresh = { ...confirmer, viewer: await viewerOf(world.harness, world.nick) };
  expect((await confirmPending(world.harness, world.nick, fresh)).status).toBe(200);
  world.harness.clock.advanceSeconds(MINUTE_S);
};

describe("the person's own label after a voided one", () => {
  test("N4: a planted passkey's helpful, revoked in its cool-off, leaves the slot to the person's own helpful", async () => {
    // Arrange — a planted (cooling) passkey confirms helpful; the key revokes it during the cool-off
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const planted = await prepareConfirmer(world.harness, world.nick);
    expect((await helpful(world)).status).toBe(201);
    await confirmWith(world, planted);
    const viewer = await viewerOf(world.harness, world.nick);
    const revoked = await world.harness.app.request(`/ui/passkeys/${planted.passkeyId}/revoke`, {
      method: "POST",
      headers: { Cookie: viewer.cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: `_csrf=${encodeURIComponent(viewer.csrf)}`,
    });
    expect(revoked.status).toBe(303);

    // Act — the draft is back on the page; the person confirms it with their own passkey
    const own = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
    await confirmWith(world, own);

    // Assert — a second label row, the person's, and it counts
    expect(await world.harness.db.select({ id: pilotMarks.id }).from(pilotMarks)).toHaveLength(2);
    expect(await mine(world)).toMatchObject({ helpful: 1 });
  });

  test("a helpful retracted as compromised leaves the slot too", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const real = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
    const planted = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
    expect((await helpful(world)).status).toBe(201);
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

    // Act
    await confirmWith(world, real);

    // Assert
    expect(await mine(world)).toMatchObject({ helpful: 1 });
  });

  test("a label in effect still holds the slot: helpful said twice is one label", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const own = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
    expect((await helpful(world)).status).toBe(201);
    await confirmWith(world, own);

    // Act
    expect((await helpful(world)).status).toBe(201);
    await confirmWith(world, own);

    // Assert
    expect(await world.harness.db.select({ id: pilotMarks.id }).from(pilotMarks)).toHaveLength(1);
  });
});
