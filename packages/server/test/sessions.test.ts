import { describe, expect, test } from "bun:test";

import {
  createTestDeveloper,
  createTestHarness,
  fetchPresence,
  jsonRequest,
  registerTestSession,
  VALID_SESSION_BODY,
} from "./helpers.ts";

describe("POST /api/sessions", () => {
  test("registers a session and shows it in presence", async () => {
    // Arrange
    const harness = await createTestHarness();
    const developer = await createTestDeveloper(
      harness,
      "Nick",
      "nick@example.com",
    );

    // Act
    const response = await registerTestSession(harness, developer.apiKey);

    // Assert
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: { session: { id: string; status: string } };
    };
    expect(body.ok).toBe(true);
    expect(body.data.session.id).toBe(VALID_SESSION_BODY.id);

    const presence = await fetchPresence(harness, developer.apiKey);
    expect(presence.sessions).toHaveLength(1);
    expect(presence.sessions[0]?.sessionId).toBe(VALID_SESSION_BODY.id);
  });

  test("re-registering an own session updates it instead of duplicating", async () => {
    // Arrange
    const harness = await createTestHarness();
    const developer = await createTestDeveloper(
      harness,
      "Nick",
      "nick@example.com",
    );
    await registerTestSession(harness, developer.apiKey);

    // Act
    const response = await registerTestSession(harness, developer.apiKey, {
      status: "implementing",
      branch: "feat/other-branch",
    });

    // Assert
    expect(response.status).toBe(200);
    const presence = await fetchPresence(harness, developer.apiKey);
    expect(presence.sessions).toHaveLength(1);
    expect(presence.sessions[0]?.status).toBe("implementing");
    expect(presence.sessions[0]?.branch).toBe("feat/other-branch");
  });

  test("registering another developer's session id returns 409", async () => {
    // Arrange
    const harness = await createTestHarness();
    const owner = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const intruder = await createTestDeveloper(harness, "Can", "can@example.com");
    await registerTestSession(harness, owner.apiKey);

    // Act
    const response = await registerTestSession(harness, intruder.apiKey);

    // Assert
    expect(response.status).toBe(409);
  });

  test("rejects an invalid session status with 400", async () => {
    const harness = await createTestHarness();
    const developer = await createTestDeveloper(
      harness,
      "Nick",
      "nick@example.com",
    );

    const response = await registerTestSession(harness, developer.apiKey, {
      status: "procrastinating",
    });

    expect(response.status).toBe(400);
  });
});

describe("POST /api/sessions/:id/heartbeat", () => {
  test("heartbeat extends presence past the original TTL", async () => {
    // Arrange
    const harness = await createTestHarness();
    const developer = await createTestDeveloper(
      harness,
      "Nick",
      "nick@example.com",
    );
    await registerTestSession(harness, developer.apiKey);

    // Act
    harness.clock.advanceSeconds(80);
    const heartbeat = await harness.app.request(
      `/api/sessions/${VALID_SESSION_BODY.id}/heartbeat`,
      jsonRequest("POST", developer.apiKey),
    );
    harness.clock.advanceSeconds(80);

    // Assert: 160s after start, but only 80s after the heartbeat
    expect(heartbeat.status).toBe(200);
    const presence = await fetchPresence(harness, developer.apiKey);
    expect(presence.sessions).toHaveLength(1);
  });

  test("heartbeat with a status updates the session status", async () => {
    const harness = await createTestHarness();
    const developer = await createTestDeveloper(
      harness,
      "Nick",
      "nick@example.com",
    );
    await registerTestSession(harness, developer.apiKey);

    const response = await harness.app.request(
      `/api/sessions/${VALID_SESSION_BODY.id}/heartbeat`,
      jsonRequest("POST", developer.apiKey, { status: "testing" }),
    );

    expect(response.status).toBe(200);
    const presence = await fetchPresence(harness, developer.apiKey);
    expect(presence.sessions[0]?.status).toBe("testing");
  });

  test("returns 404 for an unknown session", async () => {
    const harness = await createTestHarness();
    const developer = await createTestDeveloper(
      harness,
      "Nick",
      "nick@example.com",
    );

    const response = await harness.app.request(
      "/api/sessions/ses_ghost/heartbeat",
      jsonRequest("POST", developer.apiKey),
    );

    expect(response.status).toBe(404);
  });

  test("returns 403 when heartbeating someone else's session", async () => {
    const harness = await createTestHarness();
    const owner = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const intruder = await createTestDeveloper(harness, "Can", "can@example.com");
    await registerTestSession(harness, owner.apiKey);

    const response = await harness.app.request(
      `/api/sessions/${VALID_SESSION_BODY.id}/heartbeat`,
      jsonRequest("POST", intruder.apiKey),
    );

    expect(response.status).toBe(403);
  });

  test("returns 409 when heartbeating an ended session", async () => {
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
    const response = await harness.app.request(
      `/api/sessions/${VALID_SESSION_BODY.id}/heartbeat`,
      jsonRequest("POST", developer.apiKey),
    );

    // Assert
    expect(response.status).toBe(409);
  });
});

describe("POST /api/sessions/:id/end", () => {
  test("ends a session and removes it from presence", async () => {
    // Arrange
    const harness = await createTestHarness();
    const developer = await createTestDeveloper(
      harness,
      "Nick",
      "nick@example.com",
    );
    await registerTestSession(harness, developer.apiKey);

    // Act
    const response = await harness.app.request(
      `/api/sessions/${VALID_SESSION_BODY.id}/end`,
      jsonRequest("POST", developer.apiKey),
    );

    // Assert
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { session: { status: string; endedAt: string | null } };
    };
    expect(body.data.session.status).toBe("done");
    expect(body.data.session.endedAt).not.toBeNull();
    const presence = await fetchPresence(harness, developer.apiKey);
    expect(presence.sessions).toHaveLength(0);
  });

  test("ending twice is idempotent and returns 200", async () => {
    const harness = await createTestHarness();
    const developer = await createTestDeveloper(
      harness,
      "Nick",
      "nick@example.com",
    );
    await registerTestSession(harness, developer.apiKey);
    const endPath = `/api/sessions/${VALID_SESSION_BODY.id}/end`;

    const first = await harness.app.request(
      endPath,
      jsonRequest("POST", developer.apiKey),
    );
    const second = await harness.app.request(
      endPath,
      jsonRequest("POST", developer.apiKey),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  test("returns 403 when ending someone else's session", async () => {
    const harness = await createTestHarness();
    const owner = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const intruder = await createTestDeveloper(harness, "Can", "can@example.com");
    await registerTestSession(harness, owner.apiKey);

    const response = await harness.app.request(
      `/api/sessions/${VALID_SESSION_BODY.id}/end`,
      jsonRequest("POST", intruder.apiKey),
    );

    expect(response.status).toBe(403);
  });

  test("re-registering an ended session returns 409", async () => {
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

    const response = await registerTestSession(harness, developer.apiKey);

    expect(response.status).toBe(409);
  });
});