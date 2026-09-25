/**
 * AN API KEY CAN BE ROTATED, AND A ROTATION MEANS THE OLD KEY IS DEAD.
 *
 * Until now the hub had no way to replace a key at all: `doctor` told people
 * to "rotate the key if one ran in this repo" when a connector older than the
 * fetch shield had printed it into debug logs, and the only way to follow
 * that advice was to edit the database by hand. A key is the whole identity
 * here — it signs every record a developer's agents send — so the three
 * properties below are what "rotated" has to mean:
 *
 *   1. the new key works and the old one is refused at once, for the API and
 *      for the web UI (a cookie minted with the old key dies with it);
 *   2. two rotations racing on one old key produce ONE new key, never two
 *      valid ones and never a lost one;
 *   3. the event ledger records that a rotation happened, and never the key.
 *
 * Self-service for the owner (their current key authorises it), and an admin
 * path for a key that is lost or leaked by someone who cannot rotate it.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import {
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  registerTestSession,
  TEST_ADMIN_TOKEN,
} from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";
import { loginUi, uiGet } from "./ui-helpers.ts";

/** Any authenticated read: a 200 means the key is accepted. */
const works = async (harness: TestHarness, apiKey: string): Promise<boolean> =>
  (await harness.app.request("/api/settings", jsonRequest("GET", apiKey))).status === 200;

const rotateOwn = async (harness: TestHarness, apiKey: string): Promise<Response> =>
  harness.app.request("/api/keys/rotate", jsonRequest("POST", apiKey, {}));

const rotateAs = async (harness: TestHarness, token: string, developerId: string): Promise<Response> =>
  harness.app.request(`/api/developers/${developerId}/key`, jsonRequest("POST", token, {}));

const newKeyFrom = async (response: Response): Promise<string> => {
  const body = (await response.json()) as { data: { apiKey: string } };
  return body.data.apiKey;
};

/** Structural reader type — bun-types and lib.dom reader generics disagree. */
interface ByteStreamReader {
  read(): Promise<{ value?: Uint8Array | undefined; done: boolean }>;
  cancel(): Promise<void>;
}

/** Longer than two poll intervals: a stream that should close has closed by then. */
const STREAM_CLOSE_DEADLINE_MS = 3000;

/** Reads until `isEnough` holds, the stream closes, or the deadline passes. */
const readStream = async (
  reader: ByteStreamReader,
  isEnough: (text: string) => boolean = () => false,
): Promise<{ readonly text: string; readonly closed: boolean }> => {
  const decoder = new TextDecoder();
  const deadline = Date.now() + STREAM_CLOSE_DEADLINE_MS;
  let text = "";
  while (!isEnough(text)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { text, closed: false };
    }
    const next = await Promise.race([reader.read(), Bun.sleep(remaining).then(() => null)]);
    if (next === null) {
      return { text, closed: false };
    }
    if (next.done) {
      return { text, closed: true };
    }
    text += decoder.decode(next.value, { stream: true });
  }
  return { text, closed: false };
};

describe("rotating your own key", () => {
  test("the new key works and the old one is refused at once", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");

    // Act
    const response = await rotateOwn(harness, nick.apiKey);

    // Assert
    expect(response.status).toBe(200);
    const fresh = await newKeyFrom(response);
    expect(fresh).not.toBe(nick.apiKey);
    expect(await works(harness, fresh)).toBe(true);
    expect(await works(harness, nick.apiKey)).toBe(false);
  });

  test("two rotations racing on one old key leave exactly one valid key", async () => {
    // Arrange — the same old key presented twice before either write lands
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");

    // Act
    const [first, second] = await Promise.all([
      rotateOwn(harness, nick.apiKey),
      rotateOwn(harness, nick.apiKey),
    ]);

    // Assert — one wins; the loser is told so and holds no key
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    const winner = first.status === 200 ? first : second;
    expect(await works(harness, await newKeyFrom(winner))).toBe(true);
    expect(await works(harness, nick.apiKey)).toBe(false);
  });

  test("a web session minted with the old key dies with it", async () => {
    // Arrange — logged in to the UI, then the key leaks and is rotated
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const cookie = await loginUi(harness, nick.apiKey);
    expect((await uiGet(harness, "/ui/feed", cookie)).status).toBe(200);

    // Act
    const fresh = await newKeyFrom(await rotateOwn(harness, nick.apiKey));

    // Assert — the old cookie is a redirect to login; the new key logs in
    const stale = await uiGet(harness, "/ui/feed", cookie);
    expect(stale.status).toBe(303);
    expect(stale.headers.get("Location")).toBe("/ui/login");
    expect((await uiGet(harness, "/ui/feed", await loginUi(harness, fresh))).status).toBe(200);
  });

  test("the ledger records the rotation, and never the key", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");

    // Act
    const fresh = await newKeyFrom(await rotateOwn(harness, nick.apiKey));

    // Assert
    const events = (
      await harness.db.execute(
        sql`SELECT kind, payload::text AS payload FROM events WHERE kind = 'developer_key_rotated'`,
      )
    ).rows as { kind: string; payload: string }[];
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]?.payload ?? "{}")).toEqual({ developerId: nick.developerId, by: "self" });
    const everything = (await harness.db.execute(sql`SELECT payload::text AS p FROM events`)).rows
      .map((row) => String((row as { p: string }).p))
      .join("\n");
    expect(everything).not.toContain(fresh);
    expect(everything).not.toContain(nick.apiKey);
  });

  test("an event stream opened with the old key closes, and carries nothing from after the rotation", async () => {
    // Arrange — whoever holds the leaked key opens the team's live feed first
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const response = await harness.app.request("/api/events/stream", jsonRequest("GET", nick.apiKey));
    const reader = response.body!.getReader();
    const replay = await readStream(reader, (text) => text.includes("event: developer_created"));
    expect(replay.text).toContain("event: developer_created");

    // Act — the owner rotates, then the team keeps working
    const fresh = await newKeyFrom(await rotateOwn(harness, nick.apiKey));
    await registerTestSession(harness, fresh);
    const after = await readStream(reader);
    if (!after.closed) {
      await reader.cancel();
    }

    // Assert — the stream ends at the rotation, with nothing that followed it
    expect(after.closed).toBe(true);
    expect(after.text).not.toContain("event: developer_key_rotated");
    expect(after.text).not.toContain("event: session_started");
  });
});

describe("an admin rotating someone else's key", () => {
  test("replaces a lost or leaked key, and the owner's old key is dead", async () => {
    // Arrange
    const harness = await createTestHarness();
    const ken = await createTestDeveloper(harness, "Ken", "ken@example.com");

    // Act
    const response = await rotateAs(harness, TEST_ADMIN_TOKEN, ken.developerId);

    // Assert
    expect(response.status).toBe(200);
    expect(await works(harness, await newKeyFrom(response))).toBe(true);
    expect(await works(harness, ken.apiKey)).toBe(false);
  });

  test("the team feed says an admin did it, not the owner", async () => {
    // Arrange — the feed is the audit trail a teammate reads
    const harness = await createTestHarness();
    const ken = await createTestDeveloper(harness, "Ken", "ken@example.com");
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    await rotateAs(harness, TEST_ADMIN_TOKEN, ken.developerId);

    // Act
    const feed = await (await uiGet(harness, "/ui/feed", await loginUi(harness, nick.apiKey))).text();

    // Assert
    expect(feed).toContain("had their API key rotated by an admin");
    expect(feed).not.toContain("rotated their API key");
  });

  test("needs the admin token, and names an unknown developer as such", async () => {
    // Arrange
    const harness = await createTestHarness();
    const ken = await createTestDeveloper(harness, "Ken", "ken@example.com");
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");

    // Act
    const byTeammate = await rotateAs(harness, nick.apiKey, ken.developerId);
    const unknown = await rotateAs(harness, TEST_ADMIN_TOKEN, "dev_nobody");

    // Assert — a teammate's key never rotates someone else's
    expect(byTeammate.status).toBe(401);
    expect(await works(harness, ken.apiKey)).toBe(true);
    expect(unknown.status).toBe(404);
  });
});
