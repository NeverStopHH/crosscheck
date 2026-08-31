/**
 * The hub closes sessions that stopped heartbeating (trial finding M6).
 *
 * `/api/events` on the trial hub: 127 sessions started, 23 ended, 104 never
 * ended. `endSession` was the only writer of `ended_at` and nothing ran on a
 * timer, so a killed orchestration agent, a closed terminal or a SessionEnd
 * that ran out of budget left a row every listing treated as live work.
 *
 * THE FIRST TEST IS THE SAFETY ONE, deliberately. A reaper that closes a LIVE
 * session makes ingest reject its records (`services/records.ts
 * checkProducerSession`), which is the connector deafness this whole batch
 * exists to remove — re-created from the server side. The predicate is the
 * thing that must be right.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { agentSessions } from "../src/db/schema.ts";
import {
  listOpenSessions,
  reapStaleSessions,
} from "../src/services/sessions.ts";
import {
  createTestDeveloper,
  createTestHarness,
  fetchEvents,
  jsonRequest,
  registerTestSession,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const HOUR_SECONDS = 3600;

const seed = async (): Promise<{
  harness: TestHarness;
  developer: TestDeveloper;
}> => {
  const harness = await createTestHarness();
  const developer = await createTestDeveloper(harness, "Nick", "nick@example.com");
  return { harness, developer };
};

const endedAtOf = async (
  harness: TestHarness,
  sessionId: string,
): Promise<Date | null> => {
  const rows = await harness.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId));
  return rows[0]?.endedAt ?? null;
};

describe("reapStaleSessions", () => {
  test("a session heartbeating every twenty seconds is NEVER reaped", async () => {
    // Arrange: seven hours of a healthy session, in twenty-second steps
    const { harness, developer } = await seed();
    await registerTestSession(harness, developer.apiKey);

    // Act
    for (let step = 0; step < 7 * 3 * 60; step += 1) {
      harness.clock.advanceSeconds(20);
      await harness.app.request(
        "/api/sessions/ses_01/heartbeat",
        jsonRequest("POST", developer.apiKey, {}),
      );
    }
    await reapStaleSessions({ db: harness.db, now: harness.clock.now });

    // Assert: still open after seven hours of work
    expect(await endedAtOf(harness, "ses_01")).toBeNull();
  });

  test("a session silent for seven hours is ended, once, with an event", async () => {
    // Arrange
    const { harness, developer } = await seed();
    await registerTestSession(harness, developer.apiKey);
    harness.clock.advanceSeconds(7 * HOUR_SECONDS);

    // Act
    const first = await reapStaleSessions({
      db: harness.db,
      now: harness.clock.now,
    });
    const second = await reapStaleSessions({
      db: harness.db,
      now: harness.clock.now,
    });

    // Assert: closed, idempotent, and the ledger says who closed it
    expect(first.ended).toHaveLength(1);
    expect(second.ended).toHaveLength(0);
    expect(await endedAtOf(harness, "ses_01")).not.toBeNull();
    const ended = (await fetchEvents(harness, developer.apiKey)).filter(
      (event) => event.kind === "session_ended",
    );
    expect(ended).toHaveLength(1);
    expect(
      (ended[0]?.payload as { reapedAfterHours?: number }).reapedAfterHours,
    ).toBe(6);
  });

  test("the reap is confined to one developer when asked", async () => {
    // Arrange: two developers, both stale
    const { harness, developer } = await seed();
    const other = await createTestDeveloper(harness, "Ken", "ken@example.com");
    await registerTestSession(harness, developer.apiKey);
    await registerTestSession(harness, other.apiKey, { id: "ses_ken" });
    harness.clock.advanceSeconds(7 * HOUR_SECONDS);

    // Act: the SessionStart path's own bounded pass
    await reapStaleSessions(
      { db: harness.db, now: harness.clock.now },
      { developerId: developer.developerId },
    );

    // Assert: one person's backlog never costs another's
    expect(await endedAtOf(harness, "ses_01")).not.toBeNull();
    expect(await endedAtOf(harness, "ses_ken")).toBeNull();
  });

  test("the per-pass limit is honoured", async () => {
    // Arrange: three stale sessions
    const { harness, developer } = await seed();
    for (const id of ["ses_a", "ses_b", "ses_c"]) {
      await registerTestSession(harness, developer.apiKey, { id });
    }
    harness.clock.advanceSeconds(7 * HOUR_SECONDS);

    // Act
    const pass = await reapStaleSessions(
      { db: harness.db, now: harness.clock.now },
      { limit: 2 },
    );

    // Assert
    expect(pass.ended).toHaveLength(2);
  });
});

describe("GET /api/sessions?open=1", () => {
  test("a session that is heartbeating is NOT listed as open", async () => {
    // Arrange: one perfectly healthy session, twenty seconds into its life —
    // the state every developer is in while they work
    const { harness, developer } = await seed();
    await registerTestSession(harness, developer.apiKey);
    harness.clock.advanceSeconds(20);
    await harness.app.request(
      "/api/sessions/ses_01/heartbeat",
      jsonRequest("POST", developer.apiKey, {}),
    );

    // Act
    const open = await listOpenSessions(
      { db: harness.db, now: harness.clock.now },
      developer.developerId,
      { mine: true },
    );

    // Assert: "open" has to mean "open and no longer reporting", or doctor's
    // `unclosed sessions` line WARNs for as long as anybody is working
    // (review finding B2-03)
    expect(open).toHaveLength(0);
  });

  test("a session silent for two hours is not open yet either", async () => {
    // Arrange: past the presence TTL and past the zombie-state hour, but well
    // inside a working day — a long read, a meeting, lunch
    const { harness, developer } = await seed();
    await registerTestSession(harness, developer.apiKey);
    harness.clock.advanceSeconds(2 * HOUR_SECONDS);

    // Act
    const open = await listOpenSessions(
      { db: harness.db, now: harness.clock.now },
      developer.developerId,
      { mine: true },
    );

    // Assert: the threshold is the reaper's, so the line and the reap agree
    expect(open).toHaveLength(0);
  });

  test("lists the silent backlog, and drops it once the reaper runs", async () => {
    // Arrange: two sessions, one of them silent for seven hours
    const { harness, developer } = await seed();
    await registerTestSession(harness, developer.apiKey, { id: "ses_stale" });
    harness.clock.advanceSeconds(7 * HOUR_SECONDS);

    // Act: before — note that registering the second one already reaps
    const before = await listOpenSessions(
      { db: harness.db, now: harness.clock.now },
      developer.developerId,
      { mine: true },
    );
    await registerTestSession(harness, developer.apiKey, { id: "ses_fresh" });
    const response = await harness.app.request(
      "/api/sessions?open=1&mine=1",
      jsonRequest("GET", developer.apiKey),
    );
    const body = (await response.json()) as {
      data: { sessions: { id: string }[] };
    };

    // Assert: the backlog is what the endpoint is for. ses_stale was the only
    // row worth naming and the reap closed it; ses_fresh is a session someone
    // is running, which is not an unclosed session (review finding B2-03).
    expect(before.map((session) => session.id)).toEqual(["ses_stale"]);
    expect(response.status).toBe(200);
    expect(body.data.sessions).toEqual([]);
  });

  test("registering a session reaps the registering developer's own corpses", async () => {
    // Arrange
    const { harness, developer } = await seed();
    await registerTestSession(harness, developer.apiKey, { id: "ses_old" });
    harness.clock.advanceSeconds(7 * HOUR_SECONDS);

    // Act: the SessionStart path
    await registerTestSession(harness, developer.apiKey, { id: "ses_new" });

    // Assert
    expect(await endedAtOf(harness, "ses_old")).not.toBeNull();
    expect(await endedAtOf(harness, "ses_new")).toBeNull();
  });

  test("the route refuses a shape it does not serve rather than scanning", async () => {
    // Arrange
    const { harness, developer } = await seed();

    // Act
    const response = await harness.app.request(
      "/api/sessions",
      jsonRequest("GET", developer.apiKey),
    );

    // Assert
    expect(response.status).toBe(400);
  });
});
