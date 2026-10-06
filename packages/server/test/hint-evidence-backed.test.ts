/**
 * "Evidence-backed", decided by the hub (review 1006b, H4): a claim pushed as
 * substance must cite at least one evidence ref that RESOLVES — to an
 * existing record that is not the claim itself, and is not a hypothesis still
 * proposed or rejected. A count of refs was the old gate, and a count is
 * satisfied by a ref to nothing, to the claim's own id, or to a guess. The
 * verdict ships per claim as `evidenceBacked`; the connector gates on it and
 * treats its absence (an older hub) as a pointer.
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

const REPO = VALID_SESSION_BODY.repo;

const cause = (id: string, evidenceRefs: readonly string[]) =>
  recordEnvelope(
    "claim",
    validClaimBody({ id, kind: "root_cause", status: "likely_root_cause", evidenceRefs, body: `The refresh token cache drops the rotated key (${id})` }),
  );

describe("the hub decides whether a claim's evidence resolves", () => {
  test.each([
    ["a ref to an existing observation", "clm_cause_ok", true],
    ["a ref to the claim itself", "clm_cause_self", false],
    ["a ref to nothing", "clm_cause_missing", false],
    ["a ref to a proposed hypothesis", "clm_cause_hyp", false],
    ["a ref to a rejected hypothesis", "clm_cause_rejected_hyp", false],
    ["a guess beside a real observation", "clm_cause_mixed", true],
  ])("%s → evidenceBacked %p", async (_, claimId, backed) => {
    // Arrange
    const { harness, developer: nick } = await createHarnessWithSession();
    const records = [
      recordEnvelope("work_context", validWorkContextBody({ title: "Refresh token cache drops rotated key" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_obs", kind: "observation", body: "The cache entry for the old kid survives the rotation" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_hyp", kind: "hypothesis", body: "Maybe the CDN caches the JWKS" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_hyp_no", kind: "hypothesis", status: "rejected", body: "The clock skew explains it" })),
      cause("clm_cause_ok", ["clm_obs"]),
      cause("clm_cause_self", ["clm_cause_self"]),
      cause("clm_cause_missing", ["clm_nowhere"]),
      cause("clm_cause_hyp", ["clm_hyp"]),
      cause("clm_cause_rejected_hyp", ["clm_hyp_no"]),
      cause("clm_cause_mixed", ["clm_hyp", "clm_obs"]),
    ];
    const seeded = await postRecords(harness, nick, { records });
    expect(seeded.data?.accepted).toBe(records.length);
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });

    // Act
    const search = new URLSearchParams({ repo: REPO, query: "why does the refresh token cache drop the rotated key" });
    const response = await harness.app.request(`/api/hints/candidates?${search.toString()}`, jsonRequest("GET", robin.apiKey));
    const body = (await response.json()) as {
      data: { candidates: readonly { claims: readonly { id: string; evidenceBacked?: boolean }[] }[] };
    };

    // Assert
    const claim = body.data.candidates.flatMap((candidate) => candidate.claims).find((row) => row.id === claimId);
    expect(claim?.evidenceBacked).toBe(backed);
  });
});
