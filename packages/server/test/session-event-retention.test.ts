/**
 * CSK-14 — THE AGE-BASED SWEEP IS WITHDRAWN, AND THE TABLE IS UNBOUNDED ON
 * PURPOSE.
 *
 * D2 said "a claim older than thirty days keeps its body and loses its
 * position", and the sweep that delivered it ran from `reapStaleSessions`.
 * What it deleted was very nearly the CAUSAL SKELETON itself: every column in
 * `session_events` is already a ref or an enum — no body, no prose, no path —
 * so the row it removed WAS the ids, the kind, the epoch and the position.
 * There is no setting on an age sweep that keeps `A happens-before B` while
 * letting the surrounding detail go, because the surrounding detail was never
 * in this table.
 *
 * SO THE CALL IS GONE, and this file is what says so. Deploying a retention
 * mechanism already known to delete exactly the rows later causal statements
 * need is the risk; "01a ships within thirty days" is not an answer, because
 * it makes data survival depend on a delivery date. `SESSION_EVENT_RETENTION_DAYS`
 * and `pruneSessionEvents` stay DORMANT — 01a's referential predicate is what
 * will retire a row, by whether anything still points at it, not by its age.
 *
 * A REFUSAL IS ONLY A REFUSAL IF SOMEBODY IS TOLD. The other half of this
 * ticket is the `doctor` line, in cli/test/seq-doctor-hub.test.ts: the hub
 * declares the mode on the route doctor already reads, and an operator has to
 * be able to see that the table grows without bound BY DECISION rather than
 * discovering it as a surprise.
 *
 * AND THE DORMANT SWEEP STAYS TESTED. 01a switches retention back on by
 * narrowing this same function's predicate — age first, then "nothing points
 * at it" — so its age cutoff is still the half 01a builds on, and the last
 * test below keeps that half honest while nothing calls it.
 */
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { SESSION_EVENT_RETENTION_DAYS } from "../src/constants.ts";
import { sessionEvents } from "../src/db/schema.ts";
import { pruneSessionEvents } from "../src/services/session-events.ts";
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
const LATER_SESSION = "cc_retention_later";
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

describe("session_events retention is withdrawn", () => {
  test("a session past the window keeps every row, reaper pass included", async () => {
    // Arrange: exactly the session the sweep was written for — ended, older
    // than the retention window, and referenced by nothing. Under the sweep
    // its rows were deleted; under the refusal they are the causal skeleton of
    // work a later statement may still have to be ordered against.
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
    await endSession(
      { db: harness.db, now: harness.clock.now },
      dev.developerId,
      SESSION,
    );
    const before = await rowsFor(harness, SESSION);
    expect(before).toBeGreaterThan(0);

    // Act: past the window by a day, and then the hub's ONE standalone pass —
    // the place the sweep used to run from, so a call left behind anywhere on
    // this path still shows up here.
    harness.clock.advanceSeconds((SESSION_EVENT_RETENTION_DAYS + 1) * DAY_SECONDS);
    await reapStaleSessions({ db: harness.db, now: harness.clock.now });

    // Assert: EVERY row, not merely some. A partial sweep is the same defect.
    expect(await rowsFor(harness, SESSION)).toBe(before);
  });

  test("a pass that does close a session still keeps the old rows", async () => {
    // Arrange: the sweep used to run BEFORE the pass's early return, so it
    // fired on both paths. This is the other one — a pass with a real
    // candidate to close — because a call restored further down
    // `reapStaleSessions` would be invisible to the test above.
    const harness = await createTestHarness();
    const dev = await createTestDeveloper(harness, "Nick", "busy@example.com");
    await registerTestSession(harness, dev.apiKey, { id: SESSION });
    await endSession(
      { db: harness.db, now: harness.clock.now },
      dev.developerId,
      SESSION,
    );
    const before = await rowsFor(harness, SESSION);
    harness.clock.advanceSeconds((SESSION_EVENT_RETENTION_DAYS + 1) * DAY_SECONDS);
    // A live session that has been silent long enough to be reaped, so the
    // pass takes its writing path rather than the early return.
    await registerTestSession(harness, dev.apiKey, { id: "cc_stale" });
    harness.clock.advanceSeconds(DAY_SECONDS);

    // Act
    const pass = await reapStaleSessions({ db: harness.db, now: harness.clock.now });

    // Assert
    expect(pass.ended.length).toBeGreaterThan(0);
    expect(await rowsFor(harness, SESSION)).toBe(before);
  });
});

describe("the dormant sweep, called directly", () => {
  test("still retires only what is past the window", async () => {
    // Arrange: one ended session, the clock past the window, then a second
    // session that works — and a second of hub time before the sweep, so
    // "survives" means survives a sweep that ran AFTER its rows. Without that
    // second a cutoff of zero looks identical to a cutoff of thirty days, and
    // the constant 01a keeps would be unfalsifiable.
    const harness = await createTestHarness();
    const dev = await createTestDeveloper(harness, "Nick", "dormant@example.com");
    await registerTestSession(harness, dev.apiKey, { id: SESSION });
    await endSession(
      { db: harness.db, now: harness.clock.now },
      dev.developerId,
      SESSION,
    );
    harness.clock.advanceSeconds((SESSION_EVENT_RETENTION_DAYS + 1) * DAY_SECONDS);
    await registerTestSession(harness, dev.apiKey, { id: LATER_SESSION });
    harness.clock.advanceSeconds(1);

    // Act: nothing in the hub calls this any more; only 01a will.
    await pruneSessionEvents({ db: harness.db, now: harness.clock.now });

    // Assert
    expect(await rowsFor(harness, SESSION)).toBe(0);
    expect(await rowsFor(harness, LATER_SESSION)).toBeGreaterThan(0);
  });
});
