import { describe, expect, test } from "bun:test";

import {
  PROTOCOL_VERSION,
  isCompatibleVersion,
  parseRecord,
} from "../src/index.ts";

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

describe("parseRecord", () => {
  test("parses a claim record end to end", () => {
    // Arrange
    const input = buildRecord({});

    // Act
    const result = parseRecord(input);

    // Assert
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.unknownKind).toBe(false);
      expect(result.envelope.kind).toBe("claim");
    }
  });

  test("accepts an unknown record kind and flags it for forward compatibility", () => {
    // Arrange — a newer producer sends a kind this consumer does not know
    const input = buildRecord({
      kind: "telepathy_report",
      body: { anything: true },
    });

    // Act
    const result = parseRecord(input);

    // Assert
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.unknownKind).toBe(true);
    }
  });

  test("rejects a known kind with an invalid body", () => {
    const input = buildRecord({
      body: { ...VALID_CLAIM_BODY, confidence: 7 },
    });

    const result = parseRecord(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  test("rejects a malformed protocol version", () => {
    const result = parseRecord(buildRecord({ cx: "v1" }));

    expect(result.ok).toBe(false);
  });

  test("tolerates unknown top-level envelope fields", () => {
    const result = parseRecord(buildRecord({ futureEnvelopeField: 42 }));

    expect(result.ok).toBe(true);
  });

  test("rejects non-object input", () => {
    const result = parseRecord("not a record");

    expect(result.ok).toBe(false);
  });
});

describe("isCompatibleVersion", () => {
  test("accepts a newer minor version of the same major", () => {
    expect(isCompatibleVersion("0.9")).toBe(true);
  });

  test("rejects a different major version", () => {
    expect(isCompatibleVersion("1.0")).toBe(false);
  });

  test("rejects a malformed version string", () => {
    expect(isCompatibleVersion("latest")).toBe(false);
  });
});