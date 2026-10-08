/**
 * EVERY DOOR A KEY CAN REACH DRAFTS (human provenance §3, §7, §8).
 *
 * The api key sits in plaintext beside the person's agents, so nothing it
 * sends is a person's judgement: labels, outcomes, pins, breaks, mutes and
 * presence-on land in `human_drafts` with the class of their door, and have
 * no effect until a passkey confirms them. Going more private (presence off)
 * is the one exception — immediate, recorded `agent_asserted`, shown to the
 * person. Every answer keeps the fields an older client's parser requires.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PIN_PRESENCE_TERMINAL } from "@crosscheck/schema";

import { developerMutes, hintOutcomes, humanDrafts, pilotMarks, pins, privacyChanges } from "../src/db/schema.ts";
import { addMute } from "../src/services/developer-settings.ts";
import { createPin } from "../src/services/pins.ts";
import { seedHumanStamp } from "./fixtures/human-confirmation.ts";
import { KEN_CONTEXT, NICK_SESSION, REPO, createOutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import { createTestDeveloper, createTestHarness, jsonRequest, registerTestSession } from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const dataOf = async <T>(response: Response): Promise<T> => ((await response.json()) as { data: T }).data;

const post = async (harness: TestHarness, developer: TestDeveloper, path: string, body: unknown): Promise<Response> =>
  await harness.app.request(path, jsonRequest("POST", developer.apiKey, body));

const draftsOf = (harness: TestHarness) => harness.db.select().from(humanDrafts);

const pinBody = (id: string): Record<string, unknown> => ({
  id,
  repo: REPO,
  surface: "Play button plays/pauses",
  files: ["src/workbench/PlaybackControls.tsx"],
  check: "open /workbench, press Play",
  presence: PIN_PRESENCE_TERMINAL,
  verifiedAtCommit: "abc1234",
});

describe("the label door drafts", () => {
  test("a label at the terminal's door is a draft of that class; no label counts", async () => {
    // Arrange
    const world = await createOutcomeWorld();

    // Act
    const response = await post(world.harness, world.nick, "/api/pilot-marks", {
      repo: REPO,
      refKind: "hint_delivery",
      refId: world.delivered.kenContext,
      mark: "helpful",
      reason: "named the file I was in",
      presence: "controlling_terminal",
    });
    const data = await dataOf<Record<string, unknown>>(response);
    const drafts = await draftsOf(world.harness);

    // Assert
    expect(response.status).toBe(201);
    expect(data).toMatchObject({ repeated: false, draft: true, provenance: "interactive_terminal_asserted" });
    expect(await world.harness.db.select().from(pilotMarks)).toEqual([]);
    expect(drafts.map((draft) => [draft.kind, draft.provenance, draft.payload["word"]])).toEqual([
      ["label", "interactive_terminal_asserted", "helpful"],
    ]);
  });

  test("the door still refuses what could never count, and drafts nothing", async () => {
    // Arrange
    const world = await createOutcomeWorld();

    // Act
    const response = await post(world.harness, world.nick, "/api/pilot-marks", {
      repo: REPO,
      refKind: "hint_delivery",
      refId: world.delivered.mikeGotKen,
      mark: "noise",
      presence: "controlling_terminal",
    });

    // Assert — Mike's delivery reads as no delivery at all (§11.9)
    expect(response.status).toBe(422);
    expect(await draftsOf(world.harness)).toEqual([]);
  });

  test("the same label again is a repeat: 200, nothing new", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    const body = { repo: REPO, refKind: "hint_delivery", refId: world.delivered.kenContext, mark: "noise", presence: "controlling_terminal" };
    await post(world.harness, world.nick, "/api/pilot-marks", body);

    // Act
    const again = await post(world.harness, world.nick, "/api/pilot-marks", body);

    // Assert
    expect(again.status).toBe(200);
    expect(await dataOf<Record<string, unknown>>(again)).toMatchObject({ repeated: true, draft: true });
    expect(await draftsOf(world.harness)).toHaveLength(1);
  });
});

describe("the outcome doors draft", () => {
  test("the agent's door drafts agent_asserted; the answer keeps the fields an older connector reads", async () => {
    // Arrange
    const world = await createOutcomeWorld();

    // Act
    const response = await post(world.harness, world.nick, "/api/hint-outcomes", {
      repo: REPO,
      ref: KEN_CONTEXT,
      outcome: "followed",
      session: NICK_SESSION,
    });
    const data = await dataOf<Record<string, unknown>>(response);

    // Assert
    expect(response.status).toBe(201);
    expect(data).toMatchObject({
      deliveryId: world.delivered.kenContext,
      outcome: "followed",
      repeated: false,
      replaced: null,
      draft: true,
      provenance: "agent_asserted",
    });
    expect(typeof data["id"]).toBe("string");
    expect(await world.harness.db.select().from(hintOutcomes)).toEqual([]);
  });

  test("the person's door drafts interactive_terminal_asserted — a terminal is never a proven person", async () => {
    // Arrange
    const world = await createOutcomeWorld();

    // Act
    const response = await post(world.harness, world.nick, "/api/hint-outcomes/person", {
      repo: REPO,
      ref: world.delivered.kenClaim,
      outcome: "overrode",
      reason: "my retry was simpler",
    });

    // Assert
    expect(response.status).toBe(201);
    expect(await dataOf<Record<string, unknown>>(response)).toMatchObject({ draft: true, provenance: "interactive_terminal_asserted" });
    expect((await draftsOf(world.harness)).map((draft) => draft.provenance)).toEqual(["interactive_terminal_asserted"]);
    expect(await world.harness.db.select().from(hintOutcomes)).toEqual([]);
  });

  test("an outcome the hub refuses drafts nothing", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: false });

    // Act
    const response = await post(world.harness, world.nick, "/api/hint-outcomes", { repo: REPO, ref: KEN_CONTEXT, outcome: "followed" });

    // Assert
    expect(response.status).toBe(422);
    expect(await draftsOf(world.harness)).toEqual([]);
  });
});

describe("the pin doors draft, and a draft pin protects nothing", () => {
  const pinWorld = async (): Promise<{ harness: TestHarness; nick: TestDeveloper }> => {
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-pin-doors@example.com");
    await registerTestSession(harness, nick.apiKey, { repo: REPO });
    return { harness, nick };
  };

  test("a key's pin is a draft: no pin row, nothing in the registry, an older CLI's `{ id }` still answered", async () => {
    // Arrange
    const { harness, nick } = await pinWorld();

    // Act
    const response = await post(harness, nick, "/api/pins", pinBody("pin_draft_1"));
    const registry = await dataOf<{ pins: readonly unknown[]; coverage: { pins: number } }>(
      await harness.app.request(`/api/pins?repo=${encodeURIComponent(REPO)}`, jsonRequest("GET", nick.apiKey)),
    );

    // Assert
    expect(response.status).toBe(202);
    expect(await dataOf<Record<string, unknown>>(response)).toMatchObject({ id: "pin_draft_1", draft: true, provenance: "interactive_terminal_asserted" });
    expect(await harness.db.select().from(pins)).toEqual([]);
    expect(registry.pins).toEqual([]);
    expect(registry.coverage.pins).toBe(0);
    expect((await draftsOf(harness)).map((draft) => draft.kind)).toEqual(["pin"]);
  });

  test("a key's break is a draft: the confirmed pin stays unbroken", async () => {
    // Arrange
    const { harness, nick } = await pinWorld();
    const stamp = await seedHumanStamp(harness.db, nick.developerId);
    const body = pinBody("pin_confirmed_1");
    await createPin({ db: harness.db, now: harness.clock.now }, nick.developerId, {
      id: "pin_confirmed_1",
      repo: REPO,
      surface: String(body["surface"]),
      files: ["src/workbench/PlaybackControls.tsx"],
      check: String(body["check"]),
      presence: PIN_PRESENCE_TERMINAL,
      verifiedAtCommit: "abc1234",
    }, stamp);

    // Act
    const response = await post(harness, nick, "/api/pins/pin_confirmed_1/broke", { repo: REPO, presence: PIN_PRESENCE_TERMINAL });
    const rows = await harness.db.select({ brokeAt: pins.brokeAt }).from(pins);

    // Assert
    expect(response.status).toBe(202);
    expect(await dataOf<Record<string, unknown>>(response)).toMatchObject({ id: "pin_confirmed_1", draft: true });
    expect(rows).toEqual([{ brokeAt: null }]);
    expect((await draftsOf(harness)).map((draft) => draft.kind)).toEqual(["pin_broke"]);
  });

  test("a break of a pin that does not exist is still 404, and drafts nothing", async () => {
    // Arrange
    const { harness, nick } = await pinWorld();

    // Act
    const response = await post(harness, nick, "/api/pins/pin_none/broke", { repo: REPO, presence: PIN_PRESENCE_TERMINAL });

    // Assert
    expect(response.status).toBe(404);
    expect(await draftsOf(harness)).toEqual([]);
  });
});

describe("the settings doors", () => {
  const settingsWorld = async () => {
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-settings-doors@example.com");
    const ken = await createTestDeveloper(harness, "Ken", "ken-settings-doors@example.com");
    return { harness, nick, ken };
  };

  test("a key's mute is a draft: the teammate is not muted", async () => {
    // Arrange
    const { harness, nick } = await settingsWorld();

    // Act
    const response = await post(harness, nick, "/api/settings/mutes", { developer: "Ken" });

    // Assert
    expect(response.status).toBe(202);
    expect(await dataOf<Record<string, unknown>>(response)).toMatchObject({ muted: { name: "Ken" }, alreadyMuted: false, draft: true });
    expect(await harness.db.select().from(developerMutes)).toEqual([]);
    expect((await draftsOf(harness)).map((draft) => [draft.kind, draft.provenance])).toEqual([["mute", "agent_asserted"]]);
  });

  test("a key's unmute is a draft: the confirmed mute stays", async () => {
    // Arrange
    const { harness, nick, ken } = await settingsWorld();
    await addMute({ db: harness.db, now: harness.clock.now }, nick.developerId, ken.developerId, await seedHumanStamp(harness.db, nick.developerId));

    // Act
    const response = await harness.app.request("/api/settings/mutes/Ken", jsonRequest("DELETE", nick.apiKey));

    // Assert
    expect(response.status).toBe(202);
    expect(await dataOf<Record<string, unknown>>(response)).toMatchObject({ unmuted: { name: "Ken" }, wasMuted: true, draft: true });
    expect(await harness.db.select({ muted: developerMutes.mutedDeveloperId }).from(developerMutes)).toEqual([{ muted: ken.developerId }]);
    expect((await draftsOf(harness)).map((draft) => draft.kind)).toEqual(["unmute"]);
  });

  test("presence off is immediate, recorded agent_asserted, and shown to the person", async () => {
    // Arrange
    const { harness, nick } = await settingsWorld();

    // Act
    const response = await harness.app.request("/api/settings/presence", jsonRequest("PUT", nick.apiKey, { optOut: true }));
    const settings = await dataOf<Record<string, unknown>>(await harness.app.request("/api/settings", jsonRequest("GET", nick.apiKey)));

    // Assert
    expect(response.status).toBe(200);
    expect(settings).toMatchObject({ presenceOptOut: true, presenceOptOutChange: { provenance: "agent_asserted" } });
    expect((await harness.db.select().from(privacyChanges)).map((row) => [row.kind, row.provenance])).toEqual([["presence_off", "agent_asserted"]]);
  });

  test("presence back on by key is a draft: still opted out, no re-enable event, pending for the passkey", async () => {
    // Arrange
    const { harness, nick } = await settingsWorld();
    await harness.app.request("/api/settings/presence", jsonRequest("PUT", nick.apiKey, { optOut: true }));

    // Act
    const response = await harness.app.request("/api/settings/presence", jsonRequest("PUT", nick.apiKey, { optOut: false }));
    const settings = await dataOf<Record<string, unknown>>(await harness.app.request("/api/settings", jsonRequest("GET", nick.apiKey)));
    const events = await harness.db.execute(sql`SELECT count(*)::int AS n FROM events WHERE kind = 'presence_reenabled'`);

    // Assert
    expect(response.status).toBe(202);
    expect(await dataOf<Record<string, unknown>>(response)).toMatchObject({ presenceOptOut: true, draft: true });
    expect(settings).toMatchObject({ presenceOptOut: true, presenceOnPending: true, presenceReenabledAt: null, pendingDrafts: 1 });
    expect(events.rows).toEqual([{ n: 0 }]);
  });
});
