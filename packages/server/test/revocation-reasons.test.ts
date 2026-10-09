/**
 * A REVOCATION HAS A REASON, AND THE REASON DECIDES WHAT IT UNDOES (round-2
 * review R2-H3, the owner's decision).
 *
 *   - `retired` — a lost or replaced device, an RP move; the default for the
 *     owner's and the admin's revoke of a passkey past its cool-off — NEVER
 *     retracts what the passkey confirmed while it stood;
 *   - `compromised` — chosen explicitly in a ceremony signed with ANOTHER of
 *     the person's passkeys, never with a key — retracts every confirmation it
 *     signed, and their drafts return to the person's page;
 *   - a revoke during the cool-off, by any channel, the key included — the
 *     passkey never gained standing, so its confirmations never count, and
 *     their drafts return to the page marked for re-confirmation: the person
 *     loses nothing and confirms again with another passkey.
 *
 * Against the hub as it runs: drafts pending, passkeys enrolled through the
 * ceremony, the real owner, admin and passkey revoke routes.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { PASSKEY_COOLOFF_HOURS } from "../src/constants.ts";
import { assertViaUi, errorCodeOf, viewerOf } from "./fixtures/ceremony-driver.ts";
import type { Viewer } from "./fixtures/ceremony-driver.ts";
import { confirmPending, pendingOf, prepareConfirmer } from "./fixtures/confirm-driver.ts";
import type { Confirmer } from "./fixtures/confirm-driver.ts";
import { KEN_CONTEXT, NICK_SESSION, REPO, createOutcomeWorld, recordOutcome, recordPersonOutcome } from "./fixtures/hint-outcome-world.ts";
import type { OutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import { TEST_ADMIN_TOKEN, jsonRequest } from "./helpers.ts";
import { uiGet } from "./ui-helpers.ts";

const HOUR_S = 3_600;
const MINUTE_S = 60;
const RECONFIRM_COOLING = "re-confirm: the passkey that confirmed these was revoked before it counted";
const RECONFIRM_COMPROMISED = "re-confirm: the passkey that confirmed these was revoked as compromised";

const mine = async (world: OutcomeWorld): Promise<Record<string, unknown>> =>
  ((await (
    await world.harness.app.request(`/api/hint-outcomes/mine?repo=${encodeURIComponent(REPO)}`, jsonRequest("GET", world.nick.apiKey))
  ).json()) as { data: Record<string, unknown> }).data;

const adminRevoke = (world: OutcomeWorld, passkeyId: string, body: Record<string, unknown> = {}): Promise<Response> =>
  Promise.resolve(
    world.harness.app.request(
      `/api/developers/${world.nick.developerId}/passkeys/${passkeyId}/revoke`,
      jsonRequest("POST", TEST_ADMIN_TOKEN, body),
    ),
  );

/** The owner's revoke on /ui/passkeys: a signed-in session and a CSRF token — the key's reach. */
const keyRevoke = (world: OutcomeWorld, viewer: Viewer, passkeyId: string): Promise<Response> =>
  Promise.resolve(
    world.harness.app.request(`/ui/passkeys/${passkeyId}/revoke`, {
      method: "POST",
      headers: { Cookie: viewer.cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: `_csrf=${encodeURIComponent(viewer.csrf)}`,
    }),
  );

/** A `revoke_passkey` ceremony signed by `signer`, with a fresh session. */
const passkeyRevoke = async (
  world: OutcomeWorld,
  signer: Confirmer,
  passkeyId: string,
  reason?: "retired" | "compromised",
): Promise<Response> =>
  assertViaUi(
    world.harness,
    await viewerOf(world.harness, world.nick),
    signer.credential,
    { action: "revoke_passkey", subjectId: passkeyId, ...(reason === undefined ? {} : { reason }) },
    { signCount: signer.nextCount() },
  );

const agentSaysFollowed = async (world: OutcomeWorld): Promise<void> => {
  expect((await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed", session: NICK_SESSION })).status).toBe(201);
};

const confirmWith = async (world: OutcomeWorld, confirmer: Confirmer): Promise<void> => {
  world.harness.clock.advanceSeconds(MINUTE_S);
  const fresh = { ...confirmer, viewer: await viewerOf(world.harness, world.nick) };
  expect((await confirmPending(world.harness, world.nick, fresh)).status).toBe(200);
  world.harness.clock.advanceSeconds(MINUTE_S);
};

const revokeReasonOf = async (world: OutcomeWorld, passkeyId: string): Promise<unknown> =>
  (await world.harness.db.execute<{ r: string | null }>(sql`SELECT revoke_reason AS r FROM passkeys WHERE id = ${passkeyId}`)).rows[0]?.r;

describe("retired: a passkey that stood keeps what it confirmed", () => {
  test("the admin's revoke for a lost laptop retires it: the person's words still count, nothing returns to the page", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const laptop = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
    await agentSaysFollowed(world);
    await confirmWith(world, laptop);

    // Act
    const revoked = await adminRevoke(world, laptop.passkeyId);

    // Assert
    expect(revoked.status).toBe(200);
    expect(await revokeReasonOf(world, laptop.passkeyId)).toBe("retired");
    expect(await mine(world)).toMatchObject({ followed: 1, notConfirmed: { retracted: 0 } });
    expect((await pendingOf(world.harness, world.nick)).drafts).toEqual([]);
  });

  test("N11: another passkey revoking the person's real one retires it by default — the person's history stays", async () => {
    // Arrange — the person's word, then a second passkey past its cool-off
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const real = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
    expect((await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "overrode", reason: "mine" })).status).toBe(201);
    await confirmWith(world, real);
    const other = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });

    // Act
    const revoked = await passkeyRevoke(world, other, real.passkeyId);

    // Assert
    expect(revoked.status).toBe(200);
    expect(await revokeReasonOf(world, real.passkeyId)).toBe("retired");
    expect(await mine(world)).toMatchObject({ overrode: 1, notConfirmed: { retracted: 0 } });
  });
});

describe("a revoke during the cool-off: the passkey never stood", () => {
  test("N5: the key revoking the person's day-one passkey loses the person nothing — the drafts return, marked, and count once confirmed again", async () => {
    // Arrange — the person confirms on day one; at hour 23 the agent, in its own session, revokes that passkey
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const dayOne = await prepareConfirmer(world.harness, world.nick);
    expect((await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "overrode", reason: "mine" })).status).toBe(201);
    await confirmWith(world, dayOne);
    world.harness.clock.advanceSeconds((PASSKEY_COOLOFF_HOURS - 1) * HOUR_S);
    expect((await keyRevoke(world, await viewerOf(world.harness, world.nick), dayOne.passkeyId)).status).toBe(303);
    world.harness.clock.advanceSeconds(2 * HOUR_S);

    // Act
    const view = await mine(world);
    const pending = await pendingOf(world.harness, world.nick);
    const page = await (await uiGet(world.harness, "/ui/confirm", (await viewerOf(world.harness, world.nick)).cookie)).text();
    const second = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
    await confirmWith(world, second);

    // Assert — never counted, not "retracted"; the word is back on the page, and counts once re-confirmed
    expect(view).toMatchObject({ overrode: 0, notConfirmed: { retracted: 0 } });
    expect(pending.drafts.map((draft) => draft.payload["word"])).toEqual(["overrode"]);
    expect(page).toContain(RECONFIRM_COOLING);
    expect(await mine(world)).toMatchObject({ overrode: 1 });
  });
});

describe("compromised: chosen in a ceremony with another passkey", () => {
  test("it retracts every confirmation the passkey signed, and their drafts return to the page", async () => {
    // Arrange — the person's passkey, and a planted one (past its cool-off) that confirmed the agent's word
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const real = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
    const planted = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
    await agentSaysFollowed(world);
    await confirmWith(world, planted);
    expect(await mine(world)).toMatchObject({ followed: 1 });

    // Act
    const revoked = await passkeyRevoke(world, real, planted.passkeyId, "compromised");
    const page = await (await uiGet(world.harness, "/ui/confirm", (await viewerOf(world.harness, world.nick)).cookie)).text();

    // Assert
    expect(revoked.status).toBe(200);
    expect(await revokeReasonOf(world, planted.passkeyId)).toBe("compromised");
    expect(await mine(world)).toMatchObject({ followed: 0, notConfirmed: { retracted: 1 } });
    expect((await pendingOf(world.harness, world.nick)).drafts.map((draft) => draft.payload["word"])).toEqual(["followed"]);
    expect(page).toContain(RECONFIRM_COMPROMISED);
  });

  test("never by a key or the admin token, and never with the passkey being revoked", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const planted = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
    await agentSaysFollowed(world);
    await confirmWith(world, planted);

    // Act
    const byAdmin = await adminRevoke(world, planted.passkeyId, { reason: "compromised" });
    const bySelf = await passkeyRevoke(world, planted, planted.passkeyId, "compromised");

    // Assert — both refused, nothing revoked, the word still counts
    expect(byAdmin.status).toBe(400);
    expect(bySelf.status).toBe(422);
    expect(await errorCodeOf(bySelf)).toBe("compromised_needs_another_passkey");
    expect(await revokeReasonOf(world, planted.passkeyId)).toBeNull();
    expect(await mine(world)).toMatchObject({ followed: 1 });
  });

  test("a passkey the admin retired can be declared compromised later, by another passkey of the person's", async () => {
    // Arrange — the admin retires the planted passkey at once; the person's own one signs later
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const real = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
    const planted = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
    await agentSaysFollowed(world);
    await confirmWith(world, planted);
    expect((await adminRevoke(world, planted.passkeyId)).status).toBe(200);
    expect(await mine(world)).toMatchObject({ followed: 1 });

    // Act
    const declared = await passkeyRevoke(world, real, planted.passkeyId, "compromised");

    // Assert
    expect(declared.status).toBe(200);
    expect(await revokeReasonOf(world, planted.passkeyId)).toBe("compromised");
    expect(await mine(world)).toMatchObject({ followed: 0, notConfirmed: { retracted: 1 } });
  });
});
