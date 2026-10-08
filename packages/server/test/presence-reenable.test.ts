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
import { loginUi, setPresenceOptOutViaApi, uiGet } from "./ui-helpers.ts";

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

  test("on, watched, off again: the feed keeps it and she is still told, with presence off now", async () => {
    // Arrange — the review's M1: an agent exposes her briefly, then restores the opt-out
    const { harness, nick, robin } = await robinAndNick();
    await setPresenceOptOutViaApi(harness, robin.apiKey, true);
    await setPresenceOptOutViaApi(harness, robin.apiKey, false);
    const switchedAt = harness.clock.now().toISOString();
    harness.clock.advanceSeconds(600);

    // Act — the second PUT is the agent's too, so it answers nothing
    await setPresenceOptOutViaApi(harness, robin.apiKey, true);

    // Assert
    expect(await reenables(harness, nick)).toHaveLength(1);
    expect(await settingsOf(harness, robin)).toMatchObject({ presenceOptOut: true, presenceReenabledAt: switchedAt });
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

describe("the person's own /ui/feed says so too (review L7)", () => {
  const BANNER = "Your presence opt-out was switched off at";
  const feedOf = async (harness: TestHarness, developer: TestDeveloper): Promise<string> =>
    (await uiGet(harness, "/ui/feed", await loginUi(harness, developer.apiKey))).text();

  test("while it is on, her feed shows the banner and the teammate's does not", async () => {
    // Arrange
    const { harness, nick, robin } = await robinAndNick();
    await setPresenceOptOutViaApi(harness, robin.apiKey, true);
    await setPresenceOptOutViaApi(harness, robin.apiKey, false);

    // Act
    const hers = await feedOf(harness, robin);
    const his = await feedOf(harness, nick);

    // Assert
    expect(hers).toContain(BANNER);
    expect(hers).toContain("Teammates can see your live presence now.");
    expect(his).not.toContain(BANNER);
  });

  test("on, watched, off again: the banner stays, and says it is on again now", async () => {
    // Arrange
    const { harness, robin } = await robinAndNick();
    await setPresenceOptOutViaApi(harness, robin.apiKey, true);
    await setPresenceOptOutViaApi(harness, robin.apiKey, false);
    await setPresenceOptOutViaApi(harness, robin.apiKey, true);

    // Act
    const hers = await feedOf(harness, robin);

    // Assert
    expect(hers).toContain(BANNER);
    expect(hers).toContain("It is on again now, but teammates could see your live presence in between.");
  });

  test("nothing re-enabled: no banner", async () => {
    const { harness, robin } = await robinAndNick();
    await setPresenceOptOutViaApi(harness, robin.apiKey, true);

    expect(await feedOf(harness, robin)).not.toContain(BANNER);
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
