import { describe, expect, test } from "bun:test";

import {
  AgentSessionSchema,
  DERIVED_CONFIDENCE_CAP,
  HintSchema,
  IntentSchema,
  MAX_HINT_TEXT_LENGTH,
  MAX_INTENT_SUMMARY_CHARS,
  SESSION_STATUSES,
  TARGET_KINDS,
  TargetSchema,
  WorkContextSchema,
} from "../src/index.ts";

const VALID_SESSION = {
  id: "ses_1",
  developerId: "dev_1",
  agentKind: "claude-code",
  repo: "github.com/acme/api",
  branch: "feat/entity-mapping",
  baseCommit: "a1b2c3d4",
  status: "analyzing",
  startedAt: "2026-07-24T09:00:00.000Z",
} as const;

describe("AgentSessionSchema", () => {
  test("parses a valid session", () => {
    const result = AgentSessionSchema.safeParse(VALID_SESSION);

    expect(result.success).toBe(true);
  });

  test("rejects an unknown session status", () => {
    const result = AgentSessionSchema.safeParse({
      ...VALID_SESSION,
      status: "procrastinating",
    });

    expect(result.success).toBe(false);
  });

  test("accepts optional heartbeat and end timestamps", () => {
    const result = AgentSessionSchema.safeParse({
      ...VALID_SESSION,
      lastHeartbeatAt: "2026-07-24T09:05:00.000Z",
      endedAt: "2026-07-24T09:30:00.000Z",
    });

    expect(result.success).toBe(true);
  });

  test("session statuses match DESIGN.md §5", () => {
    expect(SESSION_STATUSES).toEqual([
      "analyzing",
      "planning",
      "implementing",
      "testing",
      "blocked",
      "done",
    ]);
  });
});

const VALID_INTENT = {
  summary: "Make the TM extraction task claim idempotent on staging",
  provenance: "declared",
  confidence: 1,
  capturedAt: "2026-07-24T09:02:00.000Z",
} as const;

describe("WorkContextSchema", () => {
  test("parses a work context with a typed intent", () => {
    // Arrange
    const input = {
      id: "wc_1",
      sessionId: "ses_1",
      title: "Duplicate TM extractions on staging",
      status: "analyzing",
      intent: VALID_INTENT,
      createdAt: "2026-07-24T09:01:00.000Z",
    };

    // Act
    const result = WorkContextSchema.safeParse(input);

    // Assert
    expect(result.success).toBe(true);
  });

  test("parses a work context without an intent — every pre-intent record", () => {
    const result = WorkContextSchema.safeParse({
      id: "wc_1",
      sessionId: "ses_1",
      title: "Duplicate TM extractions on staging",
      status: "analyzing",
      createdAt: "2026-07-24T09:01:00.000Z",
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.intent).toBeUndefined();
  });

  test("rejects a work context whose intent is malformed", () => {
    const result = WorkContextSchema.safeParse({
      id: "wc_1",
      sessionId: "ses_1",
      title: "Duplicate TM extractions on staging",
      status: "analyzing",
      intent: { plannedChanges: ["not the typed shape"] },
      createdAt: "2026-07-24T09:01:00.000Z",
    });

    expect(result.success).toBe(false);
  });

  test("rejects a work context without a title", () => {
    const result = WorkContextSchema.safeParse({
      id: "wc_1",
      sessionId: "ses_1",
      title: "",
      status: "analyzing",
      createdAt: "2026-07-24T09:01:00.000Z",
    });

    expect(result.success).toBe(false);
  });
});

describe("TargetSchema", () => {
  test("parses a file target", () => {
    const result = TargetSchema.safeParse({
      workContextId: "wc_1",
      kind: "file",
      value: "src/worker.ts",
    });

    expect(result.success).toBe(true);
  });

  test("rejects an unknown target kind", () => {
    const result = TargetSchema.safeParse({
      workContextId: "wc_1",
      kind: "vibe",
      value: "something",
    });

    expect(result.success).toBe(false);
  });

  test("target kinds match DESIGN.md §5", () => {
    expect(TARGET_KINDS).toEqual([
      "file",
      "symbol",
      "component",
      "error_fingerprint",
    ]);
  });
});

describe("HintSchema", () => {
  const VALID_HINT = {
    id: "hint_1",
    receiverSessionId: "ses_2",
    refKind: "claim",
    refId: "cl_1",
    renderedText:
      "Robin's session (2h ago) rejected the caching hypothesis; see evidence cl_9.",
    trust: {
      authorName: "Robin",
      ageSeconds: 7200,
      status: "rejected",
      confidence: 0.9,
      provenance: "declared",
      commitsBehindHead: 14,
    },
    deliveredAt: "2026-07-24T11:00:00.000Z",
  } as const;

  test("parses a valid hint with full trust labels", () => {
    const result = HintSchema.safeParse(VALID_HINT);

    expect(result.success).toBe(true);
  });

  test("rejects rendered text above the injection cap", () => {
    const result = HintSchema.safeParse({
      ...VALID_HINT,
      renderedText: "x".repeat(MAX_HINT_TEXT_LENGTH + 1),
    });

    expect(result.success).toBe(false);
  });

  test("rejects a hint without trust labels", () => {
    const { trust: _omitted, ...withoutTrust } = VALID_HINT;

    const result = HintSchema.safeParse(withoutTrust);

    expect(result.success).toBe(false);
  });
});
describe("IntentSchema", () => {
  test("a declared intent may assert full confidence", () => {
    expect(IntentSchema.safeParse(VALID_INTENT).success).toBe(true);
  });

  test(`a derived intent above the ${String(DERIVED_CONFIDENCE_CAP)} cap is rejected — machine inference never outranks a person`, () => {
    const result = IntentSchema.safeParse({
      ...VALID_INTENT,
      provenance: "derived",
      confidence: DERIVED_CONFIDENCE_CAP + 0.01,
    });

    expect(result.success).toBe(false);
    expect(
      !result.success && result.error.issues.some((issue) => issue.path[0] === "confidence"),
    ).toBe(true);
  });

  test("a derived intent at or under the cap is accepted", () => {
    expect(
      IntentSchema.safeParse({ ...VALID_INTENT, provenance: "derived", confidence: 0.4 }).success,
    ).toBe(true);
    expect(
      IntentSchema.safeParse({
        ...VALID_INTENT,
        provenance: "derived",
        confidence: DERIVED_CONFIDENCE_CAP,
      }).success,
    ).toBe(true);
  });

  test(`a summary longer than ${String(MAX_INTENT_SUMMARY_CHARS)} characters is rejected, an empty one too`, () => {
    expect(
      IntentSchema.safeParse({ ...VALID_INTENT, summary: "x".repeat(MAX_INTENT_SUMMARY_CHARS + 1) })
        .success,
    ).toBe(false);
    expect(IntentSchema.safeParse({ ...VALID_INTENT, summary: "" }).success).toBe(false);
    expect(
      IntentSchema.safeParse({ ...VALID_INTENT, summary: "x".repeat(MAX_INTENT_SUMMARY_CHARS) })
        .success,
    ).toBe(true);
  });

  test("provenance is the shared enum and capturedAt an ISO datetime", () => {
    expect(IntentSchema.safeParse({ ...VALID_INTENT, provenance: "guessed" }).success).toBe(false);
    expect(IntentSchema.safeParse({ ...VALID_INTENT, capturedAt: "yesterday" }).success).toBe(false);
  });
});
