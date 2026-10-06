/**
 * The hint wire carries a body only where a hint may show one (hold-out
 * review, M1). A claim that cannot be substance — not a settled root cause
 * or a stated decision, not evidence-backed, not declared, or with no
 * sentence worth showing — travels as a pointer's claim, body withheld, so a
 * connector older than the substance rules (0.10.0 inlines a rejected
 * approach, a proposed root cause) has nothing to inline. And the evidence
 * count on the wire is the RESOLVED one, so an older connector's count gate
 * reads the same verdict.
 */
import { describe, expect, test } from "bun:test";

import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  validClaimBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
} from "./helpers.ts";

const QUERY = "why does the refresh token cache drop the rotated key";

interface WireClaim {
  readonly id: string;
  readonly body: string;
  readonly evidenceRefCount: number;
}

const wireClaims = async (): Promise<ReadonlyMap<string, WireClaim>> => {
  const { harness, developer: nick } = await createHarnessWithSession();
  const records = [
    recordEnvelope("work_context", validWorkContextBody({ title: "Refresh token cache drops rotated key" })),
    recordEnvelope("claim", validClaimBody({ id: "clm_obs", kind: "observation", body: "The token cache keeps the rotated key for an hour" })),
    recordEnvelope("claim", validClaimBody({ id: "clm_draft", kind: "observation", provenance: "derived", captureMode: "auto", confidence: 0.4, body: "A model guessed the refresh token cache is stale" })),
    recordEnvelope("claim", validClaimBody({ id: "clm_settled", kind: "root_cause", status: "likely_root_cause", evidenceRefs: ["clm_obs", "clm_draft", "clm_nowhere"], body: "The refresh token cache never drops the rotated key." })),
    recordEnvelope("claim", validClaimBody({ id: "clm_unbacked", kind: "root_cause", status: "likely_root_cause", evidenceRefs: ["clm_draft"], body: "The refresh token cache keeps the rotated key forever." })),
    recordEnvelope("claim", validClaimBody({ id: "clm_theory", kind: "root_cause", status: "proposed", evidenceRefs: ["clm_obs"], body: "Maybe the refresh token cache never drops the key." })),
    recordEnvelope("claim", validClaimBody({ id: "clm_decision", kind: "decision", evidenceRefs: ["clm_obs"], body: "Drop the rotated key from the refresh token cache on rotation." })),
    recordEnvelope("claim", validClaimBody({ id: "clm_rejected", kind: "rejected_approach", status: "rejected", evidenceRefs: ["clm_obs"], body: "Pinning the refresh token cache in the CDN does not drop the key." })),
  ];
  const seeded = await postRecords(harness, nick, { records });
  expect(seeded.data?.accepted).toBe(records.length);
  const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });
  const search = new URLSearchParams({ repo: VALID_SESSION_BODY.repo, query: QUERY });
  const response = await harness.app.request(`/api/hints/candidates?${search.toString()}`, jsonRequest("GET", robin.apiKey));
  const body = (await response.json()) as { data: { candidates: readonly { claims: readonly WireClaim[] }[] } };
  return new Map(body.data.candidates.flatMap((candidate) => candidate.claims).map((claim) => [claim.id, claim]));
};

describe("a body travels only where a hint may show it (hold-out review, M1)", () => {
  test.each([
    ["a settled, evidence-backed root cause", "clm_settled"],
    ["a stated decision with evidence", "clm_decision"],
  ])("%s carries its body", async (_, claimId) => {
    // Arrange + Act
    const claims = await wireClaims();

    // Assert
    expect(claims.get(claimId)?.body.length ?? 0).toBeGreaterThan(0);
  });

  test.each([
    ["a root cause whose evidence does not resolve", "clm_unbacked"],
    ["a proposed root cause — a theory", "clm_theory"],
    ["a rejected approach — a pointer since H4", "clm_rejected"],
    ["an observation", "clm_obs"],
  ])("%s travels with its body withheld", async (_, claimId) => {
    // Arrange + Act
    const claims = await wireClaims();

    // Assert — still on the wire as a claim of its tree, but nothing to inline
    expect(claims.has(claimId)).toBe(true);
    expect(claims.get(claimId)?.body).toBe("");
  });

  test("the evidence count is the resolved one — a draft and a ref to nothing are not evidence", async () => {
    // Arrange + Act
    const claims = await wireClaims();

    // Assert — three stored refs, one resolves
    expect(claims.get("clm_settled")?.evidenceRefCount).toBe(1);
    expect(claims.get("clm_unbacked")?.evidenceRefCount).toBe(0);
  });
});
