/**
 * A CONFIRMATION COUNTS ONLY WHILE ITS PASSKEY STANDS (human provenance §5;
 * review H1, the owner's decision).
 *
 * A passkey still cooling off may confirm at once — Q19: the person can act on
 * day one, and what they confirm takes effect — but what it confirmed enters a
 * person's FIGURES only once that passkey is past its announced cool-off, and
 * only while it is unrevoked. Revoking it retracts every word it confirmed,
 * however long ago: the rows stay (append-only) and stop counting. The reports
 * show the waiting ones with the instant they start counting.
 *
 * Against the hub as it runs: drafts left pending, a real passkey enrolled
 * through the ceremony, a real `confirm_batch` assertion, a real revocation.
 */
import { describe, expect, test } from "bun:test";

import { PASSKEY_COOLOFF_HOURS } from "../src/constants.ts";
import { hintOutcomes, passkeys } from "../src/db/schema.ts";
import { assertViaUi, viewerOf } from "./fixtures/ceremony-driver.ts";
import { confirmPending, pendingOf, prepareConfirmer } from "./fixtures/confirm-driver.ts";
import type { Confirmer } from "./fixtures/confirm-driver.ts";
import { KEN_CONTEXT, NICK_SESSION, REPO, createOutcomeWorld, recordOutcome } from "./fixtures/hint-outcome-world.ts";
import type { OutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import { TEST_ADMIN_TOKEN, jsonRequest } from "./helpers.ts";

const SECONDS_PER_HOUR = 3600;
const MINUTE_S = 60;

const mine = async (world: OutcomeWorld): Promise<Record<string, unknown>> => {
  const response = await world.harness.app.request(
    `/api/hint-outcomes/mine?repo=${encodeURIComponent(REPO)}`,
    jsonRequest("GET", world.nick.apiKey),
  );
  return ((await response.json()) as { data: Record<string, unknown> }).data;
};

const confirmFollowed = async (world: OutcomeWorld, confirmer: Confirmer): Promise<void> => {
  expect((await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed", session: NICK_SESSION })).status).toBe(201);
  world.harness.clock.advanceSeconds(MINUTE_S);
  expect((await confirmPending(world.harness, world.nick, confirmer)).status).toBe(200);
};

/**
 * The revocation: by the person in their own session while the passkey is
 * still cooling off (04a: making a credential less capable needs no stronger
 * authority), or by the admin at any time (04a §4.5, a lost device).
 */
const revoke = async (world: OutcomeWorld, confirmer: Confirmer, by: "owner" | "admin"): Promise<void> => {
  const [row] = await world.harness.db.select({ id: passkeys.id }).from(passkeys);
  const revoked =
    by === "owner"
      ? await world.harness.app.request(`/ui/passkeys/${String(row?.id)}/revoke`, {
          method: "POST",
          headers: { Cookie: confirmer.viewer.cookie, "Content-Type": "application/x-www-form-urlencoded" },
          body: `_csrf=${encodeURIComponent(confirmer.viewer.csrf)}`,
        })
      : await world.harness.app.request(
          `/api/developers/${world.nick.developerId}/passkeys/${String(row?.id)}/revoke`,
          jsonRequest("POST", TEST_ADMIN_TOKEN, {}),
        );
  expect(revoked.status).toBe(by === "owner" ? 303 : 200);
};

describe("a confirmation by a passkey still cooling off", () => {
  test("takes effect at once, counts in no figure until the cool-off ends, and the view says from when", async () => {
    // Arrange — a passkey enrolled seconds ago (Q19: it may confirm at once)
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const confirmer = await prepareConfirmer(world.harness, world.nick);
    const [enrolled] = await world.harness.db.select({ usableFrom: passkeys.usableFrom }).from(passkeys);

    // Act
    await confirmFollowed(world, confirmer);
    const whileCooling = await mine(world);
    world.harness.clock.advanceSeconds(PASSKEY_COOLOFF_HOURS * SECONDS_PER_HOUR);
    const afterCoolOff = await mine(world);

    // Assert — written as the person's at once; counted only from the passkey's usable instant
    expect(await world.harness.db.select({ provenance: hintOutcomes.provenance }).from(hintOutcomes)).toEqual([
      { provenance: "human_passkey_confirmed" },
    ]);
    expect(whileCooling).toMatchObject({ followed: 0 });
    expect(whileCooling["notConfirmed"]).toMatchObject({ coolingOff: 1, countingFrom: enrolled?.usableFrom.toISOString() });
    expect(afterCoolOff).toMatchObject({ followed: 1 });
    expect(afterCoolOff["notConfirmed"]).toMatchObject({ coolingOff: 0, countingFrom: null });
  });
});

describe("revoking the passkey that confirmed", () => {
  test("declared compromised, it retracts what it confirmed from every figure — the row stays, and the view says it was retracted", async () => {
    // Arrange — a passkey past its cool-off; a word confirmed with it and counted; a second passkey of the person's
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const confirmer = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
    await confirmFollowed(world, confirmer);
    expect(await mine(world)).toMatchObject({ followed: 1 });
    const other = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });

    // Act — the second passkey declares the first compromised (round-2 R2-H3: a retirement would keep it)
    const declared = await assertViaUi(
      world.harness,
      await viewerOf(world.harness, world.nick),
      other.credential,
      { action: "revoke_passkey", subjectId: confirmer.passkeyId, reason: "compromised" },
      { signCount: other.nextCount() },
    );
    expect(declared.status).toBe(200);
    const after = await mine(world);

    // Assert
    expect(after).toMatchObject({ followed: 0 });
    expect(after["notConfirmed"]).toMatchObject({ retracted: 1 });
    expect(await world.harness.db.select({ provenance: hintOutcomes.provenance }).from(hintOutcomes)).toEqual([
      { provenance: "human_passkey_confirmed" },
    ]);
  });

  test("a planted passkey revoked during its cool-off never counted, and never will — its draft is back on the page", async () => {
    // Arrange — the review's H1: a passkey enrolled with a leaked code confirms everything at once
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const confirmer = await prepareConfirmer(world.harness, world.nick);
    await confirmFollowed(world, confirmer);

    // Act — the person notices the enrolment and revokes it; a day passes
    await revoke(world, confirmer, "owner");
    world.harness.clock.advanceSeconds(PASSKEY_COOLOFF_HOURS * SECONDS_PER_HOUR + MINUTE_S);
    const view = await mine(world);

    // Assert — never stood: not counted, not "retracted" either (round-2 R2-H3); the word waits again
    expect(view).toMatchObject({ followed: 0 });
    expect(view["notConfirmed"]).toMatchObject({ retracted: 0, coolingOff: 0 });
    expect((await pendingOf(world.harness, world.nick)).drafts).toHaveLength(1);
  });
});
