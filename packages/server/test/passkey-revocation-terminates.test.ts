/**
 * 04a D-PK-1 (Nick, 2026-10-02): revoking a passkey terminates the live
 * waivers it authorised.
 *
 * A grant names the credential that signed it. When that credential is
 * revoked — by its owner during the cool-off, by another passkey's ceremony,
 * or by the admin — every live grant it signed stops holding its fence open
 * at once. APPEND-ONLY: the grant is never deleted or edited; the hub writes
 * a new `revoke` row superseding it, authority `system`, reason
 * `authorizing_credential_revoked`, naming the revoked credential and no
 * person — in the same transaction that revokes the passkey.
 */
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { AUTHORIZING_CREDENTIAL_REVOKED, SYSTEM_WAIVER_AUTHORITY } from "@crosscheck/schema";

import { fenceWaivers, passkeys, pins } from "../src/db/schema.ts";
import { revokePasskey } from "../src/services/passkeys.ts";
import type { PasskeyRevocation } from "../src/services/passkeys.ts";
import { grantWaiver, readLiveWaiver, revokeWaiver } from "../src/services/waivers.ts";
import { seedPasskey } from "./fixtures/passkeys.ts";
import { createTestDeveloper, createTestHarness } from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const REPO = "github.com/acme/api";
const HOUR = 3_600_000;
const NOW = new Date("2026-10-02T12:00:00.000Z");
/** Every seeded passkey is past its cool-off unless a test says otherwise. */
const ENROLLED = new Date("2026-09-01T00:00:00.000Z");

const seedPin = async (harness: TestHarness, id: string, developerId: string): Promise<void> => {
  await harness.db.insert(pins).values({
    id,
    repo: REPO,
    surface: `surface of ${id}`,
    verifiedBy: developerId,
    verifiedAtCommit: "a1b2c3d",
    verifiedAt: ENROLLED,
    checkRecipe: "bun test",
    captureMode: "human",
    createdAt: ENROLLED,
  });
};

const grant = async (
  harness: TestHarness,
  input: { pinId: string; developerId: string; credentialId: string; expiresAt?: Date; at?: Date },
): Promise<string> => {
  const outcome = await grantWaiver({
    db: harness.db,
    repo: REPO,
    pinId: input.pinId,
    pinVersion: 1,
    grantedBy: input.developerId,
    reason: "the fix lands Monday",
    expiresAt: input.expiresAt ?? new Date(NOW.getTime() + 24 * HOUR),
    now: input.at ?? new Date(NOW.getTime() - HOUR),
    credentialId: input.credentialId,
    requestId: null,
  });
  if (!("id" in outcome)) {
    throw new Error(outcome.refusal);
  }
  return outcome.id;
};

const live = (harness: TestHarness, pinId: string) =>
  readLiveWaiver({ db: harness.db, repo: REPO, pinId, pinVersion: 1, now: NOW });

const closuresOf = (harness: TestHarness, grantId: string) =>
  harness.db.select().from(fenceWaivers).where(and(eq(fenceWaivers.kind, "revoke"), eq(fenceWaivers.supersedes, grantId)));

const setup = async () => {
  const harness = await createTestHarness();
  const nick = (await createTestDeveloper(harness, "Nick", "nick-dpk1@example.com")).developerId;
  await seedPin(harness, "pin_a", nick);
  await seedPin(harness, "pin_b", nick);
  const laptop = await seedPasskey(harness.db, nick, { createdAt: ENROLLED });
  const phone = await seedPasskey(harness.db, nick, { createdAt: ENROLLED });
  return { harness, nick, laptop, phone };
};

describe("revoking a passkey terminates the live waivers it authorised (04a D-PK-1)", () => {
  test("the fence closes with a hub-written revoke row naming the credential, and the grant is untouched", async () => {
    // Arrange
    const { harness, nick, laptop } = await setup();
    const grantId = await grant(harness, { pinId: "pin_a", developerId: nick, credentialId: laptop.credentialId });
    const [before] = await harness.db.select().from(fenceWaivers).where(eq(fenceWaivers.id, grantId));

    // Act
    const outcome = await revokePasskey({ db: harness.db, passkeyId: laptop.id, by: { kind: "admin" }, now: NOW });

    // Assert
    expect(outcome).toEqual({ revoked: true, terminated: 1 });
    expect(await live(harness, "pin_a")).toBeNull();
    const closures = await closuresOf(harness, grantId);
    expect(closures).toHaveLength(1);
    expect(closures[0]).toMatchObject({
      authority: SYSTEM_WAIVER_AUTHORITY,
      reason: AUTHORIZING_CREDENTIAL_REVOKED,
      credentialId: laptop.credentialId,
      grantedBy: null,
      pinId: "pin_a",
      pinVersion: 1,
      createdAt: NOW,
    });
    const [after] = await harness.db.select().from(fenceWaivers).where(eq(fenceWaivers.id, grantId));
    expect(after).toEqual(before);
  });

  test("a waiver another passkey authorised stays open", async () => {
    // Arrange
    const { harness, nick, laptop, phone } = await setup();
    await grant(harness, { pinId: "pin_a", developerId: nick, credentialId: laptop.credentialId });
    await grant(harness, { pinId: "pin_b", developerId: nick, credentialId: phone.credentialId });

    // Act
    await revokePasskey({ db: harness.db, passkeyId: laptop.id, by: { kind: "admin" }, now: NOW });

    // Assert
    expect(await live(harness, "pin_a")).toBeNull();
    expect((await live(harness, "pin_b"))?.authority).toBe("passkey");
  });

  test("an expired grant and one a person already closed get no second closure", async () => {
    // Arrange
    const { harness, nick, laptop } = await setup();
    const expired = await grant(harness, {
      pinId: "pin_a",
      developerId: nick,
      credentialId: laptop.credentialId,
      at: new Date(NOW.getTime() - 3 * HOUR),
      expiresAt: new Date(NOW.getTime() - HOUR),
    });
    const closed = await grant(harness, { pinId: "pin_b", developerId: nick, credentialId: laptop.credentialId });
    await revokeWaiver({
      db: harness.db,
      repo: REPO,
      waiverId: closed,
      grantedBy: nick,
      reason: "shipped early",
      now: new Date(NOW.getTime() - HOUR / 2),
      credentialId: laptop.credentialId,
    });

    // Act
    const outcome = await revokePasskey({ db: harness.db, passkeyId: laptop.id, by: { kind: "admin" }, now: NOW });

    // Assert
    expect(outcome).toEqual({ revoked: true, terminated: 0 });
    expect(await closuresOf(harness, expired)).toHaveLength(0);
    expect(await closuresOf(harness, closed)).toHaveLength(1);
  });

  test("every revocation path terminates them: the owner in cool-off, a passkey ceremony, the admin", async () => {
    // Arrange: one passkey per path. The cooling one's grant is written
    // straight through grantWaiver — no approval accepts a cooling passkey,
    // and what is under test is that the closure does not depend on the path.
    const { harness, nick } = await setup();
    const cooling = await seedPasskey(harness.db, nick, { createdAt: NOW, usableFrom: new Date(NOW.getTime() + 24 * HOUR) });
    const ceremony = await seedPasskey(harness.db, nick, { createdAt: ENROLLED });
    const admin = await seedPasskey(harness.db, nick, { createdAt: ENROLLED });
    const paths: readonly { readonly passkeyId: string; readonly credentialId: string; readonly by: PasskeyRevocation }[] = [
      { ...cooling, passkeyId: cooling.id, by: { kind: "owner", developerId: nick } },
      { ...ceremony, passkeyId: ceremony.id, by: { kind: "passkey", developerId: nick } },
      { ...admin, passkeyId: admin.id, by: { kind: "admin" } },
    ];
    const outcomes: unknown[] = [];

    // Act
    for (const [index, path] of paths.entries()) {
      const pinId = `pin_path_${String(index)}`;
      await seedPin(harness, pinId, nick);
      await grant(harness, { pinId, developerId: nick, credentialId: path.credentialId });
      outcomes.push(await revokePasskey({ db: harness.db, passkeyId: path.passkeyId, by: path.by, now: NOW }));
    }

    // Assert
    expect(outcomes).toEqual(paths.map(() => ({ revoked: true, terminated: 1 })));
    for (const index of paths.keys()) {
      expect(await live(harness, `pin_path_${String(index)}`)).toBeNull();
    }
  });

  test("a closure the database refuses leaves the passkey unrevoked and the fence as it was", async () => {
    // Arrange: a hub whose CHECK does not know the third authority refuses the
    // closure row — the revocation must not land without it.
    const { harness, nick, laptop } = await setup();
    await grant(harness, { pinId: "pin_a", developerId: nick, credentialId: laptop.credentialId });
    await harness.db.execute(sql`ALTER TABLE fence_waivers DROP CONSTRAINT fence_waivers_authority_check`);
    await harness.db.execute(
      sql`ALTER TABLE fence_waivers ADD CONSTRAINT fence_waivers_authority_check CHECK (authority IN ('terminal', 'passkey'))`,
    );

    // Act
    const attempt = revokePasskey({ db: harness.db, passkeyId: laptop.id, by: { kind: "admin" }, now: NOW });

    // Assert: one transaction — neither half happened
    await expect(attempt).rejects.toThrow();
    const [row] = await harness.db.select().from(passkeys).where(eq(passkeys.id, laptop.id));
    expect(row?.revokedAt).toBeNull();
    expect((await live(harness, "pin_a"))?.authority).toBe("passkey");
  });
});
