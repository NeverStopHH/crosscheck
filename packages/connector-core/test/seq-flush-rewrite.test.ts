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
 * not B's. The position is dropped instead: absent is honest, wrong is not.
 */
import { describe, expect, test } from "bun:test";

import { withProducer } from "../src/capture/records.ts";

const EPOCH = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

const spooled = (kind: string): Record<string, unknown> => ({
  cx: "0.1",
  id: "env_1",
  ts: "2026-07-24T10:00:00.000Z",
  producer: { developerId: "dev_1", agentKind: "claude-code", sessionId: "cc_a" },
  kind,
  body: {},
  seq: { epoch: EPOCH, n: 5 },
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

  test("a foreign drain drops the position of a body that names none", () => {
    // Act
    const rewritten = withProducer(spooled("commit_evidence"), "dev_1", "cc_b");

    // Assert
    expect(rewritten["seq"]).toBeUndefined();
    expect((rewritten["producer"] as { sessionId: string }).sessionId).toBe("cc_b");
  });
});
