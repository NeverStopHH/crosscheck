/**
 * The reaper's verdict must never cost a live session its capture (review
 * finding B2-01/B2-L1).
 *
 * `last_heartbeat_at` was moved by exactly two writers — `registerSession` and
 * `heartbeatSession` — and the connector only heartbeats from PostToolUse on
 * an Edit or a Bash (`connector-claude/src/hooks/post-tool-use.ts`, the
 * ledger's M7). A session that prompts, reads, greps and reviews for six hours
 * therefore carries a six-hour-old heartbeat while being fully alive, and the
 * reap predicate could not tell it from a killed terminal. Once reaped,
 * `checkProducerSession` answered every one of its records with HTTP 200 /
 * `accepted:0` / `rejected:N`, and `spool/flush.ts` advanced the cursor past
 * them — rejected-as-delivered, which is the H4 deafness re-created from the
 * server side.
 *
 * Two mechanisms are pinned here, in the order they matter:
 *
 *  1. INGEST IS A HEARTBEAT. A record arriving from a session is proof it is
 *     running, so it refreshes `last_heartbeat_at` and the session never
 *     becomes a candidate in the first place.
 *  2. THE VERDICT IS REVOCABLE. When the reaper was wrong anyway — a session
 *     that only read for six hours and then captured something — the record
 *     that proves it revives the row instead of being discarded. A session
 *     ended by its OWN SessionEnd keeps rejecting late writes, which is the
 *     semantics the gate was built for.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { agentSessions } from "../src/db/schema.ts";
import { reapStaleSessions } from "../src/services/sessions.ts";
import {
  createTestDeveloper,
  createTestHarness,
  fetchEvents,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validWorkContextBody,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const HOUR_SECONDS = 3600;

const seed = async (): Promise<{
  harness: TestHarness;
  developer: TestDeveloper;
}> => {
  const harness = await createTestHarness();
  const developer = await createTestDeveloper(
    harness,
    "Nick",
    "nick@example.com",
  );
  return { harness, developer };
};

const sessionRow = async (
  harness: TestHarness,
  sessionId: string,
): Promise<typeof agentSessions.$inferSelect | undefined> => {
  const rows = await harness.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId));
  return rows[0];
};

const postContext = async (
  harness: TestHarness,
  developer: TestDeveloper,
  contextId: string,
): Promise<{ accepted: number; rejected: number }> => {
  const result = await postRecords(harness, developer, {
    records: [
      recordEnvelope("work_context", validWorkContextBody({ id: contextId })),
    ],
  });
  return {
    accepted: result.data?.accepted ?? -1,
    rejected: result.data?.rejected ?? -1,
  };
};

describe("ingest keeps a session alive", () => {
  test("a session that only posts records for seven hours is NEVER reaped", async () => {
    // Arrange: registration, then seven hours of capture and no Edit/Bash
    // PostToolUse at all — the shape the heartbeat gate cannot see.
    const { harness, developer } = await seed();
    await registerTestSession(harness, developer.apiKey);

    // Act
    for (let step = 0; step < 7 * 4; step += 1) {
      harness.clock.advanceSeconds(15 * 60);
      await postContext(harness, developer, `wc_step_${String(step)}`);
    }
    await reapStaleSessions({ db: harness.db, now: harness.clock.now });

    // Assert: seven hours of landed capture is not a dead session
    expect((await sessionRow(harness, "ses_01"))?.endedAt ?? null).toBeNull();
  });
});

describe("a reaped session is revived by the evidence that disproves the reap", () => {
  test("its next record is accepted, not answered 200/accepted:0", async () => {
    // Arrange: a live session that read for seven hours, then a sibling
    // SessionStart runs the register-path reaper over it
    const { harness, developer } = await seed();
    await registerTestSession(harness, developer.apiKey);
    harness.clock.advanceSeconds(7 * HOUR_SECONDS);
    await registerTestSession(harness, developer.apiKey, { id: "ses_other" });
    expect(
      (await sessionRow(harness, "ses_01"))?.endedAt ?? null,
    ).not.toBeNull();

    // Act: the session was alive all along and now captures something
    const outcome = await postContext(harness, developer, "wc_after_reap");

    // Assert: the record lands and the row is open again
    expect(outcome).toEqual({ accepted: 1, rejected: 0 });
    const revived = await sessionRow(harness, "ses_01");
    expect(revived?.endedAt ?? null).toBeNull();
    expect(revived?.reapedAt ?? null).toBeNull();
  });

  test("the ledger records the reopening instead of ending at the reap", async () => {
    // Arrange
    const { harness, developer } = await seed();
    await registerTestSession(harness, developer.apiKey);
    harness.clock.advanceSeconds(7 * HOUR_SECONDS);
    await reapStaleSessions({ db: harness.db, now: harness.clock.now });

    // Act
    await postContext(harness, developer, "wc_after_reap");

    // Assert: /api/events is a ledger, so a reversed end has to appear in it
    const events = await fetchEvents(harness, developer.apiKey);
    const mine = events.filter(
      (event) =>
        event.kind.startsWith("session_") &&
        (event.payload as { sessionId?: string }).sessionId === "ses_01",
    );
    expect(mine.map((event) => event.kind)).toEqual([
      "session_started",
      "session_ended",
      "session_started",
    ]);
    expect(
      (mine[2]?.payload as { revivedAfterReap?: boolean }).revivedAfterReap,
    ).toBe(true);
  });

  test("a SessionStart re-fire revives it too, rather than answering already_ended", async () => {
    // Arrange
    const { harness, developer } = await seed();
    await registerTestSession(harness, developer.apiKey);
    harness.clock.advanceSeconds(7 * HOUR_SECONDS);
    await reapStaleSessions({ db: harness.db, now: harness.clock.now });

    // Act: the same session id re-registering (compact / resume / clear)
    const response = await registerTestSession(harness, developer.apiKey);

    // Assert
    expect(response.status).toBe(200);
    expect((await sessionRow(harness, "ses_01"))?.endedAt ?? null).toBeNull();
  });

  test("a session ended by its OWN SessionEnd still rejects late writes", async () => {
    // Arrange: the semantics the producer gate was built for
    const { harness, developer } = await seed();
    await registerTestSession(harness, developer.apiKey);
    await harness.app.request(
      "/api/sessions/ses_01/end",
      jsonRequest("POST", developer.apiKey, {}),
    );

    // Act
    const outcome = await postContext(harness, developer, "wc_late");

    // Assert: a real end is a real end
    expect(outcome).toEqual({ accepted: 0, rejected: 1 });
    expect(
      (await sessionRow(harness, "ses_01"))?.endedAt ?? null,
    ).not.toBeNull();
  });
});
