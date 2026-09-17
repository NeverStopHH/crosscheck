/**
 * SEQ-6 — A RETAKEN POSITION LOSES THE POSITION, NEVER THE RECORD.
 *
 * A write whose `(session, epoch, n)` is already held by a DIFFERENT event is
 * a restarted counter, a second home sharing one host session id, or a broken
 * connector. It is neither a duplicate nor a rejection.
 *
 * REJECTING WOULD DESTROY THE RECORD. A connector's flush advances its cursor
 * on any 2xx (`services/records.ts`, the B2-01/B2-07 finding), so a rejected
 * batch is a DELIVERED batch as far as the spool is concerned and the work is
 * gone. The row is stored with a null position, the conflict is counted on the
 * row itself, and the session's epoch is marked broken for every consumer that
 * later asks whether two of its events may be compared.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { sessionEvents } from "../src/db/schema.ts";
import { recordSessionEvent } from "../src/services/session-events.ts";
import {
  createTestDeveloper,
  createTestHarness,
  registerTestSession,
} from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const EPOCH = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const SESSION = "cc_conflict";

const harnessWithSession = async (email: string): Promise<TestHarness> => {
  const harness = await createTestHarness();
  const dev = await createTestDeveloper(harness, "Nick", email);
  await registerTestSession(harness, dev.apiKey, { id: SESSION });
  return harness;
};

/**
 * Registering a session emits `session.started`, so every one of these
 * fixtures already holds one row before the first claim arrives. This file is
 * about what happens to a CLAIM's position, so that row is read past.
 */
const claimEventsOf = async (harness: TestHarness) =>
  (
    await harness.db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, SESSION))
  ).filter((row) => row.kind !== "session.started");

describe("SEQ-6 — a taken position is a third outcome", () => {
  test("a different event at a taken position keeps its row and loses its position", async () => {
    // Arrange
    const harness = await harnessWithSession("conflict@example.com");
    const deps = { db: harness.db, now: harness.clock.now };
    const first = await recordSessionEvent(deps, {
      sessionId: SESSION,
      kind: "claim.created",
      seq: { epoch: EPOCH, n: 4 },
      seqKind: "emitted",
      refKind: "claim",
      refId: "clm_first",
    });

    // Act: the SAME position, a DIFFERENT referent.
    const second = await recordSessionEvent(deps, {
      sessionId: SESSION,
      kind: "claim.created",
      seq: { epoch: EPOCH, n: 4 },
      seqKind: "emitted",
      refKind: "claim",
      refId: "clm_second",
    });

    // Assert
    expect(first.positioned).toBe(true);
    expect(second.positioned).toBe(false);
    const rows = await claimEventsOf(harness);
    expect(rows).toHaveLength(2);
    const conflicted = rows.find((row) => row.refId === "clm_second");
    expect(conflicted?.seqN).toBeNull();
    expect(conflicted?.seqEpoch).toBeNull();
    expect(conflicted?.seqReason).toBe("epoch_conflict");
    // And the first event kept the position it took.
    expect(rows.find((row) => row.refId === "clm_first")?.seqN).toBe(4);
  });

  test("an honest replay of the same event is one row, still positioned", async () => {
    // Arrange: the connector stamps `seq` once, so a re-flushed spool line
    // re-sends the same value against the same referent. That is a DUPLICATE,
    // not a conflict — telling them apart is the whole reason the id carries
    // the position.
    const harness = await harnessWithSession("replay@example.com");
    const deps = { db: harness.db, now: harness.clock.now };
    const input = {
      sessionId: SESSION,
      kind: "claim.created",
      seq: { epoch: EPOCH, n: 4 },
      seqKind: "emitted",
      refKind: "claim",
      refId: "clm_same",
    } as const;

    // Act
    const first = await recordSessionEvent(deps, input);
    const second = await recordSessionEvent(deps, input);

    // Assert
    expect(second.id).toBe(first.id);
    expect(second.positioned).toBe(true);
    const rows = await claimEventsOf(harness);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.seqReason).toBe("sequenced");
  });

  test("two UNSEQUENCED rows do not collide with each other", async () => {
    // Arrange: the index is PARTIAL for exactly this. A session behind a
    // pre-seq connector emits many rows with a null position, and a total
    // unique index would reject every one after the first — turning an
    // instrumentation gap into data loss.
    const harness = await harnessWithSession("unseq@example.com");
    const deps = { db: harness.db, now: harness.clock.now };

    // Act
    for (const refId of ["clm_a", "clm_b", "clm_c"]) {
      await recordSessionEvent(deps, {
        sessionId: SESSION,
        kind: "claim.created",
        seq: undefined,
        seqKind: "emitted",
        refKind: "claim",
        refId,
      });
    }

    // Assert
    const rows = await claimEventsOf(harness);
    expect(rows).toHaveLength(3);
  });
});
