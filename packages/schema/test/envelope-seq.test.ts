/**
 * THE POSITION ON THE WIRE (spec 01 §3.1).
 *
 * THE RED-FIRST TRAP THIS FILE WALKS AROUND. `EnvelopeSchema` is a
 * `z.looseObject`, so an assertion that a well-formed `seq` survives the parse
 * PASSES against the unbuilt code and proves nothing — the loose object keeps
 * any unknown key untouched. The only assertion that can go red is that a
 * MALFORMED stamp is REFUSED: today's loose object accepts `epoch: "nope"` and
 * `n: -1` happily, and a typed field rejects them.
 */
import { describe, expect, test } from "bun:test";

import { PROTOCOL_VERSION, parseRecord } from "../src/index.ts";

const VALID_CLAIM_BODY = {
  id: "cl_1",
  workContextId: "wc_1",
  authorSessionId: "ses_1",
  kind: "hypothesis",
  body: "task claim is not idempotent",
  status: "proposed",
  confidence: 0.4,
  captureMode: "agent",
  provenance: "declared",
  evidenceRefs: [],
  createdAt: "2026-07-24T10:00:00.000Z",
} as const;

const EPOCH = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

const buildRecord = (overrides: Record<string, unknown>) => ({
  cx: PROTOCOL_VERSION,
  id: "rec_1",
  ts: "2026-07-24T10:00:01.000Z",
  producer: {
    developerId: "dev_1",
    agentKind: "claude-code",
    sessionId: "ses_1",
  },
  kind: "claim",
  body: VALID_CLAIM_BODY,
  ...overrides,
});

describe("the envelope carries a position", () => {
  test("refuses a stamp whose epoch is not an opaque uuid", () => {
    // Arrange: `epoch` is regex-pinned BECAUSE a connector is untrusted — an
    // opaque id cannot carry prose into a surface (§3.1). A free string here
    // would be a new untrusted slot on every consumer.
    const input = buildRecord({ seq: { epoch: "../../etc/passwd", n: 3 } });

    // Act
    const result = parseRecord(input);

    // Assert
    expect(result.ok).toBe(false);
  });

  test("refuses a negative position", () => {
    // Arrange
    const input = buildRecord({ seq: { epoch: EPOCH, n: -1 } });

    // Act
    const result = parseRecord(input);

    // Assert
    expect(result.ok).toBe(false);
  });

  test("refuses a fractional position", () => {
    // Arrange: n counts allocations. A fraction is a second producer's idea of
    // "between", which is exactly the tie-break a monotonic counter forbids.
    const input = buildRecord({ seq: { epoch: EPOCH, n: 1.5 } });

    // Act
    const result = parseRecord(input);

    // Assert
    expect(result.ok).toBe(false);
  });

  test("refuses a stamp missing its epoch", () => {
    // Arrange: a bare n compares two positions across epochs and answers
    // confidently where SEQ-5 requires a refusal.
    const input = buildRecord({ seq: { n: 3 } });

    // Act
    const result = parseRecord(input);

    // Assert
    expect(result.ok).toBe(false);
  });

  test("refuses a refusal reason this protocol does not define", () => {
    // Arrange: the reason is an ENUM from our own source, never prose — the
    // same discipline CAUSAL_ORDER_REASONS follows on the hub.
    const input = buildRecord({ seq: { reason: "felt wrong" } });

    // Act
    const result = parseRecord(input);

    // Assert
    expect(result.ok).toBe(false);
  });

  test("accepts a well-formed stamp and hands it back", () => {
    // Arrange
    const input = buildRecord({ seq: { epoch: EPOCH, n: 0 } });

    // Act
    const result = parseRecord(input);

    // Assert
    expect(result.ok).toBe(true);
    expect(result.ok ? result.envelope.seq : null).toEqual({
      epoch: EPOCH,
      n: 0,
    });
  });

  test("accepts the allocation refusal D1 emits instead of a guess", () => {
    // Arrange: an MCP call whose session is ambiguous emits the record and
    // withholds only its POSITION (§10 D1). The reason has to travel, or the
    // hub cannot tell it from a pre-seq connector.
    const input = buildRecord({ seq: { reason: "allocation_failed" } });

    // Act
    const result = parseRecord(input);

    // Assert
    expect(result.ok).toBe(true);
    expect(result.ok ? result.envelope.seq : null).toEqual({
      reason: "allocation_failed",
    });
  });

  test("an envelope with no seq stays legal forever", () => {
    // Arrange: the forward-compatibility contract (envelope.ts header) and how
    // a pre-seq connector keeps working (§4).
    const input = buildRecord({});

    // Act
    const result = parseRecord(input);

    // Assert
    expect(result.ok).toBe(true);
    expect(result.ok ? result.envelope.seq : "absent").toBeUndefined();
  });
});
