/**
 * SECURITY EVENTS OUTLIVE THE PRESENCE OPT-OUT (constants.ts
 * SECURITY_EVENT_KINDS, services/events.ts).
 *
 * The feed's opt-out filter hid every row naming an opted-out developer, a
 * key rotation included. The opt-out is `PUT /api/settings/presence`, which
 * the API key can call, so an agent holding the key could switch its
 * person's presence off and hide its own key rotation from the team. A
 * security event now stays in every member's feed. Work activity stays
 * hidden, or the opt-out would hand colleagues an activity timeline again,
 * and the security rows carry no live-location field.
 */
import { describe, expect, test } from "bun:test";

import { SECURITY_EVENT_KINDS } from "../src/constants.ts";
import {
  TEST_ADMIN_TOKEN,
  addTestDeveloperWithSession,
  createTestDeveloper,
  createTestHarness,
  fetchEvents,
  jsonRequest,
} from "./helpers.ts";
import { loginUi, setPresenceOptOutViaApi, uiGet } from "./ui-helpers.ts";

/** Robin works, opts out with her key, and her key is rotated twice: by itself and by the admin. */
const robinOptsOutAndRotates = async () => {
  const harness = await createTestHarness();
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_robin" });
  await setPresenceOptOutViaApi(harness, robin.apiKey, true);
  const own = await harness.app.request("/api/keys/rotate", jsonRequest("POST", robin.apiKey, {}));
  if (own.status !== 200) {
    throw new Error(`self rotation failed: ${String(own.status)}`);
  }
  const byAdmin = await harness.app.request(
    `/api/developers/${robin.developerId}/key`,
    jsonRequest("POST", TEST_ADMIN_TOKEN, {}),
  );
  if (byAdmin.status !== 200) {
    throw new Error(`admin rotation failed: ${String(byAdmin.status)}`);
  }
  return { harness, nick, robin };
};

describe("the presence opt-out hides work activity, never a security event", () => {
  test("a colleague still sees both rotations of an opted-out developer's key, and none of her work", async () => {
    // Arrange
    const { harness, nick, robin } = await robinOptsOutAndRotates();

    // Act
    const seen = await fetchEvents(harness, nick.apiKey);
    const hers = seen.filter((event) => event.payload["developerId"] === robin.developerId);

    // Assert
    expect(hers.map((event) => [event.kind, event.payload["by"]])).toEqual([
      ["developer_key_rotated", "self"],
      ["developer_key_rotated", "admin"],
    ]);
    // Her session start (work activity) stays hidden.
    expect(seen.some((event) => event.kind === "session_started")).toBe(false);
  });

  test("a security row carries her id and who acted, and no live-location field", async () => {
    // Arrange
    const { harness, nick, robin } = await robinOptsOutAndRotates();

    // Act
    const rotations = (await fetchEvents(harness, nick.apiKey)).filter(
      (event) => event.kind === "developer_key_rotated" && event.payload["developerId"] === robin.developerId,
    );

    // Assert
    for (const rotation of rotations) {
      expect(Object.keys(rotation.payload).sort()).toEqual(["by", "developerId"]);
    }
  });

  test("the web feed says it too", async () => {
    // Arrange
    const { harness, nick } = await robinOptsOutAndRotates();

    // Act
    const html = await (await uiGet(harness, "/ui/feed", await loginUi(harness, nick.apiKey))).text();

    // Assert
    expect(html).toContain("rotated their API key");
    expect(html).toContain("had their API key rotated by an admin");
    expect(html).not.toContain("started a session");
  });

  test("the exempt set is credential changes only, never work activity", () => {
    expect(SECURITY_EVENT_KINDS).toEqual(["developer_key_rotated", "presence_reenabled"]);
  });
});
