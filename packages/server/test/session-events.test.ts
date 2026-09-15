/**
 * THE APPEND-ONLY, CONTENT-FREE POSITION TABLE (spec 01 §3.5).
 *
 * SEQ-10 — DISTINCT KINDS ON ONE REFERENT ARE DISTINCT ROWS. The obvious id
 * for this table is the `hintDeliveryId` shape — sha256 of (session, ref) —
 * for its stated reason: a spool replay re-sends the same primary key and the
 * hub answers `duplicate` instead of writing a second row. ON THIS TABLE THAT
 * PATTERN SILENTLY DELETES EVENTS, because THREE kinds share one referent:
 * `session.started`, `commit.observed` and `session.ended` all point at the
 * session. Under that id the second and third are answered `duplicate` and
 * receive no position at all — the session's order loses its own end.
 *
 * So `kind` and the allocated position are both inside the hash. A replay is
 * still a duplicate, because the connector stamps `seq` once and re-sends the
 * same value.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { sessionEvents } from "../src/db/schema.ts";
import {
  recordSessionEvent,
  sessionEventId,
  targetDigest,
} from "../src/services/session-events.ts";
import {
  createTestDeveloper,
  createTestHarness,
  registerTestSession,
} from "./helpers.ts";

const EPOCH = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

describe("SEQ-10 — one referent, three kinds, three rows", () => {
  test("the id separates events that share a session referent", () => {
    // Arrange / Act
    const started = sessionEventId({
      sessionId: "cc_s1",
      kind: "session.started",
      seqEpoch: EPOCH,
      seqN: 0,
      refKind: "session",
      refId: "cc_s1",
    });
    const observed = sessionEventId({
      sessionId: "cc_s1",
      kind: "commit.observed",
      seqEpoch: EPOCH,
      seqN: 1,
      refKind: "session",
      refId: "cc_s1",
    });
    const ended = sessionEventId({
      sessionId: "cc_s1",
      kind: "session.ended",
      seqEpoch: EPOCH,
      seqN: 2,
      refKind: "session",
      refId: "cc_s1",
    });

    // Assert
    expect(new Set([started, observed, ended]).size).toBe(3);
    for (const id of [started, observed, ended]) {
      expect(id).toMatch(/^se_[0-9a-f]{32}$/);
    }
  });

  test("two UNSEQUENCED kinds on one referent stay two rows", async () => {
    // Arrange: this is where a kind-less hash actually deletes events. A
    // pre-seq connector's session.started and session.ended both point at the
    // session and both carry no position, so the position cannot separate
    // them — only `kind` can. Under the hintDeliveryId shape the end is
    // answered duplicate and the session's history stops at its start, on
    // EVERY session of every connector from before this field.
    const harness = await createTestHarness();
    const dev = await createTestDeveloper(harness, "Seq Dev", "seq3@example.com");
    await registerTestSession(harness, dev.apiKey, { id: "cc_s3" });

    // Act
    for (const kind of ["session.started", "session.ended"] as const) {
      await recordSessionEvent(
        { db: harness.db, now: harness.clock.now },
        {
          sessionId: "cc_s3",
          kind,
          seq: undefined,
          seqKind: "emitted",
          refKind: "session",
          refId: "cc_s3",
        },
      );
    }

    // Assert
    const rows = await harness.db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, "cc_s3"));
    expect(rows.map((row) => row.kind).sort()).toEqual([
      "session.ended",
      "session.started",
    ]);
  });

  test("one kind twice on one referent keeps both of its positions", async () => {
    // Arrange: a SessionStart RE-FIRE collects commit evidence a second time,
    // so `commit.observed` lands twice against the same session referent at
    // two different positions. Without the position inside the hash the second
    // is a duplicate and the re-fire's collection has no place in the order.
    const harness = await createTestHarness();
    const dev = await createTestDeveloper(harness, "Seq Dev", "seq4@example.com");
    await registerTestSession(harness, dev.apiKey, { id: "cc_s4" });

    // Act
    for (const n of [3, 9]) {
      await recordSessionEvent(
        { db: harness.db, now: harness.clock.now },
        {
          sessionId: "cc_s4",
          kind: "commit.observed",
          seq: { epoch: EPOCH, n },
          seqKind: "emitted",
          refKind: "session",
          refId: "cc_s4",
        },
      );
    }

    // Assert
    const rows = await harness.db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, "cc_s4"));
    expect(rows.map((row) => row.seqN).sort((a, b) => Number(a) - Number(b))).toEqual([3, 9]);
  });

  test("a replay of the very same event hashes to the very same id", () => {
    // Arrange: this is the property the id exists for — the connector stamps
    // seq once, so a re-flushed spool line re-sends it and the hub answers
    // duplicate rather than writing a second row.
    const input = {
      sessionId: "cc_s1",
      kind: "file.modified",
      seqEpoch: EPOCH,
      seqN: 4,
      refKind: "target_digest",
      refId: targetDigest("wc_cc_s1", "file", "src/auth/refresh.ts"),
    } as const;

    // Assert
    expect(sessionEventId(input)).toBe(sessionEventId({ ...input }));
  });

  test("the target referent carries no path a renderer could print", () => {
    // Arrange: work_context_targets has no id column and its only identity
    // CONTAINS the file path — author-written text. The referent is a hash.
    const digest = targetDigest("wc_cc_s1", "file", "src/../../etc/passwd");

    // Assert
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain("passwd");
  });

  test("three kinds on one session referent become three stored rows", async () => {
    // Arrange
    const harness = await createTestHarness();
    const dev = await createTestDeveloper(harness, "Seq Dev", "seq@example.com");
    await registerTestSession(harness, dev.apiKey, { id: "cc_s1" });

    // Act
    for (const [index, kind] of (
      ["session.started", "commit.observed", "session.ended"] as const
    ).entries()) {
      await recordSessionEvent(
        { db: harness.db, now: harness.clock.now },
        {
          sessionId: "cc_s1",
          kind,
          seq: { epoch: EPOCH, n: index },
          seqKind: "emitted",
          refKind: "session",
          refId: "cc_s1",
        },
      );
    }

    // Assert
    const rows = await harness.db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, "cc_s1"));
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.seqN).sort()).toEqual([0, 1, 2]);
    expect(new Set(rows.map((row) => row.kind)).size).toBe(3);
    for (const row of rows) {
      expect(row.seqReason).toBe("sequenced");
      expect(row.seqEpoch).toBe(EPOCH);
    }
  });

  test("an unsequenced event is stored with the reason it has no position", async () => {
    // Arrange
    const harness = await createTestHarness();
    const dev = await createTestDeveloper(harness, "Seq Dev", "seq2@example.com");
    await registerTestSession(harness, dev.apiKey, { id: "cc_s2" });

    // Act
    await recordSessionEvent(
      { db: harness.db, now: harness.clock.now },
      {
        sessionId: "cc_s2",
        kind: "claim.created",
        seq: { reason: "allocation_failed" },
        seqKind: "emitted",
        refKind: "claim",
        refId: "cl_1",
      },
    );

    // Assert: never a silent null — the row says WHY it has no position.
    const rows = await harness.db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, "cc_s2"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.seqEpoch).toBeNull();
    expect(rows[0]?.seqN).toBeNull();
    expect(rows[0]?.seqReason).toBe("allocation_failed");
  });
});
