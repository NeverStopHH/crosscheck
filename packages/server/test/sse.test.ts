import { describe, expect, test } from "bun:test";

import {
  createTestDeveloper,
  createTestHarness,
  fetchEvents,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validWorkContextBody,
  VALID_SESSION_BODY,
} from "./helpers.ts";

const MAX_STREAM_READS = 20;

/** Structural reader type — bun-types and lib.dom reader generics disagree. */
interface ByteStreamReader {
  read(): Promise<{ value?: Uint8Array | undefined; done: boolean }>;
}

const readStreamUntil = async (
  reader: ByteStreamReader,
  isComplete: (text: string) => boolean,
): Promise<string> => {
  const decoder = new TextDecoder();
  let text = "";
  for (let i = 0; i < MAX_STREAM_READS && !isComplete(text); i += 1) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text;
};

describe("GET /api/events/stream", () => {
  test("requires bearer auth like every other route", async () => {
    const harness = await createTestHarness();

    const response = await harness.app.request("/api/events/stream");

    expect(response.status).toBe(401);
  });

  test("replays events after Last-Event-ID as SSE frames", async () => {
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
    const allEvents = await fetchEvents(harness, developer.apiKey);
    const started = allEvents.find((e) => e.kind === "session_started");
    const ended = allEvents.find((e) => e.kind === "session_ended");

    // Act: resume after the session_started event
    const response = await harness.app.request("/api/events/stream", {
      headers: {
        Authorization: `Bearer ${developer.apiKey}`,
        "Last-Event-ID": String(started!.id),
      },
    });

    // Assert
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const text = await readStreamUntil(reader, (t) => t.includes("\n\n"));
    await reader.cancel();
    expect(text).toContain("event: session_ended");
    expect(text).toContain(`id: ${ended!.id}`);
    expect(text).toContain(VALID_SESSION_BODY.id);
    expect(text).not.toContain("event: session_started");
  });

  test("replays the full outbox when no cursor is provided", async () => {
    // Arrange
    const harness = await createTestHarness();
    const developer = await createTestDeveloper(
      harness,
      "Nick",
      "nick@example.com",
    );
    await registerTestSession(harness, developer.apiKey);

    // Act
    const response = await harness.app.request("/api/events/stream", {
      headers: { Authorization: `Bearer ${developer.apiKey}` },
    });

    // Assert
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const text = await readStreamUntil(reader, (t) =>
      t.includes("event: session_started"),
    );
    await reader.cancel();
    expect(text).toContain("event: developer_created");
    expect(text).toContain("event: session_started");
  });

  test("the stream hides every event attributed to an opted-out developer", async () => {
    // Arrange: Robin publishes a work context, then opts out. Nick's own
    // session_started is appended AFTER Robin's rows, so once its frame
    // arrives the stream has already passed everything about Robin.
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const robin = await createTestDeveloper(
      harness,
      "Robin",
      "robin@example.com",
    );
    await registerTestSession(harness, robin.apiKey, { id: "ses_robin" });
    const seeded = await postRecords(harness, robin, {
      records: [
        recordEnvelope(
          "work_context",
          validWorkContextBody({ id: "wc_robin", sessionId: "ses_robin" }),
          { sessionId: "ses_robin" },
        ),
      ],
    });
    expect(seeded.data?.accepted).toBe(1);
    const optOut = await harness.app.request(
      "/api/settings/presence",
      jsonRequest("PUT", robin.apiKey, { optOut: true }),
    );
    expect(optOut.status).toBe(200);
    await registerTestSession(harness, nick.apiKey);

    // Act
    const response = await harness.app.request("/api/events/stream", {
      headers: { Authorization: `Bearer ${nick.apiKey}` },
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const text = await readStreamUntil(reader, (t) =>
      t.includes("event: session_started"),
    );
    await reader.cancel();

    // Assert: Nick's own marker frame arrived; no frame about Robin did —
    // knowledge kinds included, they carry Robin's developerId and a server
    // timestamp (the live-activity leak the polled-GET pin also guards).
    expect(text).toContain("event: session_started");
    expect(text).not.toContain("event: work_context_created");
    expect(text).not.toContain("ses_robin");
  });
});