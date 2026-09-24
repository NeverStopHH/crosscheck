/**
 * CSK-14'S SUCCESSOR — THE SWEEP IS BACK, ON THE REAPER'S OWN PASS, AND ONLY
 * THERE (1.0 spec 01a §3.3g, §6).
 *
 * D2's age sweep ran from `reapStaleSessions` and deleted every row past
 * thirty days — very nearly the causal skeleton itself — so Nick withdrew it
 * before its first deploy (D-D, 2026-09-17), and this file said so. 01a turns
 * retention back on from the same place with a different predicate: a
 * session goes whole, only when it ended explicitly, nothing reaches it,
 * nothing it touched is unresolved, and — in the interim mode this hub ships
 * in — it touched no file at all (services/retention.ts; the cases that prove
 * each condition are in test/skeleton-sweep.test.ts).
 *
 * WHAT THIS FILE PINS is WHERE it runs: on the timer pass, on both of that
 * pass's paths — the early return and the one that closes sessions — and
 * NOT on the SessionStart pass, which is a hook's request and carries a
 * developer id. A retirement that only happens when there is also a session
 * to close is the defect D2's first sweep had; a sweep on the hook path is a
 * hub-wide cost charged to whichever developer happened to open a session.
 */
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { SESSION_EVENT_RETENTION_DAYS } from "../src/constants.ts";
import { sessionEvents } from "../src/db/schema.ts";
import { endSession, reapStaleSessions } from "../src/services/sessions.ts";
import {
  WORK_CONTEXT_ID,
  createTestDeveloper,
  createTestHarness,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validWorkContextBody,
} from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const EPOCH = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const SESSION = "cc_retention";
const DAY_SECONDS = 24 * 60 * 60;

const rowsFor = async (
  harness: TestHarness,
  sessionId: string,
): Promise<number> => {
  const rows = await harness.db
    .select({ total: sql<number>`count(*)::int` })
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, sessionId));
  return rows[0]?.total ?? 0;
};

/** A session that ended explicitly, with only its lifecycle rows, then aged past the window. */
const agedLifecycleOnly = async (
  email: string,
): Promise<{ readonly harness: TestHarness; readonly developerId: string }> => {
  const harness = await createTestHarness();
  const dev = await createTestDeveloper(harness, "Nick", email);
  await registerTestSession(harness, dev.apiKey, { id: SESSION });
  await endSession({ db: harness.db, now: harness.clock.now }, dev.developerId, SESSION);
  expect(await rowsFor(harness, SESSION)).toBeGreaterThan(0);
  harness.clock.advanceSeconds((SESSION_EVENT_RETENTION_DAYS + 1) * DAY_SECONDS);
  return { harness, developerId: dev.developerId };
};

describe("the skeleton sweep runs from the reaper's timer pass", () => {
  test("a pass with nothing to close retires a session nothing reaches, whole", async () => {
    // Arrange
    const { harness } = await agedLifecycleOnly("early@example.com");

    // Act — the early-return path of the hub's one standalone pass
    const pass = await reapStaleSessions({ db: harness.db, now: harness.clock.now });

    // Assert
    expect(pass.ended).toEqual([]);
    expect(await rowsFor(harness, SESSION)).toBe(0);
  });

  test("a pass that does close a session sweeps as well", async () => {
    // Arrange — a live session silent long enough to be reaped, so the pass
    // takes its writing path rather than the early return
    const { harness } = await agedLifecycleOnly("busy@example.com");
    const dev = await createTestDeveloper(harness, "Mike", "mike-busy@example.com");
    await registerTestSession(harness, dev.apiKey, { id: "cc_stale" });
    harness.clock.advanceSeconds(DAY_SECONDS);

    // Act
    const pass = await reapStaleSessions({ db: harness.db, now: harness.clock.now });

    // Assert
    expect(pass.ended.length).toBeGreaterThan(0);
    expect(await rowsFor(harness, SESSION)).toBe(0);
  });

  test("the SessionStart pass sweeps nothing", async () => {
    // Arrange
    const { harness, developerId } = await agedLifecycleOnly("hook@example.com");
    const before = await rowsFor(harness, SESSION);

    // Act — the pass a SessionStart request runs, confined to its developer
    await reapStaleSessions({ db: harness.db, now: harness.clock.now }, { developerId });

    // Assert
    expect(await rowsFor(harness, SESSION)).toBe(before);
  });

  test("in the interim mode a session that touched a file keeps every row", async () => {
    // Arrange — exactly the session D2's sweep was written for, with an edit
    const harness = await createTestHarness();
    const dev = await createTestDeveloper(harness, "Nick", "d2@example.com");
    await registerTestSession(harness, dev.apiKey, { id: SESSION });
    await postRecords(harness, dev, {
      records: [
        recordEnvelope(
          "work_context",
          validWorkContextBody({ sessionId: SESSION }),
          { sessionId: SESSION },
        ),
        {
          ...recordEnvelope(
            "target",
            {
              workContextId: WORK_CONTEXT_ID,
              kind: "file",
              value: "src/auth/refresh.ts",
              source: "tool_edit",
            },
            { sessionId: SESSION },
          ),
          seq: { epoch: EPOCH, n: 2, after: 1 },
        },
      ],
    });
    await endSession({ db: harness.db, now: harness.clock.now }, dev.developerId, SESSION);
    const before = await rowsFor(harness, SESSION);
    harness.clock.advanceSeconds((SESSION_EVENT_RETENTION_DAYS + 1) * DAY_SECONDS);

    // Act
    await reapStaleSessions({ db: harness.db, now: harness.clock.now });

    // Assert — EVERY row: the file identity is not yet proven on real data
    expect(await rowsFor(harness, SESSION)).toBe(before);
  });
});
