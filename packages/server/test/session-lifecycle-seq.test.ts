/**
 * THE SESSION'S OWN TWO EVENTS, and the route they travel.
 *
 * WHERE SPEC 01 §3.1 IS INCOMPLETE. It says the wire gains exactly one optional
 * field, on the envelope. `session.started` and `session.ended` never travel an
 * envelope: they are `POST /api/sessions` and `POST /api/sessions/:id/end`,
 * whose bodies are STRICT `z.object`s — a `seq` on either would have been
 * rejected outright, so both schemas gain the field too.
 *
 * `n = 0` IS SESSION.STARTED'S, always, and it is a constant rather than an
 * allocation: the state file does not exist yet when the register call runs.
 * Every later allocation starts at 1.
 *
 * A REAPED END CARRIES NO POSITION, and that is printed rather than silent. A
 * reap is the hub's inference from SILENCE — revocable, and over-firing on
 * read-and-plan sessions — so the hub cannot invent a place in a sequence it
 * did not emit.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { sessionEvents } from "../src/db/schema.ts";
import { readSessionCausalOrder } from "../src/services/session-order.ts";
import { reapStaleSessions } from "../src/services/sessions.ts";
import {
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  registerTestSession,
} from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const EPOCH = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const SESSION = "cc_lifecycle";

const eventsOf = async (harness: TestHarness, sessionId: string) =>
  harness.db
    .select()
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, sessionId));

describe("a session's start and end take positions in its own order", () => {
  test("register with seq n=0 stores session.started at position zero", async () => {
    // Arrange
    const harness = await createTestHarness();
    const dev = await createTestDeveloper(harness, "Nick", "life@example.com");

    // Act
    const response = await registerTestSession(harness, dev.apiKey, {
      id: SESSION,
      seq: { epoch: EPOCH, n: 0 },
    });

    // Assert
    expect(response.status).toBe(200);
    const rows = await eventsOf(harness, SESSION);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("session.started");
    expect(rows[0]?.refKind).toBe("session");
    expect(rows[0]?.refId).toBe(SESSION);
    expect(rows[0]?.seqN).toBe(0);
    expect(rows[0]?.seqEpoch).toBe(EPOCH);
  });

  test("a REPORTED end takes the position the connector allocated", async () => {
    // Arrange
    const harness = await createTestHarness();
    const dev = await createTestDeveloper(harness, "Nick", "life2@example.com");
    await registerTestSession(harness, dev.apiKey, {
      id: SESSION,
      seq: { epoch: EPOCH, n: 0 },
    });

    // Act: the connector ALLOCATES at SessionEnd rather than reading the
    // counter it saw earlier — a Stop-time git lane or a detached worker can
    // allocate in the same window, and a read taken before them yields a
    // position that is not last.
    const response = await harness.app.request(
      `/api/sessions/${SESSION}/end`,
      jsonRequest("POST", dev.apiKey, {
        status: "done",
        seq: { epoch: EPOCH, n: 9 },
      }),
    );

    // Assert
    expect(response.status).toBe(200);
    const rows = await eventsOf(harness, SESSION);
    const ended = rows.find((row) => row.kind === "session.ended");
    expect(ended?.seqN).toBe(9);
    expect(ended?.seqReason).toBe("sequenced");
    // ...and the start is still there, at its own position. Both ref the
    // session, so a referent-keyed id would have collapsed them.
    expect(rows.map((row) => row.kind).sort()).toEqual([
      "session.ended",
      "session.started",
    ]);
  });

  test("a REAPED end carries no position, and the reason is on the row", async () => {
    // Arrange: the hub closes a session that stopped heartbeating.
    const harness = await createTestHarness();
    const dev = await createTestDeveloper(harness, "Nick", "life3@example.com");
    await registerTestSession(harness, dev.apiKey, {
      id: SESSION,
      seq: { epoch: EPOCH, n: 0 },
    });
    harness.clock.advanceSeconds(48 * 60 * 60);

    // Act
    const result = await reapStaleSessions(
      { db: harness.db, now: harness.clock.now },
      { developerId: dev.developerId },
    );

    // Assert
    expect(result.ended.map((session) => session.id)).toContain(SESSION);
    const rows = await eventsOf(harness, SESSION);
    const ended = rows.find((row) => row.kind === "session.ended");
    expect(ended).toBeDefined();
    expect(ended?.seqN).toBeNull();
    expect(ended?.seqReason).toBe("reaped_end");
    // The session's order stays USABLE — one event lost its position, not the
    // session. A reap is not evidence that the counter misbehaved.
    const order = await readSessionCausalOrder(harness.db, SESSION);
    expect(order.state).toBe("usable");
  });

  test("a register with no seq is accepted and reported pre_seq_connector", async () => {
    // Arrange: a connector from before this field. The registration is the one
    // thing this route exists to do and must never be refused over a position.
    const harness = await createTestHarness();
    const dev = await createTestDeveloper(harness, "Nick", "life4@example.com");

    // Act
    const response = await registerTestSession(harness, dev.apiKey, {
      id: SESSION,
    });

    // Assert
    expect(response.status).toBe(200);
    const order = await readSessionCausalOrder(harness.db, SESSION);
    expect(order.state).toBe("unsequenced");
    expect(order.reason).toBe("pre_seq_connector");
  });

  test("a malformed seq on the register body is refused, not stored", async () => {
    // Arrange: these bodies are STRICT objects and the epoch is regex-pinned,
    // so a connector cannot smuggle prose into a field a surface prints.
    const harness = await createTestHarness();
    const dev = await createTestDeveloper(harness, "Nick", "life5@example.com");

    // Act
    const response = await registerTestSession(harness, dev.apiKey, {
      id: SESSION,
      seq: { epoch: "../../etc/passwd", n: 0 },
    });

    // Assert
    expect(response.status).toBe(400);
  });
});
