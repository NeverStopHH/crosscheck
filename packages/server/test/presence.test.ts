import { describe, expect, test } from "bun:test";

import { PRESENCE_TTL_SECONDS } from "../src/index.ts";
import {
  createTestDeveloper,
  createTestHarness,
  fetchPresence,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validWorkContextBody,
  VALID_SESSION_BODY,
} from "./helpers.ts";

describe("GET /api/presence", () => {
  test("presence TTL matches DESIGN.md §5", () => {
    expect(PRESENCE_TTL_SECONDS).toBe(90);
  });

  test("drops a session once the clock passes the presence TTL", async () => {
    // Arrange
    const harness = await createTestHarness();
    const developer = await createTestDeveloper(
      harness,
      "Nick",
      "nick@example.com",
    );
    await registerTestSession(harness, developer.apiKey);

    // Act
    const before = await fetchPresence(harness, developer.apiKey);
    harness.clock.advanceSeconds(PRESENCE_TTL_SECONDS + 1);
    const after = await fetchPresence(harness, developer.apiKey);

    // Assert
    expect(before.sessions).toHaveLength(1);
    expect(after.sessions).toHaveLength(0);
  });

  test("marks own sessions with isSelf and teammates without", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const can = await createTestDeveloper(harness, "Robin", "robin@example.com");
    await registerTestSession(harness, nick.apiKey, { id: "ses_nick" });
    await registerTestSession(harness, can.apiKey, { id: "ses_can" });

    // Act
    const presence = await fetchPresence(harness, nick.apiKey);

    // Assert
    expect(presence.sessions).toHaveLength(2);
    const own = presence.sessions.find((s) => s.sessionId === "ses_nick");
    const teammate = presence.sessions.find((s) => s.sessionId === "ses_can");
    expect(own?.isSelf).toBe(true);
    expect(teammate?.isSelf).toBe(false);
    expect(teammate?.developerName).toBe("Robin");
  });

  test("excludes ended sessions even within the TTL", async () => {
    // Arrange
    const harness = await createTestHarness();
    const developer = await createTestDeveloper(
      harness,
      "Nick",
      "nick@example.com",
    );
    await registerTestSession(harness, developer.apiKey);
    await harness.app.request(
      `/api/sessions/${VALID_SESSION_BODY.id}/end`,
      jsonRequest("POST", developer.apiKey),
    );

    // Act
    const presence = await fetchPresence(harness, developer.apiKey);

    // Assert
    expect(presence.sessions).toHaveLength(0);
  });

  test("only returns sessions for the requested repo", async () => {
    // Arrange
    const harness = await createTestHarness();
    const developer = await createTestDeveloper(
      harness,
      "Nick",
      "nick@example.com",
    );
    await registerTestSession(harness, developer.apiKey, {
      id: "ses_api",
      repo: "github.com/acme/api",
    });
    await registerTestSession(harness, developer.apiKey, {
      id: "ses_web",
      repo: "github.com/acme/web",
    });

    // Act
    const presence = await fetchPresence(
      harness,
      developer.apiKey,
      "github.com/acme/web",
    );

    // Assert
    expect(presence.sessions).toHaveLength(1);
    expect(presence.sessions[0]?.sessionId).toBe("ses_web");
  });

  test("returns 400 when the repo query parameter is missing", async () => {
    const harness = await createTestHarness();
    const developer = await createTestDeveloper(
      harness,
      "Nick",
      "nick@example.com",
    );

    const response = await harness.app.request(
      "/api/presence",
      jsonRequest("GET", developer.apiKey),
    );

    expect(response.status).toBe(400);
  });
});
describe("presence carries the session's intent (trial finding #16)", () => {
  test("a presence row names the work context's intent, null when none", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    await registerTestSession(harness, nick.apiKey);
    const before = await fetchPresence(harness, nick.apiKey);
    expect((before.sessions[0] as unknown as { intent: unknown }).intent).toBeNull();

    // Act: the session's work context gains an intent
    await postRecords(
      harness,
      nick,
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          intent: {
            summary: "Find why the refresh call 500s after the key rotation",
            provenance: "declared",
            confidence: 1,
            capturedAt: "2026-07-24T09:02:00.000Z",
          },
        }),
      ),
    );
    const after = await fetchPresence(harness, nick.apiKey);

    // Assert
    const intent = (after.sessions[0] as unknown as { intent: { summary: string } | null }).intent;
    expect(intent?.summary).toBe("Find why the refresh call 500s after the key rotation");
  });
});
