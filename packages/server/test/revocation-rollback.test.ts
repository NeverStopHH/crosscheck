/**
 * WHAT A RETRACTED CONFIRMATION DID IS UNDONE (round-2 review R2-M3, the
 * owner's decision). On a `compromised` revoke, and on a revoke during the
 * cool-off (the passkey never stood), every effect its confirmations had is
 * rolled back: a planted break is disarmed, a planted presence-on goes back to
 * off, planted mutes and unmutes are reverted, and a planted pin protects
 * nothing. A `retired` revoke keeps every effect — the passkey stood.
 *
 * Against the hub as it runs: the drafts pending, two passkeys through the
 * ceremony, the real revoke routes.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PIN_PRESENCE_TERMINAL } from "@crosscheck/schema";

import { assertViaUi, viewerOf } from "./fixtures/ceremony-driver.ts";
import { confirmPending, prepareConfirmer } from "./fixtures/confirm-driver.ts";
import type { Confirmer } from "./fixtures/confirm-driver.ts";
import { REPO, createOutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import type { OutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import { TEST_ADMIN_TOKEN, jsonRequest } from "./helpers.ts";

const MINUTE_S = 60;

const send = (world: OutcomeWorld, method: string, path: string, body?: unknown): Promise<Response> =>
  Promise.resolve(world.harness.app.request(path, jsonRequest(method, world.nick.apiKey, body)));

const pinBody = (id: string, surface: string) => ({
  id,
  repo: REPO,
  surface,
  files: [`src/${id}.ts`],
  check: "open the page",
  presence: PIN_PRESENCE_TERMINAL,
  verifiedAtCommit: "abc1234",
});

const confirmWith = async (world: OutcomeWorld, confirmer: Confirmer): Promise<void> => {
  world.harness.clock.advanceSeconds(MINUTE_S);
  const fresh = { ...confirmer, viewer: await viewerOf(world.harness, world.nick) };
  expect((await confirmPending(world.harness, world.nick, fresh)).status).toBe(200);
  world.harness.clock.advanceSeconds(MINUTE_S);
};

interface Effects {
  readonly pinBroken: boolean;
  readonly plantedPinListed: boolean;
  readonly optedOut: boolean;
  readonly muted: readonly string[];
}

const effectsOf = async (world: OutcomeWorld): Promise<Effects> => {
  const registry = ((await (await send(world, "GET", `/api/pins?repo=${encodeURIComponent(REPO)}`)).json()) as {
    data: { pins: { id: string; brokeAt: string | null }[] };
  }).data.pins;
  const optedOut = await world.harness.db.execute<{ o: boolean }>(
    sql`SELECT presence_opt_out AS o FROM developers WHERE id = ${world.nick.developerId}`,
  );
  const muted = await world.harness.db.execute<{ id: string }>(
    sql`SELECT muted_developer_id AS id FROM developer_mutes WHERE reader_developer_id = ${world.nick.developerId} ORDER BY 1`,
  );
  return {
    pinBroken: registry.find((pin) => pin.id === "pin_mine")?.brokeAt !== null,
    plantedPinListed: registry.some((pin) => pin.id === "pin_planted"),
    optedOut: optedOut.rows[0]?.o === true,
    muted: muted.rows.map((row) => row.id),
  };
};

/**
 * The person's own state, confirmed with `real`: a pin, Mike muted, presence
 * off. Then `planted` confirms the opposite of each, and a pin of its own.
 */
const plantedWorld = async (plantedPastCoolOff: boolean) => {
  const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
  const real = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
  expect((await send(world, "POST", "/api/pins", pinBody("pin_mine", "Export keeps the header"))).status).toBe(202);
  expect((await send(world, "POST", "/api/settings/mutes", { developer: world.mike.developerId })).status).toBe(202);
  await confirmWith(world, real);
  expect((await send(world, "PUT", "/api/settings/presence", { optOut: true })).status).toBe(200);
  const planted = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: plantedPastCoolOff });
  expect((await send(world, "POST", "/api/pins/pin_mine/broke", { repo: REPO, presence: PIN_PRESENCE_TERMINAL })).status).toBe(202);
  expect((await send(world, "PUT", "/api/settings/presence", { optOut: false })).status).toBe(202);
  expect((await send(world, "POST", "/api/settings/mutes", { developer: world.ken.developerId })).status).toBe(202);
  expect((await send(world, "DELETE", `/api/settings/mutes/${world.mike.developerId}`)).status).toBe(202);
  expect((await send(world, "POST", "/api/pins", pinBody("pin_planted", "Import keeps the order"))).status).toBe(202);
  await confirmWith(world, planted);
  const plantedEffects: Effects = {
    pinBroken: true,
    plantedPinListed: true,
    optedOut: false,
    muted: [world.ken.developerId],
  };
  expect(await effectsOf(world)).toEqual(plantedEffects);
  return { world, real, planted };
};

const before = (world: OutcomeWorld): Effects => ({
  pinBroken: false,
  plantedPinListed: false,
  optedOut: true,
  muted: [world.mike.developerId],
});

describe("a retracted confirmation's effects are rolled back", () => {
  test("compromised: the break disarmed, presence off again, the mutes as they were, the planted pin protects nothing", async () => {
    // Arrange
    const { world, real, planted } = await plantedWorld(true);

    // Act — the person's own passkey declares the planted one compromised
    const revoked = await assertViaUi(
      world.harness,
      await viewerOf(world.harness, world.nick),
      real.credential,
      { action: "revoke_passkey", subjectId: planted.passkeyId, reason: "compromised" },
      { signCount: real.nextCount() },
    );

    // Assert
    expect(revoked.status).toBe(200);
    expect(await effectsOf(world)).toEqual(before(world));
  });

  test("a revoke during the cool-off: the same roll-back — the passkey never stood", async () => {
    // Arrange — the planted passkey is still in its cool-off; the key revokes it
    const { world, planted } = await plantedWorld(false);
    const viewer = await viewerOf(world.harness, world.nick);

    // Act
    const revoked = await world.harness.app.request(`/ui/passkeys/${planted.passkeyId}/revoke`, {
      method: "POST",
      headers: { Cookie: viewer.cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: `_csrf=${encodeURIComponent(viewer.csrf)}`,
    });

    // Assert
    expect(revoked.status).toBe(303);
    expect(await effectsOf(world)).toEqual(before(world));
  });

  test("retired: every effect stays — the passkey stood when it confirmed", async () => {
    // Arrange
    const { world, planted } = await plantedWorld(true);

    // Act
    const revoked = await world.harness.app.request(
      `/api/developers/${world.nick.developerId}/passkeys/${planted.passkeyId}/revoke`,
      jsonRequest("POST", TEST_ADMIN_TOKEN, {}),
    );

    // Assert
    expect(revoked.status).toBe(200);
    expect(await effectsOf(world)).toEqual({
      pinBroken: true,
      plantedPinListed: true,
      optedOut: false,
      muted: [world.ken.developerId],
    });
  });
});
