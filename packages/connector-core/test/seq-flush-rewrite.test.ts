/**
 * A POSITION MUST NOT SURVIVE A REWRITE IT CANNOT BE FILED UNDER.
 *
 * `flushOneBatch` stamps every record with the FLUSHING session — ingest
 * rejects records whose producer session has ended, so a dead session's
 * backlog is only deliverable in a live session's name. The hub files a
 * position under the session named in the record's BODY, which works for
 * claims, edges, work contexts and (through a join) targets.
 *
 * `commit_evidence` has no session in its body and no join that reaches one,
 * so the hub can only use the producer — which by then is the flusher. Keeping
 * the position there would splice session A's epoch into session B's sequence
 * and leave B's whole causal order `broken / epoch_split` for a reason that is
 * not B's. The position is withheld instead: wrong is not honest.
 *
 * BUT WITHHELD IS NOT ABSENT. Deleting the field outright made the hub read
 * `pre_seq_connector` — "a connector from before this protocol field" — about
 * a CURRENT connector whose position was withheld on purpose. That is the one
 * confound the wire enum's own header forbids, and it was being produced by
 * the code the header sits above.
 */
import { describe, expect, test } from "bun:test";

import { withProducer } from "../src/capture/records.ts";

const EPOCH = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

/** `null` means the envelope carries no `seq` field at all. */
const spooled = (
  kind: string,
  seq: unknown = { epoch: EPOCH, n: 5 },
): Record<string, unknown> => ({
  cx: "0.1",
  id: "env_1",
  ts: "2026-07-24T10:00:00.000Z",
  producer: { developerId: "dev_1", agentKind: "claude-code", sessionId: "cc_a" },
  kind,
  body: {},
  ...(seq === null ? {} : { seq }),
});

describe("withProducer and the position", () => {
  test("a drain by the writing session keeps every position", () => {
    // Act
    const rewritten = withProducer(spooled("commit_evidence"), "dev_1", "cc_a");

    // Assert
    expect(rewritten["seq"]).toEqual({ epoch: EPOCH, n: 5 });
  });

  test("a foreign drain keeps the position of a body that names its session", () => {
    // Arrange: a claim carries `authorSessionId`, so the hub files it under A
    // however it arrived. Dropping the position here would lose real order for
    // every offline backlog a successor session delivers.
    for (const kind of ["claim", "claim_edge", "work_context", "target"]) {
      // Act
      const rewritten = withProducer(spooled(kind), "dev_1", "cc_b");

      // Assert
      expect(rewritten["seq"], kind).toEqual({ epoch: EPOCH, n: 5 });
    }
  });

  test("a foreign drain withholds the position of a body that names none", () => {
    // Act
    const rewritten = withProducer(spooled("commit_evidence"), "dev_1", "cc_b");

    // Assert: a REFUSAL, not a deleted field. An absent `seq` is the hub's
    // word for a connector too old to have the field at all, and saying that
    // about a current connector whose position was withheld on purpose is the
    // confound the enum's own header exists to forbid.
    expect(rewritten["seq"]).toEqual({ reason: "foreign_session_delivery" });
    expect((rewritten["producer"] as { sessionId: string }).sessionId).toBe("cc_b");
  });

  test("a spool with no position at all still reports no position", () => {
    // Arrange: a connector from before the field, drained by a successor. The
    // opposite confound, and just as wrong: stamping the foreign-delivery
    // refusal here would claim a position existed and could not survive.
    const rewritten = withProducer(
      spooled("commit_evidence", null),
      "dev_1",
      "cc_b",
    );

    // Assert
    expect(rewritten["seq"]).toBeUndefined();
  });

  test("a foreign drain keeps a refusal the emitter already made", () => {
    // Arrange: the emitter never had a position to lose — an ambiguous MCP
    // session, say. Its reason is the true one and names a remedy; overwriting
    // it with the delivery reason would hide a machine that needs attention.
    const rewritten = withProducer(
      spooled("commit_evidence", { reason: "ambiguous_session_assignment" }),
      "dev_1",
      "cc_b",
    );

    // Assert
    expect(rewritten["seq"]).toEqual({
      reason: "ambiguous_session_assignment",
    });
  });
});
