/**
 * SUBSTANCE ONLY FROM A STRONG, TOPICAL MATCH, decided on the hub too
 * (hold-out review round 3, H3 + M6). The round-3 hold-out's t004 — "token
 * refresh fails after key rotation" — pushed the rate-limit tree's decision
 * "Use a token bucket per API key …" as a teammate's finding: "token" is a
 * meta word, so the decision shares ONE topical word, and its tree one more.
 *
 * So every count the selector judges relevance on is TOPICAL — the claim's
 * shown sentence (`matchedTerms`), the tree's own statement
 * (`workContext.matchedTerms`), and the tree's best statement (`topicalTerms`,
 * what a pointer's strength is compared on) — and the hub WITHHOLDS a body
 * whose own strong-match test fails, so a connector older than the selector's
 * best-match rule (0.10.0) has no wrong-tree finding to inline.
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

const PROMPT = "token refresh fails after key rotation";
const JWT_TREE = "wc_jwt";
const RATE_TREE = "wc_rate";
const NOTES_TREE = "wc_notes";
const CRASH_TREE = "wc_crash";
const FINGERPRINT = `sha256:${"9c1e".repeat(16)}`;

interface WireClaim {
  readonly id: string;
  readonly body: string;
  readonly matchedTerms?: number;
}

interface WireCandidate {
  readonly workContext: { readonly id: string; readonly matchedTerms?: number };
  readonly claims: readonly WireClaim[];
  readonly topicalTerms?: number;
}

/** The two round-3 trees, Nick's, and Robin asking. */
const candidates = async (): Promise<ReadonlyMap<string, WireCandidate>> => {
  const { harness, developer: nick } = await createHarnessWithSession();
  const records = [
    recordEnvelope("work_context", validWorkContextBody({ id: JWT_TREE, title: "JWT token refresh fails after signing key rotation", description: "Auth" })),
    recordEnvelope("claim", validClaimBody({ id: "clm_jwt_obs", workContextId: JWT_TREE, body: "Every access token refresh fails with invalid signature for ten minutes after a key rotation." })),
    recordEnvelope("claim", validClaimBody({ id: "clm_jwt_dec", workContextId: JWT_TREE, kind: "decision", evidenceRefs: ["clm_jwt_obs"], body: "Keep the previous signing key in the JWKS for 24 hours after every rotation." })),
    recordEnvelope(
      "work_context",
      validWorkContextBody({
        id: RATE_TREE,
        title: "Rate limiting middleware for the public API",
        description: "Gateway",
        intent: { summary: "Add per-key rate limiting to the public API", provenance: "declared", confidence: 0.9, capturedAt: "2026-09-20T08:00:00.000Z" },
      }),
    ),
    recordEnvelope("claim", validClaimBody({ id: "clm_rate_obs", workContextId: RATE_TREE, body: "Public API traffic spikes to 2000 requests per minute from a single key." })),
    recordEnvelope("claim", validClaimBody({ id: "clm_rate_dec", workContextId: RATE_TREE, kind: "decision", evidenceRefs: ["clm_rate_obs"], body: "Use a token bucket per API key with 100 requests per minute." })),
    // A tree whose own statement says nothing, and one claim that says it all
    recordEnvelope("work_context", validWorkContextBody({ id: NOTES_TREE, title: "Investigation notes", description: "Scratch" })),
    recordEnvelope("claim", validClaimBody({ id: "clm_notes_obs", workContextId: NOTES_TREE, body: "The refresh fails right after every key rotation." })),
  ];
  const seeded = await postRecords(harness, nick, { records });
  expect(seeded.data?.accepted).toBe(records.length);
  const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });
  const search = new URLSearchParams({ repo: VALID_SESSION_BODY.repo, query: PROMPT });
  const response = await harness.app.request(`/api/hints/candidates?${search.toString()}`, jsonRequest("GET", robin.apiKey));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { candidates: readonly WireCandidate[] } };
  return new Map(body.data.candidates.map((candidate) => [candidate.workContext.id, candidate]));
};

const claimOf = (candidate: WireCandidate | undefined, id: string): WireClaim | undefined =>
  candidate?.claims.find((claim) => claim.id === id);

describe("every relevance count is topical (H3 + M6)", () => {
  test("a claim's count leaves out the meta words it shares", async () => {
    // Arrange + Act
    const byTree = await candidates();

    // Assert — "token" and "minute" are meta; the rate decision shares "key" alone
    expect(claimOf(byTree.get(RATE_TREE), "clm_rate_dec")?.matchedTerms).toBe(1);
    expect(claimOf(byTree.get(JWT_TREE), "clm_jwt_dec")?.matchedTerms).toBe(2);
  });

  test("a tree's own count leaves them out too", async () => {
    // Arrange + Act
    const byTree = await candidates();

    // Assert — refresh, fails, key, rotation; never token
    expect(byTree.get(JWT_TREE)?.workContext.matchedTerms).toBe(4);
    expect(byTree.get(RATE_TREE)?.workContext.matchedTerms).toBe(1);
  });

  test("each candidate carries its best statement's topical count, the strength a pointer is compared on", async () => {
    // Arrange + Act
    const byTree = await candidates();

    // Assert
    expect(byTree.get(JWT_TREE)?.topicalTerms).toBe(4);
    expect(byTree.get(RATE_TREE)?.topicalTerms).toBe(1);
  });

  test("a tree's strength counts its claims too, not only its own statement", async () => {
    // Arrange + Act
    const byTree = await candidates();

    // Assert — "Investigation notes" shares nothing; its claim shares refresh, fails, key, rotation
    expect(byTree.get(NOTES_TREE)?.workContext.matchedTerms).toBe(0);
    expect(byTree.get(NOTES_TREE)?.topicalTerms).toBe(4);
  });
});

describe("the hub withholds a body its own strong-match test refuses (H3 + M6)", () => {
  test("the rate-limit decision, trusted but weakly matched, travels without its body", async () => {
    // Arrange + Act
    const byTree = await candidates();

    // Assert — a 0.10.0 connector has no wrong-tree finding to inline
    expect(claimOf(byTree.get(RATE_TREE), "clm_rate_dec")?.body).toBe("");
  });

  test("the control: the JWT decision, strongly matched, carries its body", async () => {
    // Arrange + Act
    const byTree = await candidates();

    // Assert
    expect(claimOf(byTree.get(JWT_TREE), "clm_jwt_dec")?.body.length ?? 0).toBeGreaterThan(0);
  });

  test("an error fingerprint the prompt carried is content identity: the body ships without a shared word", async () => {
    // Arrange — the crash tree's decision shares no word with the prompt
    const { harness, developer: nick } = await createHarnessWithSession();
    const records = [
      recordEnvelope("work_context", validWorkContextBody({ id: CRASH_TREE, title: "Exporter crash", description: "Nightly" })),
      recordEnvelope("target", { workContextId: CRASH_TREE, kind: "error_fingerprint", value: FINGERPRINT }),
      recordEnvelope("claim", validClaimBody({ id: "clm_crash_obs", workContextId: CRASH_TREE, body: "The exporter crashes when the bucket name is read before the config loads." })),
      recordEnvelope("claim", validClaimBody({ id: "clm_crash_dec", workContextId: CRASH_TREE, kind: "decision", evidenceRefs: ["clm_crash_obs"], body: "Load the bucket configuration before the exporter starts its first upload." })),
    ];
    const seeded = await postRecords(harness, nick, { records });
    expect(seeded.data?.accepted).toBe(records.length);
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });
    const search = new URLSearchParams({ repo: VALID_SESSION_BODY.repo, query: `${FINGERPRINT} again in the nightly job` });

    // Act
    const response = await harness.app.request(`/api/hints/candidates?${search.toString()}`, jsonRequest("GET", robin.apiKey));
    const body = (await response.json()) as { data: { candidates: readonly WireCandidate[] } };
    const crash = body.data.candidates.find((candidate) => candidate.workContext.id === CRASH_TREE);

    // Assert
    expect(claimOf(crash, "clm_crash_dec")?.matchedTerms).toBe(0);
    expect(claimOf(crash, "clm_crash_dec")?.body.length ?? 0).toBeGreaterThan(0);
  });
});
