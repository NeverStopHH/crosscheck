/**
 * Per-developer privacy settings (DESIGN.md §2.1 "per-developer presence
 * opt-out and mute", §10 risk 3): the /api/settings surface a developer uses
 * to manage their OWN opt-out and mute list. Enforcement across read surfaces
 * is pinned in presence-optout.test.ts and mute.test.ts; this file pins the
 * settings CRUD itself.
 */
import { describe, expect, test } from "bun:test";

import { addMute } from "../src/services/developer-settings.ts";
import {
  createTestHarness,
  createTestDeveloper,
  jsonRequest,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

interface MuteView {
  readonly id: string;
  readonly name: string;
}

interface SettingsView {
  readonly presenceOptOut: boolean;
  readonly mutes: readonly MuteView[];
}

const fetchSettings = async (
  harness: TestHarness,
  developer: TestDeveloper,
): Promise<{ status: number; settings: SettingsView | null }> => {
  const response = await harness.app.request(
    "/api/settings",
    jsonRequest("GET", developer.apiKey),
  );
  if (response.status !== 200) {
    return { status: response.status, settings: null };
  }
  const body = (await response.json()) as { data: SettingsView };
  return { status: response.status, settings: body.data };
};

const putPresence = async (
  harness: TestHarness,
  developer: TestDeveloper,
  optOut: unknown,
): Promise<number> => {
  const response = await harness.app.request(
    "/api/settings/presence",
    jsonRequest("PUT", developer.apiKey, { optOut }),
  );
  return response.status;
};

const postMute = async (
  harness: TestHarness,
  developer: TestDeveloper,
  ref: string,
): Promise<{ status: number; body: Record<string, unknown> | null }> => {
  const response = await harness.app.request(
    "/api/settings/mutes",
    jsonRequest("POST", developer.apiKey, { developer: ref }),
  );
  const raw = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body: raw };
};

const deleteMute = async (
  harness: TestHarness,
  developer: TestDeveloper,
  ref: string,
): Promise<{ status: number; body: Record<string, unknown> | null }> => {
  const response = await harness.app.request(
    `/api/settings/mutes/${encodeURIComponent(ref)}`,
    jsonRequest("DELETE", developer.apiKey),
  );
  const raw = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body: raw };
};

describe("GET /api/settings", () => {
  test("returns visible presence and an empty mute list by default", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");

    // Act
    const { status, settings } = await fetchSettings(harness, nick);

    // Assert
    expect(status).toBe(200);
    expect(settings?.presenceOptOut).toBe(false);
    expect(settings?.mutes).toEqual([]);
  });

  test("requires developer auth", async () => {
    // Arrange
    const harness = await createTestHarness();

    // Act
    const response = await harness.app.request(
      "/api/settings",
      jsonRequest("GET", null),
    );

    // Assert
    expect(response.status).toBe(401);
  });
});

describe("PUT /api/settings/presence", () => {
  test("opting out and back in round-trips through GET", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");

    // Act + Assert: off
    expect(await putPresence(harness, nick, true)).toBe(200);
    const hidden = await fetchSettings(harness, nick);
    expect(hidden.settings?.presenceOptOut).toBe(true);

    // Act + Assert: back on
    expect(await putPresence(harness, nick, false)).toBe(200);
    const visible = await fetchSettings(harness, nick);
    expect(visible.settings?.presenceOptOut).toBe(false);
  });

  test("rejects a non-boolean body", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");

    // Act + Assert
    expect(await putPresence(harness, nick, "yes")).toBe(400);
  });
});

describe("POST /api/settings/mutes", () => {
  test("mutes by name, email, and id; the list names each once", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const robin = await createTestDeveloper(
      harness,
      "Robin",
      "Robin@Example.com",
    );
    const clara = await createTestDeveloper(
      harness,
      "Clara",
      "clara@example.com",
    );

    // Act: three resolution paths
    const byName = await postMute(harness, nick, "Robin");
    const byEmail = await postMute(harness, nick, "clara@example.com");
    const byId = await postMute(harness, nick, robin.developerId);

    // Assert: name and email resolve; the id re-mute is idempotent
    expect(byName.status).toBe(200);
    expect(byEmail.status).toBe(200);
    expect(byId.status).toBe(200);
    const { settings } = await fetchSettings(harness, nick);
    expect(settings?.mutes.map((mute) => mute.id).sort()).toEqual(
      [robin.developerId, clara.developerId].sort(),
    );
    expect(settings?.mutes.map((mute) => mute.name).sort()).toEqual([
      "Clara",
      "Robin",
    ]);
  });

  test("answers the same shape however the developer was spelled", async () => {
    // Arrange: R1 widened resolveDeveloperRef's NAME branch from {id, name} to
    // {id, name, email} so a search refusal could list addresses. addMute and
    // removeMute hand `resolved.developer` straight to the response, and
    // MuteEntryView is declared {id, name} — so TypeScript could not see the
    // extra field and this endpoint began answering with a teammate's address,
    // but only when the caller happened to spell the reference as a NAME.
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const robin = await createTestDeveloper(
      harness,
      "Robin",
      "robin@example.com",
    );

    // Act: the three reference forms, muting and unmuting through each
    const byName = await postMute(harness, nick, "Robin");
    const unmutedByName = await deleteMute(harness, nick, "Robin");
    const byEmail = await postMute(harness, nick, "robin@example.com");
    const byId = await deleteMute(harness, nick, robin.developerId);

    // Assert: one shape, and it is the declared one — an endpoint that was not
    // part of R1 does not grow a field because a different surface needed it
    const expected = { id: robin.developerId, name: "Robin" };
    expect((byName.body?.data as { muted: unknown }).muted).toEqual(expected);
    expect(
      (unmutedByName.body?.data as { unmuted: unknown }).unmuted,
    ).toEqual(expected);
    expect((byEmail.body?.data as { muted: unknown }).muted).toEqual(expected);
    expect((byId.body?.data as { unmuted: unknown }).unmuted).toEqual(expected);
  });

  test("an ambiguous mute refusal carries no candidate list", async () => {
    // Arrange: AddMuteResult's ambiguous variant is declared {outcome} and
    // nothing else, but addMute returned the resolver's own result — which
    // since R1 carries every same-named developer's address. The route does
    // not serialize it today; the leak is one `...resolved` away.
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    await createTestDeveloper(harness, "Sam", "sam1@example.com");
    await createTestDeveloper(harness, "Sam", "sam2@example.com");

    // Act
    const ambiguous = await addMute(
      { db: harness.db, now: harness.clock.now },
      nick.developerId,
      "Sam",
    );

    // Assert
    expect(ambiguous).toEqual({ outcome: "ambiguous" });
  });

  test("unknown developer is 404, ambiguous name is 409, self-mute is 400", async () => {
    // Arrange: two developers sharing a display name
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    await createTestDeveloper(harness, "Sam", "sam1@example.com");
    await createTestDeveloper(harness, "Sam", "sam2@example.com");

    // Act + Assert
    expect((await postMute(harness, nick, "Nobody")).status).toBe(404);
    expect((await postMute(harness, nick, "Sam")).status).toBe(409);
    expect((await postMute(harness, nick, "Nick")).status).toBe(400);
  });
});

describe("DELETE /api/settings/mutes/:ref", () => {
  test("unmuting removes the entry; unmuting again reports wasMuted false", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    await createTestDeveloper(harness, "Robin", "robin@example.com");
    await postMute(harness, nick, "Robin");

    // Act
    const first = await deleteMute(harness, nick, "Robin");
    const second = await deleteMute(harness, nick, "Robin");

    // Assert
    expect(first.status).toBe(200);
    const { settings } = await fetchSettings(harness, nick);
    expect(settings?.mutes).toEqual([]);
    expect(second.status).toBe(200);
    expect((second.body?.["data"] as Record<string, unknown>)["wasMuted"]).toBe(
      false,
    );
  });

  test("unmuting an unknown developer is 404", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");

    // Act + Assert
    expect((await deleteMute(harness, nick, "Nobody")).status).toBe(404);
  });
});
