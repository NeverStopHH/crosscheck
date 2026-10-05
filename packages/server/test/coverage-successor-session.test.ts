/**
 * REVIEW OF H3, FINDING 3: the session that moved a work context into the
 * window is read by the coverage beside the answer that names the context.
 *
 * Trace picks a candidate by `coalesce(updated_at, created_at)`, and an
 * update is stamped with the hub's clock at ingest — so a context created
 * twenty days ago is a candidate because a LATER session delivered an update
 * to it (a spool drained by a successor, whose producer is rewritten to the
 * flushing session). Trace names the creator; the rung's path scope keyed on
 * the creator too, so the session behind the in-window activity was read
 * nowhere: reaped, the rung still said `complete / sessions_reported`, and
 * clean, it said nobody reported on the files at all.
 *
 * `work_contexts.updated_by_session_id` records the producer of the latest
 * update, and the path scope reads it beside the creator.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { workContexts } from "../src/db/schema.ts";
import type { CoverageRecord, CoverageSourceRecord } from "../src/services/coverage.ts";
import {
  VALID_SESSION_BODY,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validWorkContextBody,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
const HOUR_SECONDS = 3600;
const DAY_SECONDS = 24 * HOUR_SECONDS;
/** Past the suspect window, so the creator's heartbeat is out of it. */
const OUTSIDE_WINDOW_SECONDS = 20 * DAY_SECONDS;
/** Past SESSION_REAP_STALE_HOURS, so the next register reaps a quiet session. */
const PAST_REAP_SECONDS = 7 * HOUR_SECONDS;

const seed = async (): Promise<{ harness: TestHarness; developer: TestDeveloper }> => {
  const harness = await createTestHarness();
  const developer = await createTestDeveloper(harness, "Nick", "nick@example.com");
  return { harness, developer };
};

const endCleanly = async (harness: TestHarness, developer: TestDeveloper, id: string): Promise<void> => {
  const response = await harness.app.request(
    `/api/sessions/${id}/end`,
    jsonRequest("POST", developer.apiKey, { status: "done" }),
  );
  expect(response.status).toBe(200);
};

const updatedBy = async (harness: TestHarness, id: string): Promise<string | null | undefined> => {
  const rows = await harness.db
    .select({ updatedBy: workContexts.updatedBySessionId })
    .from(workContexts)
    .where(eq(workContexts.id, id));
  return rows[0]?.updatedBy;
};

/**
 * S1 opens wc1 on src/auth.ts and ends; twenty days on, S2 — working on its
 * own context on another file, so it is a session that reported a file
 * target — delivers an update to wc1 touching src/session.ts.
 */
const successorUpdate = async (harness: TestHarness, developer: TestDeveloper): Promise<void> => {
  await registerTestSession(harness, developer.apiKey, { id: "ses_s1" });
  await postRecords(harness, developer, {
    records: [
      recordEnvelope("work_context", validWorkContextBody({ id: "wc1", sessionId: "ses_s1" }), { sessionId: "ses_s1" }),
      recordEnvelope("target", { workContextId: "wc1", kind: "file", value: "src/auth.ts" }, { sessionId: "ses_s1" }),
    ],
  });
  await endCleanly(harness, developer, "ses_s1");
  harness.clock.advanceSeconds(OUTSIDE_WINDOW_SECONDS);
  await registerTestSession(harness, developer.apiKey, { id: "ses_s2" });
  await postRecords(harness, developer, {
    records: [
      recordEnvelope("work_context", validWorkContextBody({ id: "wc2", sessionId: "ses_s2", title: "side quest" }), {
        sessionId: "ses_s2",
      }),
      recordEnvelope("target", { workContextId: "wc2", kind: "file", value: "src/other.ts" }, { sessionId: "ses_s2" }),
      recordEnvelope(
        "work_context",
        validWorkContextBody({ id: "wc1", sessionId: "ses_s1", title: "Login 500s, again" }),
        { sessionId: "ses_s2" },
      ),
      recordEnvelope("target", { workContextId: "wc1", kind: "file", value: "src/session.ts" }, { sessionId: "ses_s2" }),
    ],
  });
};

const traceOf = async (
  harness: TestHarness,
  developer: TestDeveloper,
): Promise<{ candidates: string[]; agentEvent: CoverageSourceRecord }> => {
  const response = await harness.app.request(
    `/api/suspect?repo=${encodeURIComponent(REPO)}&path=src/session.ts`,
    jsonRequest("GET", developer.apiKey),
  );
  expect(response.status).toBe(200);
  const data = ((await response.json()) as {
    data: { candidates: { sessionId: string }[]; coverage: CoverageRecord };
  }).data;
  const agentEvent = data.coverage.sources.find((row) => row.source === "agent_event");
  if (agentEvent === undefined) {
    throw new Error("agent_event row missing");
  }
  return { candidates: data.candidates.map((candidate) => candidate.sessionId), agentEvent };
};

describe("the hub records which session delivered a work context's latest update", () => {
  test("an update records its producer; a create and an unchanged replay record nothing", async () => {
    // Arrange
    const { harness, developer } = await seed();
    await registerTestSession(harness, developer.apiKey, { id: "ses_s1" });
    const body = validWorkContextBody({ id: "wc1", sessionId: "ses_s1" });
    // Act
    await postRecords(harness, developer, {
      records: [recordEnvelope("work_context", body, { sessionId: "ses_s1" })],
    });
    const afterCreate = await updatedBy(harness, "wc1");
    await registerTestSession(harness, developer.apiKey, { id: "ses_s2" });
    await postRecords(harness, developer, {
      records: [recordEnvelope("work_context", body, { sessionId: "ses_s2" })],
    });
    const afterReplay = await updatedBy(harness, "wc1");
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", { ...body, title: "Login 500s, again" }, { sessionId: "ses_s2" }),
      ],
    });
    // Assert
    expect(afterCreate).toBeNull();
    expect(afterReplay).toBeNull();
    expect(await updatedBy(harness, "wc1")).toBe("ses_s2");
  });
});

describe("trace's rung reads the session behind its candidate's in-window activity", () => {
  test("a successor reaped after delivering the update makes the rung incomplete / session_reaped", async () => {
    // Arrange: S2 goes quiet past the reap threshold; S3 reports on the file today.
    const { harness, developer } = await seed();
    await successorUpdate(harness, developer);
    harness.clock.advanceSeconds(PAST_REAP_SECONDS);
    await registerTestSession(harness, developer.apiKey, { id: "ses_s3" });
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ id: "wc3", sessionId: "ses_s3", title: "third" }), {
          sessionId: "ses_s3",
        }),
        recordEnvelope("target", { workContextId: "wc3", kind: "file", value: "src/session.ts" }, { sessionId: "ses_s3" }),
      ],
    });
    // Act
    const trace = await traceOf(harness, developer);
    // Assert
    expect(trace.candidates).toContain("ses_s1");
    expect(trace.agentEvent).toMatchObject({ state: "incomplete", reason: "session_reaped" });
  });

  test("a successor that delivered the update and ended cleanly is somebody reporting on the files", async () => {
    // Arrange
    const { harness, developer } = await seed();
    await successorUpdate(harness, developer);
    await endCleanly(harness, developer, "ses_s2");
    harness.clock.advanceSeconds(HOUR_SECONDS);
    // Act
    const trace = await traceOf(harness, developer);
    // Assert
    expect(trace.candidates).toEqual(["ses_s1"]);
    expect(trace.agentEvent).toMatchObject({ state: "complete", reason: "sessions_reported" });
  });
});
