import { describe, expect, test } from "bun:test";

import { KNOWN_RECORD_KINDS, PROTOCOL_VERSION, parseRecord } from "../src/index.ts";

const PRODUCER = {
  developerId: "dev_1",
  agentKind: "claude-code",
  sessionId: "cc_reader",
} as const;

const envelope = (body: unknown): Record<string, unknown> => ({
  cx: PROTOCOL_VERSION,
  id: "env_1",
  ts: "2026-08-10T09:00:00.000Z",
  producer: PRODUCER,
  kind: "hint_delivery",
  body,
});

const VALID_BODY = {
  id: "hd_0123456789abcdef0123456789abcdef",
  sessionId: "cc_reader",
  refKind: "claim",
  refId: "clm_1",
  deliveredAt: "2026-08-10T09:00:00.000Z",
} as const;

describe("hint_delivery record kind", () => {
  test("is a known record kind, not forward-compat noise", () => {
    // Arrange & Act
    const result = parseRecord(envelope(VALID_BODY));

    // Assert — an unknown kind would parse with unknownKind: true and an
    // untouched body; a telemetry record the hub silently ignores is the
    // failure mode hint_deliveries exists to prevent.
    expect(KNOWN_RECORD_KINDS).toContain("hint_delivery");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.unknownKind).toBe(false);
    }
  });

  test("accepts a work_context ref", () => {
    const result = parseRecord(
      envelope({ ...VALID_BODY, refKind: "work_context", refId: "wc_cc_x" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.unknownKind).toBe(false);
    }
  });

  test("rejects a refKind outside claim/work_context", () => {
    const result = parseRecord(envelope({ ...VALID_BODY, refKind: "artifact" }));
    expect(result.ok).toBe(false);
  });

  test("rejects a body missing the receiving session", () => {
    const { sessionId: _dropped, ...withoutSession } = VALID_BODY;
    const result = parseRecord(envelope(withoutSession));
    expect(result.ok).toBe(false);
  });
});
