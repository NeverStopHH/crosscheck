/**
 * The three business rules in @crosscheck/schema, as sentences an agent can act
 * on rather than as zod dumps.
 *
 * The contract enforces them (packages/schema/src/claim.ts). It does not explain
 * them: a caller handed `evidenceRefs: Too small: expected array to have >=1
 * items` learns nothing about WHY, and "publish the evidence claim first, then
 * pass its id" is the whole of what it needed. That gap is what this module is.
 *
 * WHY THE DERIVED-CONFIDENCE RULE IS TESTED HERE AND NOT THROUGH A TOOL. Both
 * writing tools set `provenance: "declared"` — an agent calling `publish_claim`
 * IS declaring — so no tool argument can currently produce a derived claim, and
 * that branch is unreachable from the tool surface today. It is covered anyway,
 * because this module's contract is "any ClaimSchema violation becomes a useful
 * message", not "the violations publish_claim happens to be able to cause". The
 * unreachability is checkable rather than asserted:
 *
 * VERIFY: grep -c 'provenance: "declared"' packages/connector-claude/src/mcp/tools/publish-claim.ts packages/connector-claude/src/mcp/tools/extend-diagnosis.ts
 * PRINTS: packages/connector-claude/src/mcp/tools/publish-claim.ts:1
 * PRINTS: packages/connector-claude/src/mcp/tools/extend-diagnosis.ts:1
 */
import { describe, expect, test } from "bun:test";

import {
  DERIVED_CONFIDENCE_CAP,
  MAX_CLAIM_BODY_LENGTH,
} from "@crosscheck/schema";

import {
  checkClaim,
  checkClaimEdge,
  explainRejection,
} from "../src/mcp/violations.ts";

const CREATED = "2026-07-24T09:00:00.000Z";

const claimBody = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: "clm_01",
  workContextId: "wc_01",
  authorSessionId: "cc_a-uuid",
  kind: "observation",
  body: "JWT validation fails after token refresh",
  status: "proposed",
  confidence: 0.8,
  captureMode: "agent",
  provenance: "declared",
  evidenceRefs: [],
  createdAt: CREATED,
  ...overrides,
});

const edgeBody = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: "edge_01",
  fromClaimId: "clm_02",
  toClaimId: "clm_01",
  kind: "deeper_cause_of",
  authorSessionId: "cc_a-uuid",
  createdAt: CREATED,
  ...overrides,
});

const messagesOf = (check: ReturnType<typeof checkClaim>): readonly string[] =>
  check.ok ? [] : check.messages;

describe("checkClaim", () => {
  test("passes a claim that satisfies the contract", () => {
    expect(checkClaim(claimBody()).ok).toBe(true);
  });

  test("explains the body length cap with both numbers", () => {
    // Arrange: one character past the cap
    const body = claimBody({ body: "x".repeat(MAX_CLAIM_BODY_LENGTH + 1) });

    // Act
    const messages = messagesOf(checkClaim(body));

    // Assert: the cap, the actual size, and what to do — not "Too big"
    const joined = messages.join(" ");
    expect(joined).toContain(String(MAX_CLAIM_BODY_LENGTH));
    expect(joined).toContain(String(MAX_CLAIM_BODY_LENGTH + 1));
    expect(joined.toLowerCase()).toContain("split");
  });

  test("explains that a likely_root_cause needs evidence", () => {
    // Arrange: the rule that exists because a root cause asserted without
    // evidence is the failure mode the whole product is against
    const body = claimBody({ status: "likely_root_cause", evidenceRefs: [] });

    // Act
    const joined = messagesOf(checkClaim(body)).join(" ");

    // Assert
    expect(joined).toContain("likely_root_cause");
    expect(joined).toContain("evidenceRefs");
    expect(joined.toLowerCase()).toContain("publish the evidence");
  });

  test("accepts a likely_root_cause that carries an evidence ref", () => {
    const body = claimBody({
      status: "likely_root_cause",
      evidenceRefs: ["clm_evidence"],
    });

    expect(checkClaim(body).ok).toBe(true);
  });

  test("explains the derived-confidence cap", () => {
    // Arrange: DESIGN.md §3 — a machine-derived claim may not assert more
    // confidence than a human-declared one
    const body = claimBody({ provenance: "derived", confidence: 0.9 });

    // Act
    const joined = messagesOf(checkClaim(body)).join(" ");

    // Assert
    expect(joined).toContain(String(DERIVED_CONFIDENCE_CAP));
    expect(joined).toContain("derived");
  });

  test("lists the kinds it will accept when handed one it will not", () => {
    // Arrange: a model guessing "bug" learns more from the list than from
    // `invalid_value`
    const joined = messagesOf(checkClaim(claimBody({ kind: "bug" }))).join(" ");

    // Assert
    expect(joined).toContain("observation");
    expect(joined).toContain("rejected_approach");
  });

  test("lists the statuses it will accept when handed one it will not", () => {
    const joined = messagesOf(
      checkClaim(claimBody({ status: "definitely" })),
    ).join(" ");

    expect(joined).toContain("proposed");
    expect(joined).toContain("likely_root_cause");
  });

  test("reports every violation at once, not one per round trip", () => {
    // Arrange: an agent that has to retry once per broken field burns turns
    const body = claimBody({
      kind: "bug",
      body: "x".repeat(MAX_CLAIM_BODY_LENGTH + 1),
    });

    // Act
    const messages = messagesOf(checkClaim(body));

    // Assert
    expect(messages.length).toBeGreaterThanOrEqual(2);
  });

  test("never leaks a raw zod code into a message", () => {
    // Arrange: the defect this module exists to prevent
    const bodies = [
      claimBody({ kind: "bug" }),
      claimBody({ body: "" }),
      claimBody({ status: "likely_root_cause" }),
      claimBody({ provenance: "derived", confidence: 0.9 }),
      claimBody({ confidence: 5 }),
    ];

    // Act + Assert
    for (const body of bodies) {
      for (const message of messagesOf(checkClaim(body))) {
        expect(message).not.toContain("invalid_type");
        expect(message).not.toContain("invalid_value");
        expect(message).not.toContain("too_big");
        expect(message).not.toContain("too_small");
        expect(message).not.toContain("zod");
      }
    }
  });
});

describe("checkClaimEdge", () => {
  test("passes an edge that satisfies the contract", () => {
    expect(checkClaimEdge(edgeBody()).ok).toBe(true);
  });

  test("explains a self-edge", () => {
    // Arrange
    const body = edgeBody({ fromClaimId: "clm_01", toClaimId: "clm_01" });

    // Act
    const joined = messagesOf(checkClaimEdge(body)).join(" ");

    // Assert
    expect(joined.toLowerCase()).toContain("two different claims");
  });

  test("lists the edge kinds it will accept", () => {
    const joined = messagesOf(
      checkClaimEdge(edgeBody({ kind: "causes" })),
    ).join(" ");

    expect(joined).toContain("deeper_cause_of");
    expect(joined).toContain("contradicts");
  });
});

describe("explainRejection", () => {
  test("turns the supersedes ownership rule into the rule, not a status code", () => {
    // Arrange: exactly what the hub sends back
    // (services/record-handlers.ts `ingestClaimEdge`)
    const issues = ["kind: supersedes requires ownership of both claims"];

    // Act
    const explained = explainRejection(issues);

    // Assert: says WHAT the rule is and WHICH edge kind to use instead
    expect(explained).toContain("supersedes");
    expect(explained.toLowerCase()).toContain("your own");
    expect(explained).toContain("contradicts");
    expect(explained).toContain("deeper_cause_of");
  });

  test("explains a work context the hub does not have", () => {
    const explained = explainRejection([
      'workContextId: work context "wc_nope" not found',
    ]);

    expect(explained).toContain("wc_nope");
    expect(explained).toContain("search_related_work");
  });

  test("explains an ended producer session", () => {
    // Arrange: the liveness gate in services/records.ts. An agent seeing this
    // needs to know it is about ITS session, not about the claim.
    const explained = explainRejection([
      "producer.sessionId: session has already ended — late writes are rejected",
    ]);

    expect(explained.toLowerCase()).toContain("session");
    expect(explained.toLowerCase()).toContain("ended");
  });

  test("passes an unrecognised issue through rather than swallowing it", () => {
    // Arrange: a hub newer than this connector will say things this map has
    // never seen, and losing them would be worse than not phrasing them well
    const explained = explainRejection(["something: entirely new"]);

    expect(explained).toContain("something: entirely new");
  });

  test("says something useful when the hub sent no issues at all", () => {
    // Arrange: an older hub omits `results`, so the tool knows only that a
    // record was rejected
    const explained = explainRejection([]);

    expect(explained.length).toBeGreaterThan(0);
  });
});
