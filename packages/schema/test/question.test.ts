import { describe, expect, test } from "bun:test";
import {
  MAX_QUESTION_BODY_LENGTH,
  QuestionAnswerSchema,
  QuestionSchema,
  parseRecord,
} from "../src/index.ts";

const ISO = "2026-08-25T09:00:00.000Z";

const question = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: "qn_01",
  repo: "github.com/acme/api",
  authorDeveloperId: "dev_nick",
  authorSessionId: "ses_01",
  targetDeveloperId: "dev_ken",
  body: "Did the rate-limit variant of the importer ever get tried?",
  createdAt: ISO,
  ...overrides,
});

const claim = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: "clm_01",
  workContextId: "wc_01",
  authorSessionId: "ses_02",
  kind: "observation",
  body: "The rate-limit variant was tried and still 429s at 40 rps.",
  status: "proposed",
  confidence: 0.8,
  captureMode: "agent",
  provenance: "declared",
  evidenceRefs: [],
  createdAt: ISO,
  ...overrides,
});

describe("QuestionSchema", () => {
  test("accepts a question addressed to a developer", () => {
    // Arrange / Act
    const parsed = QuestionSchema.safeParse(question());

    // Assert
    expect(parsed.success).toBe(true);
  });

  test("accepts a question addressed to a work context alone", () => {
    // Arrange
    const contextOnly = question({
      targetDeveloperId: undefined,
      workContextId: "wc_01",
    });

    // Act
    const parsed = QuestionSchema.safeParse(contextOnly);

    // Assert
    expect(parsed.success).toBe(true);
  });

  test("refuses a question with no addressee at all — no broadcast", () => {
    // Arrange: the SAME body that parses above, minus both addressees, so the
    // failure can only be the addressee rule.
    const broadcast = question({
      targetDeveloperId: undefined,
      workContextId: undefined,
    });

    // Act
    const parsed = QuestionSchema.safeParse(broadcast);

    // Assert
    expect(parsed.success).toBe(false);
    expect(
      parsed.success ? [] : parsed.error.issues.map((issue) => issue.message),
    ).toContain(
      "a question needs an addressee: give targetDeveloperId, workContextId, or both",
    );
  });

  test("refuses a body over the cap and accepts one at it", () => {
    // Arrange
    const atCap = question({ body: "x".repeat(MAX_QUESTION_BODY_LENGTH) });
    const overCap = question({ body: "x".repeat(MAX_QUESTION_BODY_LENGTH + 1) });

    // Act / Assert
    expect(QuestionSchema.safeParse(atCap).success).toBe(true);
    expect(QuestionSchema.safeParse(overCap).success).toBe(false);
  });
});

describe("QuestionAnswerSchema", () => {
  test("carries a canonical claim, so every claim rule still applies", () => {
    // Arrange: a claim that is well-formed EXCEPT for the one rule
    // @crosscheck/schema enforces on every claim — likely_root_cause with no
    // evidence. If the answer shape re-typed the claim instead of nesting the
    // canonical one, this would parse.
    const wellFormed = { questionId: "qn_01", claim: claim() };
    const unevidenced = {
      questionId: "qn_01",
      claim: claim({ status: "likely_root_cause" }),
    };

    // Act / Assert
    expect(QuestionAnswerSchema.safeParse(wellFormed).success).toBe(true);
    expect(QuestionAnswerSchema.safeParse(unevidenced).success).toBe(false);
  });
});

describe("the wire envelope", () => {
  const envelope = (kind: string, body: unknown): Record<string, unknown> => ({
    cx: "0.1",
    id: "env_01",
    ts: ISO,
    producer: {
      developerId: "dev_nick",
      agentKind: "claude-code",
      sessionId: "ses_01",
    },
    kind,
    body,
  });

  test("knows the question kind rather than ignoring it as unknown", () => {
    // Act
    const parsed = parseRecord(envelope("question", question()));

    // Assert: `unknownKind` is the difference that matters — an unknown kind
    // parses too, and is silently IGNORED at ingest (forward compatibility).
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.unknownKind : true).toBe(false);
  });

  test("knows the question_answer kind rather than ignoring it as unknown", () => {
    // Act
    const parsed = parseRecord(
      envelope("question_answer", { questionId: "qn_01", claim: claim() }),
    );

    // Assert
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.unknownKind : true).toBe(false);
  });

  test("rejects a malformed question body instead of ignoring it", () => {
    // Arrange: a known kind with a body the schema refuses is an ERROR, not a
    // silent pass — that separation is what makes the kind known at all.
    const broadcast = question({
      targetDeveloperId: undefined,
      workContextId: undefined,
    });

    // Act
    const parsed = parseRecord(envelope("question", broadcast));

    // Assert
    expect(parsed.ok).toBe(false);
  });
});
