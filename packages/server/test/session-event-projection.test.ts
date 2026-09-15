/**
 * THE POSITION REACHES THE ROW IT BELONGS TO (spec 01 §3.5, §3.6).
 *
 * THE SILENT-CORRUPTION PATH THIS FILE EXISTS FOR. `spool/flush.ts` stamps
 * every record with the FLUSHING session, not the one that wrote it — ingest
 * rejects records from an ended producer, so a dead session's backlog is only
 * deliverable in a live session's name. If the event's session were taken from
 * `producer.sessionId`, session A's positions would land inside session B's
 * sequence, B would hold two epochs, and B's whole causal order would read
 * `broken / epoch_split` for a reason that is not B's.
 *
 * So the session comes from the BODY: `claim.authorSessionId`,
 * `claim_edge.authorSessionId`, and for a target — whose body carries no
 * session at all — a join through `work_contexts`.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { sessionEvents } from "../src/db/schema.ts";
import { targetDigest } from "../src/services/session-events.ts";
import {
  PLACEHOLDER_DEVELOPER_ID,
  WORK_CONTEXT_ID,
  createTestDeveloper,
  createTestHarness,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validClaimBody,
  validWorkContextBody,
} from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const EPOCH_A = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const AUTHOR = "cc_author";
const FLUSHER = "cc_flusher";

const withSeq = (
  envelope: Record<string, unknown>,
  n: number,
  epoch: string = EPOCH_A,
): Record<string, unknown> => ({ ...envelope, seq: { epoch, n } });

const eventsOf = async (harness: TestHarness, sessionId: string) =>
  harness.db
    .select()
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, sessionId));

describe("a position is filed under the session that took it", () => {
  test("a spool written by A and flushed by B files A's position under A", async () => {
    // Arrange: two sessions of one developer. A is the author; B is the live
    // session doing the flush, so every envelope arrives with producer B.
    const harness = await createTestHarness();
    const dev = await createTestDeveloper(harness, "Nick", "proj@example.com");
    await registerTestSession(harness, dev.apiKey, { id: AUTHOR });
    await registerTestSession(harness, dev.apiKey, { id: FLUSHER });
    await postRecords(harness, dev, {
      records: [
        recordEnvelope(
          "work_context",
          validWorkContextBody({ sessionId: AUTHOR }),
          { sessionId: FLUSHER, developerId: PLACEHOLDER_DEVELOPER_ID },
        ),
      ],
    });

    // Act
    const posted = await postRecords(harness, dev, {
      records: [
        withSeq(
          recordEnvelope(
            "claim",
            validClaimBody({ id: "clm_a", authorSessionId: AUTHOR }),
            { sessionId: FLUSHER, developerId: PLACEHOLDER_DEVELOPER_ID },
          ),
          7,
        ),
      ],
    });

    // Assert
    expect(posted.data?.accepted).toBe(1);
    expect(await eventsOf(harness, FLUSHER)).toHaveLength(0);
    const rows = await eventsOf(harness, AUTHOR);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("claim.created");
    expect(rows[0]?.refKind).toBe("claim");
    expect(rows[0]?.refId).toBe("clm_a");
    expect(rows[0]?.seqEpoch).toBe(EPOCH_A);
    expect(rows[0]?.seqN).toBe(7);
  });

  test("a target's session comes from its work context, not from the flusher", async () => {
    // Arrange: `target` bodies carry only a workContextId — there is no
    // session in them at all, so the join is the only honest source.
    const harness = await createTestHarness();
    const dev = await createTestDeveloper(harness, "Nick", "proj2@example.com");
    await registerTestSession(harness, dev.apiKey, { id: AUTHOR });
    await registerTestSession(harness, dev.apiKey, { id: FLUSHER });
    await postRecords(harness, dev, {
      records: [
        recordEnvelope(
          "work_context",
          validWorkContextBody({ sessionId: AUTHOR }),
          { sessionId: FLUSHER },
        ),
      ],
    });

    // Act
    await postRecords(harness, dev, {
      records: [
        withSeq(
          recordEnvelope(
            "target",
            {
              workContextId: WORK_CONTEXT_ID,
              kind: "file",
              value: "src/auth/refresh.ts",
              source: "tool_edit",
            },
            { sessionId: FLUSHER },
          ),
          4,
        ),
      ],
    });

    // Assert
    const rows = await eventsOf(harness, AUTHOR);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("file.modified");
    expect(rows[0]?.refKind).toBe("target_digest");
    expect(rows[0]?.refId).toBe(
      targetDigest(WORK_CONTEXT_ID, "file", "src/auth/refresh.ts"),
    );
    expect(rows[0]?.seqN).toBe(4);
  });

  test("a failure fingerprint projects as tool.failed", async () => {
    // Arrange
    const harness = await createTestHarness();
    const dev = await createTestDeveloper(harness, "Nick", "proj3@example.com");
    await registerTestSession(harness, dev.apiKey, { id: AUTHOR });
    await postRecords(harness, dev, {
      records: [
        recordEnvelope(
          "work_context",
          validWorkContextBody({ sessionId: AUTHOR }),
          { sessionId: AUTHOR },
        ),
      ],
    });

    // Act
    await postRecords(harness, dev, {
      records: [
        withSeq(
          recordEnvelope(
            "target",
            {
              workContextId: WORK_CONTEXT_ID,
              kind: "error_fingerprint",
              value: "TypeError: x is not a function",
              source: "tool_edit",
            },
            { sessionId: AUTHOR },
          ),
          2,
        ),
      ],
    });

    // Assert
    const rows = await eventsOf(harness, AUTHOR);
    expect(rows.map((row) => row.kind)).toEqual(["tool.failed"]);
  });

  test("SEQ-8 — an envelope with no seq is accepted, projected and given a reason", async () => {
    // Arrange: a connector from before this protocol field. Rejecting would
    // be a version-skew outage; a silent null would be an absence nobody can
    // explain. Accepted, projected, and the reason is on the row.
    const harness = await createTestHarness();
    const dev = await createTestDeveloper(harness, "Nick", "proj4@example.com");
    await registerTestSession(harness, dev.apiKey, { id: AUTHOR });
    await postRecords(harness, dev, {
      records: [
        recordEnvelope(
          "work_context",
          validWorkContextBody({ sessionId: AUTHOR }),
          { sessionId: AUTHOR },
        ),
      ],
    });

    // Act
    const posted = await postRecords(harness, dev, {
      records: [
        recordEnvelope(
          "claim",
          validClaimBody({ id: "clm_pre", authorSessionId: AUTHOR }),
          { sessionId: AUTHOR },
        ),
      ],
    });

    // Assert
    expect(posted.data?.accepted).toBe(1);
    const rows = await eventsOf(harness, AUTHOR);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.seqN).toBeNull();
    expect(rows[0]?.seqReason).toBe("pre_seq_connector");
  });

  test("an allocation refusal is told apart from a connector that never tried", async () => {
    // Arrange
    const harness = await createTestHarness();
    const dev = await createTestDeveloper(harness, "Nick", "proj5@example.com");
    await registerTestSession(harness, dev.apiKey, { id: AUTHOR });
    await postRecords(harness, dev, {
      records: [
        recordEnvelope(
          "work_context",
          validWorkContextBody({ sessionId: AUTHOR }),
          { sessionId: AUTHOR },
        ),
      ],
    });

    // Act
    await postRecords(harness, dev, {
      records: [
        {
          ...recordEnvelope(
            "claim",
            validClaimBody({ id: "clm_ref", authorSessionId: AUTHOR }),
            { sessionId: AUTHOR },
          ),
          seq: { reason: "allocation_failed" },
        },
      ],
    });

    // Assert
    const rows = await eventsOf(harness, AUTHOR);
    expect(rows[0]?.seqReason).toBe("allocation_failed");
  });

  test("an invalidating edge projects; a supporting one does not", async () => {
    // Arrange: `claim.invalidated` is the edge KIND's event, not every edge's
    // — a `supports` or `relates_to` edge invalidates nothing and inventing an
    // event for it would put a name in the vocabulary that means nothing.
    const harness = await createTestHarness();
    const dev = await createTestDeveloper(harness, "Nick", "proj6@example.com");
    await registerTestSession(harness, dev.apiKey, { id: AUTHOR });
    await postRecords(harness, dev, {
      records: [
        recordEnvelope(
          "work_context",
          validWorkContextBody({ sessionId: AUTHOR }),
          { sessionId: AUTHOR },
        ),
        recordEnvelope(
          "claim",
          validClaimBody({ id: "clm_1", authorSessionId: AUTHOR }),
          { sessionId: AUTHOR },
        ),
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_2",
            authorSessionId: AUTHOR,
            body: "a different finding entirely",
          }),
          { sessionId: AUTHOR },
        ),
      ],
    });

    // Act
    await postRecords(harness, dev, {
      records: [
        withSeq(
          recordEnvelope(
            "claim_edge",
            {
              id: "ce_bad",
              fromClaimId: "clm_1",
              toClaimId: "clm_2",
              kind: "contradicts",
              authorSessionId: AUTHOR,
              createdAt: "2026-07-24T09:00:00.000Z",
            },
            { sessionId: AUTHOR },
          ),
          11,
        ),
        withSeq(
          recordEnvelope(
            "claim_edge",
            {
              id: "ce_ok",
              fromClaimId: "clm_2",
              toClaimId: "clm_1",
              kind: "supports",
              authorSessionId: AUTHOR,
              createdAt: "2026-07-24T09:00:00.000Z",
            },
            { sessionId: AUTHOR },
          ),
          12,
        ),
      ],
    });

    // Assert
    const rows = await eventsOf(harness, AUTHOR);
    const invalidations = rows.filter((row) => row.kind === "claim.invalidated");
    expect(invalidations).toHaveLength(1);
    expect(invalidations[0]?.refId).toBe("ce_bad");
    expect(invalidations[0]?.seqN).toBe(11);
  });
});
