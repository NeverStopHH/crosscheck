/**
 * PK-10's hub half (1.0 spec 04a §4.3): every member can read which passkeys
 * were enrolled lately — the cooling-off ones above all, because those are the
 * ones a person can still revoke before they act — and how many passkeys on
 * the hub can approve a waiver at all.
 */
import { describe, expect, test } from "bun:test";

import { PASSKEY_ANNOUNCEMENT_DAYS } from "../src/constants.ts";
import { seedPasskey } from "./fixtures/passkeys.ts";
import { TEST_START_ISO, createTestDeveloper, createTestHarness, jsonRequest } from "./helpers.ts";

const NOW = new Date(TEST_START_ISO);
const DAY = 86_400_000;

interface Announcements {
  readonly enrolments: readonly { developerName: string; coolingOff: boolean; label: string }[];
  readonly usablePasskeys: number;
}

describe("GET /api/passkeys/announcements", () => {
  test("a passkey enrolled for Ken an hour ago is announced to Nick, cooling off", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const ken = await createTestDeveloper(harness, "Ken", "ken@example.com");
    await seedPasskey(harness.db, ken.developerId, {
      createdAt: new Date(NOW.getTime() - DAY / 24),
      usableFrom: new Date(NOW.getTime() + DAY - DAY / 24),
    });

    // Act
    const response = await harness.app.request(
      "/api/passkeys/announcements",
      jsonRequest("GET", nick.apiKey),
    );
    const body = (await response.json()) as { data: Announcements };

    // Assert
    expect(response.status).toBe(200);
    expect(body.data.enrolments).toEqual([
      expect.objectContaining({ developerName: "Ken", coolingOff: true }),
    ]);
    expect(body.data.usablePasskeys).toBe(0);
  });

  test("an enrolment older than the announcement window is no longer announced, but still counts", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    await seedPasskey(harness.db, nick.developerId, {
      createdAt: new Date(NOW.getTime() - (PASSKEY_ANNOUNCEMENT_DAYS + 1) * DAY),
    });

    // Act
    const response = await harness.app.request(
      "/api/passkeys/announcements",
      jsonRequest("GET", nick.apiKey),
    );
    const body = (await response.json()) as { data: Announcements };

    // Assert
    expect(body.data.enrolments).toEqual([]);
    expect(body.data.usablePasskeys).toBe(1);
  });

  test("the counts cover the whole window, not the page the hub lists", async () => {
    // Arrange — more enrolments than one announcement lists; the 21st
    // cooling-off one is exactly the one a person would otherwise not see.
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    for (let i = 0; i < 25; i += 1) {
      await seedPasskey(harness.db, nick.developerId, {
        createdAt: new Date(NOW.getTime() - (i + 1) * 60_000),
        usableFrom: new Date(NOW.getTime() + DAY),
      });
    }

    // Act
    const response = await harness.app.request(
      "/api/passkeys/announcements",
      jsonRequest("GET", nick.apiKey),
    );
    const body = (await response.json()) as {
      data: Announcements & { enrolmentsTotal: number; coolingOff: number };
    };

    // Assert
    expect(body.data.enrolments).toHaveLength(20);
    expect(body.data.enrolmentsTotal).toBe(25);
    expect(body.data.coolingOff).toBe(25);
  });
});
