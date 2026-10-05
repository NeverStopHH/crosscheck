/**
 * 04a D-PK-1 (Nick, 2026-10-02): every surface that shows a waiver says it was
 * closed because the passkey that approved it was revoked — the hub's half.
 *
 * The closure is a `system` revoke row (passkey-revocation-terminates.test.ts
 * proves it is written). Here: the admin's answer counts what it closed, the
 * pin registry and the verdict carry the closure while the grant would still
 * have held, and the waiver record lists the row as the hub's, naming no
 * person. Driven through the routes, as a client reads them.
 */
import { describe, expect, test } from "bun:test";
import { AUTHORIZING_CREDENTIAL_REVOKED, SYSTEM_WAIVER_AUTHORITY } from "@crosscheck/schema";

import { pins } from "../src/db/schema.ts";
import { grantWaiver } from "../src/services/waivers.ts";
import { seedPasskey } from "./fixtures/passkeys.ts";
import { TEST_ADMIN_TOKEN, createTestDeveloper, createTestHarness, jsonRequest } from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = "github.com/acme/api";
const PIN = "pin_closure";
const HOUR = 3_600_000;
const HELD_HOURS = 48;

interface Fixture {
  readonly harness: TestHarness;
  readonly nick: TestDeveloper;
  readonly passkeyId: string;
  readonly grantId: string;
  readonly heldUntil: string;
}

const setup = async (): Promise<Fixture> => {
  const harness = await createTestHarness();
  const nick = await createTestDeveloper(harness, "Nick", "nick-closure@example.com");
  const now = harness.clock.now();
  await harness.db.insert(pins).values({
    id: PIN,
    repo: REPO,
    surface: "the refresh path keeps working",
    verifiedBy: nick.developerId,
    verifiedAtCommit: "a1b2c3d",
    verifiedAt: now,
    checkRecipe: "bun test",
    captureMode: "human",
    createdAt: now,
  });
  const laptop = await seedPasskey(harness.db, nick.developerId, { createdAt: new Date(now.getTime() - 30 * 24 * HOUR) });
  const expiresAt = new Date(now.getTime() + HELD_HOURS * HOUR);
  const granted = await grantWaiver({
    db: harness.db,
    repo: REPO,
    pinId: PIN,
    pinVersion: 1,
    grantedBy: nick.developerId,
    reason: "the fix lands Monday",
    expiresAt,
    now,
    credentialId: laptop.credentialId,
    requestId: null,
  });
  if (!("id" in granted)) {
    throw new Error(granted.refusal);
  }
  return { harness, nick, passkeyId: laptop.id, grantId: granted.id, heldUntil: expiresAt.toISOString() };
};

const revokeAsAdmin = async (fx: Fixture): Promise<Response> =>
  fx.harness.app.request(
    `/api/developers/${fx.nick.developerId}/passkeys/${fx.passkeyId}/revoke`,
    jsonRequest("POST", TEST_ADMIN_TOKEN),
  );

const read = async <T>(fx: Fixture, path: string): Promise<T> => {
  const response = await fx.harness.app.request(path, jsonRequest("GET", fx.nick.apiKey));
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: T }).data;
};

interface ClosedWaiverWire {
  readonly id: string;
  readonly closedAt: string;
  readonly heldUntil: string;
  readonly reason: string;
}

const pinRow = async (fx: Fixture) =>
  (await read<{ pins: { liveWaiver: unknown; closedWaiver: ClosedWaiverWire | null }[] }>(fx, `/api/pins?repo=${REPO}`))
    .pins[0];

describe("every waiver surface says the passkey that approved it was revoked (04a D-PK-1)", () => {
  test("the admin's revocation answers how many open waivers it closed", async () => {
    // Arrange
    const fx = await setup();

    // Act
    const response = await revokeAsAdmin(fx);

    // Assert
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: unknown }).data).toEqual({ revoked: true, terminatedWaivers: 1 });
  });

  test("the pin registry carries the closure while the grant would still have held", async () => {
    // Arrange
    const fx = await setup();
    const closedAt = fx.harness.clock.now().toISOString();

    // Act
    await revokeAsAdmin(fx);
    const row = await pinRow(fx);

    // Assert
    expect(row?.liveWaiver).toBeNull();
    expect(row?.closedWaiver).toEqual({
      id: fx.grantId,
      closedAt,
      heldUntil: fx.heldUntil,
      reason: AUTHORIZING_CREDENTIAL_REVOKED,
    });
  });

  test("once the grant would have run out on its own, the registry stops carrying the closure", async () => {
    // Arrange
    const fx = await setup();
    await revokeAsAdmin(fx);

    // Act
    fx.harness.clock.advanceSeconds(HELD_HOURS * 3600 + 1);
    const row = await pinRow(fx);

    // Assert
    expect(row?.closedWaiver).toBeNull();
  });

  test("the verdict on the pin carries the closure beside its closed fence", async () => {
    // Arrange
    const fx = await setup();
    await revokeAsAdmin(fx);

    // Act
    const answer = await read<{ verdict: { waiver: unknown; closedWaiver: ClosedWaiverWire | null } }>(
      fx,
      `/api/suspect?repo=${REPO}&pin=${PIN}`,
    );

    // Assert
    expect(answer.verdict.waiver).toBeNull();
    expect(answer.verdict.closedWaiver?.id).toBe(fx.grantId);
    expect(answer.verdict.closedWaiver?.reason).toBe(AUTHORIZING_CREDENTIAL_REVOKED);
  });

  test("the waiver record lists the closure as the hub's own, naming no person", async () => {
    // Arrange
    const fx = await setup();
    await revokeAsAdmin(fx);

    // Act
    const record = await read<{
      waivers: { kind: string; authority: string; reason: string; grantedByName: string | null; supersedes: string | null }[];
    }>(fx, `/api/fence-waivers?repo=${REPO}`);

    // Assert
    expect(record.waivers).toHaveLength(2);
    expect(record.waivers.find((row) => row.kind === "revoke")).toMatchObject({
      authority: SYSTEM_WAIVER_AUTHORITY,
      reason: AUTHORIZING_CREDENTIAL_REVOKED,
      grantedByName: null,
      supersedes: fx.grantId,
    });
  });
});
