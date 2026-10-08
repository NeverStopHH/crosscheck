/**
 * PRIVACY SETTINGS ARE THE PERSON'S (human provenance §8). A key's mute and a
 * key's request to show presence again wait as drafts; the person's passkey
 * makes them take effect, recorded `human_passkey_confirmed`. Showing presence
 * again still appends the `presence_reenabled` security event and starts the
 * hardening branch's notice — now always after a passkey, and saying so.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { developerMutes, privacyChanges } from "../src/db/schema.ts";
import { confirmPending, prepareConfirmer } from "./fixtures/confirm-driver.ts";
import { createTestDeveloper, createTestHarness, jsonRequest } from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const settingsOf = async (harness: TestHarness, developer: TestDeveloper): Promise<Record<string, unknown>> =>
  ((await (await harness.app.request("/api/settings", jsonRequest("GET", developer.apiKey))).json()) as { data: Record<string, unknown> }).data;

const world = async () => {
  const harness = await createTestHarness();
  const nick = await createTestDeveloper(harness, "Nick", "nick-settings-confirm@example.com");
  const ken = await createTestDeveloper(harness, "Ken", "ken-settings-confirm@example.com");
  return { harness, nick, ken };
};

describe("confirming a settings draft", () => {
  test("a key's mute of a teammate takes effect only once the person confirms it, recorded as theirs", async () => {
    // Arrange
    const { harness, nick, ken } = await world();
    await harness.app.request("/api/settings/mutes", jsonRequest("POST", nick.apiKey, { developer: "Ken" }));
    const before = await harness.db.select().from(developerMutes);
    const confirmer = await prepareConfirmer(harness, nick);

    // Act
    const verified = await confirmPending(harness, nick, confirmer);
    const after = await harness.db
      .select({ muted: developerMutes.mutedDeveloperId, provenance: developerMutes.provenance })
      .from(developerMutes);

    // Assert
    expect(before).toEqual([]);
    expect(verified.status).toBe(200);
    expect(after).toEqual([{ muted: ken.developerId, provenance: "human_passkey_confirmed" }]);
  });

  test("a mute the person discards never takes effect", async () => {
    // Arrange
    const { harness, nick } = await world();
    await harness.app.request("/api/settings/mutes", jsonRequest("POST", nick.apiKey, { developer: "Ken" }));
    const confirmer = await prepareConfirmer(harness, nick);

    // Act
    await confirmPending(harness, nick, confirmer, () => ({ decision: "discard" }));

    // Assert
    expect(await harness.db.select().from(developerMutes)).toEqual([]);
    expect(await settingsOf(harness, nick)).toMatchObject({ mutes: [], pendingDrafts: 0 });
  });

  test("presence back on: the person's passkey turns it on, the security event and the notice follow, marked confirmed", async () => {
    // Arrange
    const { harness, nick } = await world();
    await harness.app.request("/api/settings/presence", jsonRequest("PUT", nick.apiKey, { optOut: true }));
    await harness.app.request("/api/settings/presence", jsonRequest("PUT", nick.apiKey, { optOut: false }));
    const confirmer = await prepareConfirmer(harness, nick);

    // Act
    const verified = await confirmPending(harness, nick, confirmer);
    const settings = await settingsOf(harness, nick);
    const events = await harness.db.execute(
      sql`SELECT payload->>'provenance' AS provenance FROM events WHERE kind = 'presence_reenabled'`,
    );
    const changes = await harness.db.select({ kind: privacyChanges.kind, provenance: privacyChanges.provenance }).from(privacyChanges);

    // Assert
    expect(verified.status).toBe(200);
    expect(settings).toMatchObject({ presenceOptOut: false, presenceOnPending: false });
    expect(settings["presenceReenabledAt"]).not.toBeNull();
    expect(events.rows).toEqual([{ provenance: "human_passkey_confirmed" }]);
    expect(changes).toEqual([
      { kind: "presence_off", provenance: "agent_asserted" },
      { kind: "presence_on", provenance: "human_passkey_confirmed" },
    ]);
  });

  test("a presence-on request made moot by the person switching on another way leaves the list on its own", async () => {
    // Arrange: the draft waits; then presence is already on (here: no opt-out ever stood)
    const { harness, nick } = await world();
    await harness.app.request("/api/settings/presence", jsonRequest("PUT", nick.apiKey, { optOut: true }));
    await harness.app.request("/api/settings/presence", jsonRequest("PUT", nick.apiKey, { optOut: false }));
    await harness.db.execute(sql`UPDATE developers SET presence_opt_out = false WHERE id = ${nick.developerId}`);

    // Act
    const settings = await settingsOf(harness, nick);

    // Assert
    expect(settings).toMatchObject({ presenceOnPending: false, pendingDrafts: 0 });
  });
});
