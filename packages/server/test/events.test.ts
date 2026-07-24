import { describe, expect, test } from "bun:test";

import { events } from "../src/db/schema.ts";
import { EVENTS_DEFAULT_LIMIT, EVENTS_MAX_LIMIT } from "../src/index.ts";
import {
  createTestDeveloper,
  createTestHarness,
  fetchEvents,
  jsonRequest,
  registerTestSession,
  VALID_SESSION_BODY,
} from "./helpers.ts";

describe("GET /api/events", () => {
  test("events limit constants match the spec", () => {
    expect(EVENTS_DEFAULT_LIMIT).toBe(100);
    expect(EVENTS_MAX_LIMIT).toBe(500);
  });

  test("session registration and end produce ordered events", async () => {
    // Arrange
    const harness = await createTestHarness();
    const developer = await createTestDeveloper(
      harness,
      "Nick",
      "nick@example.com",
    );

    // Act
    await registerTestSession(harness, developer.apiKey);
    await harness.app.request(
      `/api/sessions/${VALID_SESSION_BODY.id}/end`,
      jsonRequest("POST", developer.apiKey),
    );

    // Assert
    const allEvents = await fetchEvents(harness, developer.apiKey);
    const started = allEvents.find((e) => e.kind === "session_started");
    const ended = allEvents.find((e) => e.kind === "session_ended");
    expect(started).toBeDefined();
    expect(ended).toBeDefined();
    expect(started!.id).toBeLessThan(ended!.id);
    expect(started!.payload["sessionId"]).toBe(VALID_SESSION_BODY.id);
    expect(ended!.payload["sessionId"]).toBe(VALID_SESSION_BODY.id);
  });

  test("event payloads contain only ids and metadata", async () => {
    // Arrange
    const harness = await createTestHarness();
    const developer = await createTestDeveloper(
      harness,
      "Nick",
      "nick@example.com",
    );

    // Act
    await registerTestSession(harness, developer.apiKey);

    // Assert
    const allEvents = await fetchEvents(harness, developer.apiKey);
    const started = allEvents.find((e) => e.kind === "session_started");
    expect(Object.keys(started!.payload).sort()).toEqual([
      "branch",
      "developerId",
      "repo",
      "sessionId",
    ]);
  });

  test("cursor replay returns only events after the cursor", async () => {
    // Arrange
    const harness = await createTestHarness();
    const developer = await createTestDeveloper(
      harness,
      "Nick",
      "nick@example.com",
    );
    await registerTestSession(harness, developer.apiKey, { id: "ses_first" });
    await harness.app.request(
      "/api/sessions/ses_first/end",
      jsonRequest("POST", developer.apiKey),
    );
    await registerTestSession(harness, developer.apiKey, { id: "ses_second" });
    const allEvents = await fetchEvents(harness, developer.apiKey);
    const endedEvent = allEvents.find((e) => e.kind === "session_ended");

    // Act
    const replayed = await fetchEvents(
      harness,
      developer.apiKey,
      `?after=${endedEvent!.id}`,
    );

    // Assert
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.every((e) => e.id > endedEvent!.id)).toBe(true);
    const secondStart = replayed.find(
      (e) =>
        e.kind === "session_started" && e.payload["sessionId"] === "ses_second",
    );
    expect(secondStart).toBeDefined();
  });

  test("respects an explicit limit and keeps ascending order", async () => {
    // Arrange
    const harness = await createTestHarness();
    const developer = await createTestDeveloper(
      harness,
      "Nick",
      "nick@example.com",
    );
    await registerTestSession(harness, developer.apiKey, { id: "ses_a" });
    await registerTestSession(harness, developer.apiKey, { id: "ses_b" });

    // Act
    const limited = await fetchEvents(harness, developer.apiKey, "?limit=2");

    // Assert
    expect(limited).toHaveLength(2);
    expect(limited[0]!.id).toBeLessThan(limited[1]!.id);
  });

  test("caps an oversized limit at EVENTS_MAX_LIMIT", async () => {
    // Arrange
    const harness = await createTestHarness();
    const developer = await createTestDeveloper(
      harness,
      "Nick",
      "nick@example.com",
    );
    const bulkRows = Array.from(
      { length: EVENTS_MAX_LIMIT + 50 },
      (_, index) => ({
        kind: "test_event",
        payload: { index },
        createdAt: harness.clock.now(),
      }),
    );
    await harness.db.insert(events).values(bulkRows);

    // Act
    const page = await fetchEvents(harness, developer.apiKey, "?limit=99999");

    // Assert
    expect(page).toHaveLength(EVENTS_MAX_LIMIT);
  });

  test("rejects a non-numeric cursor with 400", async () => {
    const harness = await createTestHarness();
    const developer = await createTestDeveloper(
      harness,
      "Nick",
      "nick@example.com",
    );

    const response = await harness.app.request(
      "/api/events?after=abc",
      jsonRequest("GET", developer.apiKey),
    );

    expect(response.status).toBe(400);
  });
});