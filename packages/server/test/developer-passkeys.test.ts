/**
 * The admin's half of 04a §4: mint the enrolment code a person enrols their
 * first passkey with, list a developer's passkeys, and revoke one — the
 * recovery path for a lost device or a passkey nobody expected.
 *
 * The admin token, not a developer key: a code minted with the api key would
 * let any agent holding that key enrol a passkey of its own, which is the one
 * thing the code exists to prevent.
 */
import { describe, expect, test } from "bun:test";

import { isEnrolmentCodeValid } from "../src/services/passkeys.ts";
import { seedPasskey } from "./fixtures/passkeys.ts";
import {
  TEST_ADMIN_TOKEN,
  TEST_START_ISO,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
} from "./helpers.ts";

const NOW = new Date(TEST_START_ISO);

const setup = async () => {
  const harness = await createTestHarness();
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  return { harness, nick };
};

describe("POST /api/developers/:id/passkey-enrollments", () => {
  test("the admin mints a code that enrols a passkey for that developer", async () => {
    // Arrange
    const { harness, nick } = await setup();

    // Act
    const response = await harness.app.request(
      `/api/developers/${nick.developerId}/passkey-enrollments`,
      jsonRequest("POST", TEST_ADMIN_TOKEN, {}),
    );
    const body = (await response.json()) as { data: { code: string; expiresAt: string } };

    // Assert
    expect(response.status).toBe(201);
    expect(body.data.code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
    expect(
      await isEnrolmentCodeValid({
        db: harness.db,
        developerId: nick.developerId,
        code: body.data.code,
        now: NOW,
      }),
    ).toBe(true);
  });

  test("a developer's own api key cannot mint one", async () => {
    // Arrange
    const { harness, nick } = await setup();

    // Act
    const response = await harness.app.request(
      `/api/developers/${nick.developerId}/passkey-enrollments`,
      jsonRequest("POST", nick.apiKey, {}),
    );

    // Assert
    expect(response.status).toBe(401);
  });

  test("an unknown developer is a 404, not a code nobody can use", async () => {
    // Arrange
    const { harness } = await setup();

    // Act
    const response = await harness.app.request(
      "/api/developers/dev_nobody/passkey-enrollments",
      jsonRequest("POST", TEST_ADMIN_TOKEN, {}),
    );

    // Assert
    expect(response.status).toBe(404);
  });
});

describe("listing and revoking a developer's passkeys", () => {
  test("the admin sees the passkeys and can revoke one at any time", async () => {
    // Arrange
    const { harness, nick } = await setup();
    const { id } = await seedPasskey(harness.db, nick.developerId);

    // Act
    const revoked = await harness.app.request(
      `/api/developers/${nick.developerId}/passkeys/${id}/revoke`,
      jsonRequest("POST", TEST_ADMIN_TOKEN, {}),
    );
    const listing = await harness.app.request(
      `/api/developers/${nick.developerId}/passkeys`,
      jsonRequest("GET", TEST_ADMIN_TOKEN),
    );
    const body = (await listing.json()) as {
      data: { passkeys: { id: string; revokedAt: string | null }[] };
    };

    // Assert
    expect(revoked.status).toBe(200);
    expect(body.data.passkeys).toEqual([expect.objectContaining({ id, revokedAt: NOW.toISOString() })]);
  });

  test("a passkey of another developer is not revoked through this developer's path", async () => {
    // Arrange
    const { harness, nick } = await setup();
    const ken = await createTestDeveloper(harness, "Ken", "ken@example.com");
    const { id } = await seedPasskey(harness.db, ken.developerId);

    // Act
    const response = await harness.app.request(
      `/api/developers/${nick.developerId}/passkeys/${id}/revoke`,
      jsonRequest("POST", TEST_ADMIN_TOKEN, {}),
    );

    // Assert
    expect(response.status).toBe(404);
  });
});
