/**
 * D2 — "A CLAIM OLDER THAN THIRTY DAYS KEEPS ITS BODY AND LOSES ITS POSITION."
 *
 * The decision was taken, the constant was written, and nothing could ever
 * reach it. The prune was keyed on ONE session and ran in-band on a write for
 * that same session — but a session is TERMINAL: after `session.ended` no
 * record is ever ingested for it again, so the prune's key was never revisited
 * and its rows could only be retired while the session was still alive, when
 * every row is younger than the session itself. The prune could therefore only
 * ever fire inside a session that had been alive for more than thirty days.
 *
 * THE HOUSE PATTERN IT CITED DOES NOT HAVE THIS SHAPE. `ingestCommitEvidence`
 * prunes keyed by REPO, which every later session of every teammate revisits —
 * "the next ingest for their repo" is named in that constant's own comment as
 * the bound on the table's growth. Nothing revisits an ended session.
 *
 * SO THE SWEEP RUNS WHERE THE HUB ALREADY SWEEPS: inside `reapStaleSessions`,
 * the one standalone pass the hub starts on a timer. It is not a second job to
 * forget to start, it is not keyed on anything a terminal row cannot revisit,
 * and it runs whether or not that pass finds a session to close.
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

describe("session_events retention is reachable", () => {
  test("an ended session's positions are retired after the window", async () => {
    // Arrange: one session that works and ends. Its rows are the ones D2
    // promised to retire, and nothing will ever write for this session again.
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
    expect(await rowsFor(harness, SESSION)).toBeGreaterThan(0);

    // Act: the hub's own clock moves past the window, and the hub does
    // everything it does afterwards — a later session registers and works,
    // and the reaper pass runs.
    harness.clock.advanceSeconds((SESSION_EVENT_RETENTION_DAYS + 1) * DAY_SECONDS);
    await registerTestSession(harness, dev.apiKey, { id: LATER_SESSION });
    // A second of hub time between the new session's rows and the sweep, so
    // "survives" means survives a sweep that ran AFTER them rather than at the
    // same instant. Without that second a cutoff of zero looks identical to a
    // cutoff of thirty days, and the constant this rule is made of would be
    // unfalsifiable.
    harness.clock.advanceSeconds(1);
    await reapStaleSessions({ db: harness.db, now: harness.clock.now });

    // Assert: the old session's positions are gone and the new session's are
    // untouched — the sweep is bounded by age, not by session.
    expect(await rowsFor(harness, SESSION)).toBe(0);
    expect(await rowsFor(harness, LATER_SESSION)).toBeGreaterThan(0);
  });

  test("the sweep runs even when the pass finds no session to close", async () => {
    // Arrange: `reapStaleSessions` returns early when there is no candidate,
    // and the whole defect this file exists for is a retirement that only
    // happens on a path nothing takes. A sweep behind that early return would
    // be the same bug with a different key.
    const harness = await createTestHarness();
    const dev = await createTestDeveloper(harness, "Nick", "quiet@example.com");
    await registerTestSession(harness, dev.apiKey, { id: SESSION });
    await endSession(
      { db: harness.db, now: harness.clock.now },
      dev.developerId,
      SESSION,
    );
    harness.clock.advanceSeconds((SESSION_EVENT_RETENTION_DAYS + 1) * DAY_SECONDS);

    // Act: a staleness threshold nothing can reach, so the pass finds no
    // candidate and takes its early return.
    const pass = await reapStaleSessions(
      { db: harness.db, now: harness.clock.now },
      { staleHours: 24 * 365 * 100 },
    );

    // Assert
    expect(pass.ended).toHaveLength(0);
    expect(await rowsFor(harness, SESSION)).toBe(0);
  });
});
