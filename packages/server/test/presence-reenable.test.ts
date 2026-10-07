/**
 * SWITCHING A PRESENCE OPT-OUT BACK OFF IS NEVER SILENT (hub hardening,
 * item 6; services/developer-settings.ts).
 *
 * `PUT /api/settings/presence` takes the API key, which every agent on the
 * person's machine can read, so an agent could quietly undo a works-council
 * opt-out. The hub cannot tell the person from an agent on a key yet, so the
 * less private direction is made loud: a `presence_reenabled` security event
 * every member keeps seeing, and `presenceReenabledAt` on the person's own
 * settings, which their briefing, status and doctor print. Going more
 * private stays frictionless: no event, nothing to read.
 */
import { describe, expect, test } from "bun:test";

import { PRESENCE_REENABLE_NOTICE_DAYS } from "../src/constants.ts";
import {
  addTestDeveloperWithSession,
  createTestDeveloper,
  createTestHarness,
  fetchEvents,
  jsonRequest,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";
import { setPresenceOptOutViaApi } from "./ui-helpers.ts";

const SECONDS_PER_DAY = 86_400;

const settingsOf = async (
  harness: TestHarness,
  developer: TestDeveloper,
): Promise<{ presenceOptOut: boolean; presenceReenabledAt: string | null }> => {
  const response = await harness.app.request("/api/settings", jsonRequest("GET", developer.apiKey));
  return ((await response.json()) as { data: { presenceOptOut: boolean; presenceReenabledAt: string | null } }).data;
};

const reenables = async (harness: TestHarness, reader: TestDeveloper) =>
  (await fetchEvents(harness, reader.apiKey)).filter((event) => event.kind === "presence_reenabled");

const robinAndNick = async () => {
  const harness = await createTestHarness();
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_robin" });
  return { harness, nick, robin };
};

describe("an opt-out switched back off through the API key", () => {
  test("is recorded as a security event and told to the person, with its instant", async () => {
    // Arrange
    const { harness, nick, robin } = await robinAndNick();
    await setPresenceOptOutViaApi(harness, robin.apiKey, true);
    harness.clock.advanceSeconds(60);
    const switchedAt = harness.clock.now().toISOString();

    // Act — what an agent holding Robin's key can do
    await setPresenceOptOutViaApi(harness, robin.apiKey, false);

    // Assert
    expect(await settingsOf(harness, robin)).toMatchObject({ presenceOptOut: false, presenceReenabledAt: switchedAt });
    const seen = await reenables(harness, nick);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.payload).toEqual({ developerId: robin.developerId });
  });

  test("stays in every colleague's feed after she opts out again, and the notice ends for her", async () => {
    // Arrange
    const { harness, nick, robin } = await robinAndNick();
    await setPresenceOptOutViaApi(harness, robin.apiKey, true);
    await setPresenceOptOutViaApi(harness, robin.apiKey, false);

    // Act — she answers the notice
    await setPresenceOptOutViaApi(harness, robin.apiKey, true);

    // Assert
    expect(await reenables(harness, nick)).toHaveLength(1);
    expect((await settingsOf(harness, robin)).presenceReenabledAt).toBeNull();
  });

  test("is told for PRESENCE_REENABLE_NOTICE_DAYS, then no longer", async () => {
    // Arrange
    const { harness, robin } = await robinAndNick();
    await setPresenceOptOutViaApi(harness, robin.apiKey, true);
    await setPresenceOptOutViaApi(harness, robin.apiKey, false);

    // Act
    harness.clock.advanceSeconds(PRESENCE_REENABLE_NOTICE_DAYS * SECONDS_PER_DAY - 60);
    const inside = await settingsOf(harness, robin);
    harness.clock.advanceSeconds(120);
    const after = await settingsOf(harness, robin);

    // Assert
    expect(inside.presenceReenabledAt).not.toBeNull();
    expect(after.presenceReenabledAt).toBeNull();
  });
});

describe("going more private stays frictionless", () => {
  test("opting out, repeating a setting, or a first opt-in records nothing and tells nothing", async () => {
    // Arrange
    const { harness, nick, robin } = await robinAndNick();

    // Act
    await setPresenceOptOutViaApi(harness, robin.apiKey, false);
    await setPresenceOptOutViaApi(harness, robin.apiKey, true);
    await setPresenceOptOutViaApi(harness, robin.apiKey, true);

    // Assert
    expect(await reenables(harness, nick)).toEqual([]);
    expect((await settingsOf(harness, robin)).presenceReenabledAt).toBeNull();
  });
});
