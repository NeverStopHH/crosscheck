import { describe, expect, test } from "bun:test";

import {
  CLAIM_KINDS,
  CLAIM_STATUSES,
  ClaimEdgeSchema,
  ClaimSchema,
  DERIVED_CONFIDENCE_CAP,
  EDGE_KINDS,
  MAX_CLAIM_BODY_LENGTH,
} from "../src/index.ts";

const VALID_CLAIM = {
  id: "cl_1",
  workContextId: "wc_1",
  authorSessionId: "ses_1",
  kind: "hypothesis",
  body: "v2 rollup denominator drops presence rows",
  status: "proposed",
  confidence: 0.5,
  captureMode: "agent",
  provenance: "declared",
  evidenceRefs: [],
  createdAt: "2026-07-24T10:00:00.000Z",
} as const;

const buildClaim = (overrides: Record<string, unknown>) => ({
  ...VALID_CLAIM,
  ...overrides,
});

describe("ClaimSchema", () => {
  test("parses a valid claim", () => {
    // Arrange
    const input = buildClaim({});

    // Act
    const result = ClaimSchema.safeParse(input);

    // Assert
    expect(result.success).toBe(true);
  });

  test("defaults evidenceRefs to an empty array when omitted", () => {
    // Arrange
    const { evidenceRefs: _omitted, ...withoutEvidence } = VALID_CLAIM;

    // Act
    const result = ClaimSchema.parse(withoutEvidence);

    // Assert
    expect(result.evidenceRefs).toEqual([]);
  });

  test("rejects a body longer than the maximum length", () => {
    // Arrange
    const input = buildClaim({ body: "x".repeat(MAX_CLAIM_BODY_LENGTH + 1) });

    // Act
    const result = ClaimSchema.safeParse(input);

    // Assert
    expect(result.success).toBe(false);
  });

  test("rejects confidence above 1", () => {
    const result = ClaimSchema.safeParse(buildClaim({ confidence: 1.2 }));

    expect(result.success).toBe(false);
  });

  test("rejects a derived claim with confidence above the derived cap", () => {
    // Arrange — derived (machine-summarized) claims must stay below the cap
    const input = buildClaim({
      provenance: "derived",
      captureMode: "auto",
      confidence: DERIVED_CONFIDENCE_CAP + 0.3,
    });

    // Act
    const result = ClaimSchema.safeParse(input);

    // Assert
    expect(result.success).toBe(false);
  });

  test("accepts a declared claim with confidence above the derived cap", () => {
    const result = ClaimSchema.safeParse(
      buildClaim({ provenance: "declared", confidence: 0.8 }),
    );

    expect(result.success).toBe(true);
  });

  test("rejects likely_root_cause status without evidence refs", () => {
    const result = ClaimSchema.safeParse(
      buildClaim({ status: "likely_root_cause", evidenceRefs: [] }),
    );

    expect(result.success).toBe(false);
  });

  test("accepts likely_root_cause status with at least one evidence ref", () => {
    const result = ClaimSchema.safeParse(
      buildClaim({ status: "likely_root_cause", evidenceRefs: ["cl_9"] }),
    );

    expect(result.success).toBe(true);
  });

  test("tolerates unknown extra fields for forward compatibility", () => {
    const result = ClaimSchema.safeParse(
      buildClaim({ futureField: "from a newer producer" }),
    );

    expect(result.success).toBe(true);
  });
});

describe("ClaimEdgeSchema", () => {
  const VALID_EDGE = {
    id: "ce_1",
    fromClaimId: "cl_1",
    toClaimId: "cl_2",
    kind: "deeper_cause_of",
    authorSessionId: "ses_2",
    createdAt: "2026-07-24T10:05:00.000Z",
  } as const;

  test("parses a valid deeper_cause_of edge", () => {
    const result = ClaimEdgeSchema.safeParse(VALID_EDGE);

    expect(result.success).toBe(true);
  });

  test("rejects an edge pointing at its own source claim", () => {
    const result = ClaimEdgeSchema.safeParse({
      ...VALID_EDGE,
      toClaimId: VALID_EDGE.fromClaimId,
    });

    expect(result.success).toBe(false);
  });

  test("rejects an unknown edge kind", () => {
    const result = ClaimEdgeSchema.safeParse({
      ...VALID_EDGE,
      kind: "vaguely_related_to",
    });

    expect(result.success).toBe(false);
  });
});

describe("spec conformance of enums", () => {
  test("claim kinds match DESIGN.md §5", () => {
    expect(CLAIM_KINDS).toEqual([
      "observation",
      "hypothesis",
      "evidence",
      "root_cause",
      "decision",
      "rejected_approach",
    ]);
  });

  test("claim statuses match DESIGN.md §5", () => {
    expect(CLAIM_STATUSES).toEqual([
      "proposed",
      "partially_confirmed",
      "likely_root_cause",
      "rejected",
      "superseded",
    ]);
  });

  test("edge kinds match DESIGN.md §5", () => {
    expect(EDGE_KINDS).toEqual([
      "supports",
      "contradicts",
      "deeper_cause_of",
      "supersedes",
      "relates_to",
    ]);
  });
});