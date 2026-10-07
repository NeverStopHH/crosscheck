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
import { REVISION_MAX_DEPTH } from "@crosscheck/schema";

import { resolvedEvidenceCounts } from "../src/services/evidence-resolution.ts";

import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validClaimBody,
  validClaimEdgeBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

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

const QUERY = "why does the refresh token cache drop the rotated key";

/** Each claim's evidenceBacked as Robin's prompt sees it. */
const backedByClaim = async (harness: TestHarness, robin: TestDeveloper): Promise<ReadonlyMap<string, boolean | undefined>> => {
  const search = new URLSearchParams({ repo: REPO, query: QUERY });
  const response = await harness.app.request(`/api/hints/candidates?${search.toString()}`, jsonRequest("GET", robin.apiKey));
  const body = (await response.json()) as {
    data: { candidates: readonly { claims: readonly { id: string; evidenceBacked?: boolean }[] }[] };
  };
  return new Map(body.data.candidates.flatMap((candidate) => candidate.claims).map((row) => [row.id, row.evidenceBacked]));
};

describe("only a standing, vouched observation with content in the same repo is evidence (hold-out review, H5 + M2)", () => {
  /** The review's probe shapes: every cited claim a count of refs would accept. */
  const probeWorld = async (): Promise<{ harness: TestHarness; robin: TestDeveloper }> => {
    const { harness, developer: nick } = await createHarnessWithSession();
    await registerTestSession(harness, nick.apiKey, { id: "ses_other", repo: "github.com/other/elsewhere" });
    const records = [
      recordEnvelope("work_context", validWorkContextBody({ title: "Refresh token cache drops rotated key" })),
      recordEnvelope("work_context", validWorkContextBody({ id: "wc_other", sessionId: "ses_other", title: "Unrelated other-repo work" }), { sessionId: "ses_other" }),
      recordEnvelope("claim", validClaimBody({ id: "clm_draft", kind: "observation", provenance: "derived", captureMode: "auto", confidence: 0.4, body: "A model guessed the cache entry is stale" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_obs_rejected", kind: "observation", status: "rejected", body: "The cache entry survives the rotation, refuted" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_obs_v1", kind: "observation", body: "The old version of the cache observation" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_obs_v2", kind: "observation", body: "The cache entry for the old kid survives every rotation" })),
      recordEnvelope("claim_edge", validClaimEdgeBody({ id: "edge_sup", fromClaimId: "clm_obs_v2", toClaimId: "clm_obs_v1", kind: "supersedes" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_obs_gone", kind: "observation", body: "The cache entry keeps the rotated kid an hour" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_retraction", kind: "observation", body: "Retracted: that was wrong." })),
      recordEnvelope("claim_edge", validClaimEdgeBody({ id: "edge_ret", fromClaimId: "clm_retraction", toClaimId: "clm_obs_gone", kind: "supersedes" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_other_repo", workContextId: "wc_other", authorSessionId: "ses_other", kind: "observation", body: "The other repo's cache entry survives too" }), { sessionId: "ses_other" }),
      recordEnvelope("claim", validClaimBody({ id: "clm_trivial", kind: "observation", body: "x" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_other_cause", kind: "root_cause", status: "likely_root_cause", evidenceRefs: ["clm_obs_v2"], body: "The JWKS kid cache is never invalidated" })),
      cause("clm_cites_draft", ["clm_draft"]),
      cause("clm_cites_rejected", ["clm_obs_rejected"]),
      cause("clm_cites_revised", ["clm_obs_v1"]),
      cause("clm_cites_retracted", ["clm_obs_gone"]),
      cause("clm_cites_other_repo", ["clm_other_repo"]),
      cause("clm_cites_trivial", ["clm_trivial"]),
      cause("clm_cites_cause", ["clm_other_cause"]),
      // a root cause and a decision citing each other, and nothing else
      cause("clm_cycle_a", ["clm_cycle_b"]),
      recordEnvelope("claim", validClaimBody({ id: "clm_cycle_b", kind: "decision", evidenceRefs: ["clm_cycle_a"], body: "Rotate the refresh token cache key per request" })),
      // an observation citing itself, and an observation's revision citing what it revises —
      // evidence kinds, so only the self rule refuses them
      recordEnvelope("claim", validClaimBody({ id: "clm_obs_self", kind: "observation", evidenceRefs: ["clm_obs_self"], body: "The cache entry for the old kid survives a restart" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_obs_rev_old", kind: "observation", body: "Old note." })),
      recordEnvelope("claim", validClaimBody({ id: "clm_obs_rev_new", kind: "observation", evidenceRefs: ["clm_obs_rev_old"], body: "The cache entry for the old kid survives every deploy" })),
      recordEnvelope("claim_edge", validClaimEdgeBody({ id: "edge_obs_rev", fromClaimId: "clm_obs_rev_new", toClaimId: "clm_obs_rev_old", kind: "supersedes" })),
      // L3: an observation in another repo, revised into this one
      recordEnvelope("claim", validClaimBody({ id: "clm_moved_old", workContextId: "wc_other", authorSessionId: "ses_other", kind: "observation", body: "The other repo's kid cache keeps the rotated key" }), { sessionId: "ses_other" }),
      recordEnvelope("claim", validClaimBody({ id: "clm_moved_new", kind: "observation", body: "The kid cache keeps the rotated key for an hour here too" })),
      recordEnvelope("claim_edge", validClaimEdgeBody({ id: "edge_moved", fromClaimId: "clm_moved_new", toClaimId: "clm_moved_old", kind: "supersedes" })),
      cause("clm_cites_moved", ["clm_moved_old"]),
      // and the opposite: an observation here, revised into another repo
      recordEnvelope("claim", validClaimBody({ id: "clm_left_old", kind: "observation", body: "The kid cache here keeps the rotated key overnight" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_left_new", workContextId: "wc_other", authorSessionId: "ses_other", kind: "observation", body: "The other repo's kid cache keeps the rotated key overnight" }), { sessionId: "ses_other" }),
      recordEnvelope("claim_edge", validClaimEdgeBody({ id: "edge_left", fromClaimId: "clm_left_new", toClaimId: "clm_left_old", kind: "supersedes", authorSessionId: "ses_other" }), { sessionId: "ses_other" }),
      cause("clm_cites_left", ["clm_left_old"]),
      // a revision citing the very claim it retracts
      cause("clm_rev_old", ["clm_trivial"]),
      cause("clm_rev_new", ["clm_rev_old"]),
      recordEnvelope("claim_edge", validClaimEdgeBody({ id: "edge_rev", fromClaimId: "clm_rev_new", toClaimId: "clm_rev_old", kind: "supersedes" })),
      // L6: a hypothesis that SUPPORTS the cited observation revises nothing
      recordEnvelope("claim", validClaimBody({ id: "clm_obs_supported", kind: "observation", body: "The kid cache keeps the old key after every rotation" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_hyp_supporting", kind: "hypothesis", body: "Maybe the rotation never clears the kid cache" })),
      recordEnvelope("claim_edge", validClaimEdgeBody({ id: "edge_supports_obs", fromClaimId: "clm_hyp_supporting", toClaimId: "clm_obs_supported", kind: "supports" })),
      cause("clm_cites_supported", ["clm_obs_supported"]),
      // and an observation that supports a cited hypothesis is not what was cited
      recordEnvelope("claim", validClaimBody({ id: "clm_hyp_cited", kind: "hypothesis", body: "Maybe the kid cache is keyed per region" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_obs_for_hyp", kind: "observation", body: "The kid cache has one entry per region in production" })),
      recordEnvelope("claim_edge", validClaimEdgeBody({ id: "edge_supports_hyp", fromClaimId: "clm_obs_for_hyp", toClaimId: "clm_hyp_cited", kind: "supports" })),
      cause("clm_cites_supported_hyp", ["clm_hyp_cited"]),
    ];
    const seeded = await postRecords(harness, nick, { records });
    expect(seeded.data?.accepted).toBe(records.length);
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });
    return { harness, robin };
  };

  test.each([
    ["an unreviewed draft", "clm_cites_draft", false],
    ["a refuted observation", "clm_cites_rejected", false],
    ["a revised observation — it resolves to its standing revision", "clm_cites_revised", true],
    ["a retracted observation — it resolves to the retraction, which says nothing", "clm_cites_retracted", false],
    ["an observation in another repo", "clm_cites_other_repo", false],
    ["an observation in another repo, revised into this one — the original counts too (round 3, L3)", "clm_cites_moved", false],
    ["an observation here, revised into another repo — the head counts too", "clm_cites_left", false],
    ["an observation of one letter", "clm_cites_trivial", false],
    ["another root cause — a conclusion backs no conclusion", "clm_cites_cause", false],
    ["a decision that cites it back — a cycle backs nothing", "clm_cycle_a", false],
    ["the claim its own revision retracts", "clm_rev_new", false],
    ["itself, from an observation", "clm_obs_self", false],
    ["the observation its own revision revises", "clm_obs_rev_new", false],
    ["an observation a hypothesis supports — a supporting edge revises nothing (round 3, L6)", "clm_cites_supported", true],
    ["a hypothesis an observation supports — the support is not what was cited (L6)", "clm_cites_supported_hyp", false],
  ])("a ref to %s → evidenceBacked %p", async (_, claimId, backed) => {
    // Arrange
    const { harness, robin } = await probeWorld();

    // Act
    const backedById = await backedByClaim(harness, robin);

    // Assert
    expect(backedById.get(claimId)).toBe(backed);
  });

  test("read time: an observation retracted later takes the backing of every claim that cited it", async () => {
    // Arrange — backed while the observation stands
    const { harness, developer: nick } = await createHarnessWithSession();
    await postRecords(harness, nick, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ title: "Refresh token cache drops rotated key" })),
        recordEnvelope("claim", validClaimBody({ id: "clm_obs", kind: "observation", body: "The cache entry for the old kid survives the rotation" })),
        cause("clm_cause", ["clm_obs"]),
      ],
    });
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });
    const before = (await backedByClaim(harness, robin)).get("clm_cause");

    // Act — the author retracts the observation
    await postRecords(harness, nick, {
      records: [
        recordEnvelope("claim", validClaimBody({ id: "clm_retract", kind: "observation", body: "Retracted: wrong." })),
        recordEnvelope("claim_edge", validClaimEdgeBody({ id: "edge_retract", fromClaimId: "clm_retract", toClaimId: "clm_obs", kind: "supersedes" })),
      ],
    });
    const after = (await backedByClaim(harness, robin)).get("clm_cause");

    // Assert
    expect(before).toBe(true);
    expect(after).toBe(false);
  });
});

describe("a dense revision graph resolves in bounded time (round 3, L6)", () => {
  /** Two claims per layer, every one revising both of the layer below, the top layer revising the bottom: a cycle. */
  const LADDER_WIDTH = 2;
  /** As many layers as the walk takes steps, so every path reaches its bound. */
  const LADDER_LAYERS = REVISION_MAX_DEPTH;
  /** How many of the ladder's claims one root cause cites. */
  const CITED_REFS = 16;
  /**
   * Generous against the ~tens of ms the walk takes: a walk that keeps every
   * PATH instead of every (node, depth) multiplies 2^16 rows per cited claim
   * and takes seconds — the denial of service the review named.
   */
  const RESOLUTION_BUDGET_MS = 1_000;

  const node = (layer: number, slot: number): string => `clm_rung_${String(layer)}_${String(slot)}`;

  test("every path through a cyclic ladder is walked once per step, never once per route", async () => {
    // Arrange
    const { harness, developer: nick } = await createHarnessWithSession();
    const layers = Array.from({ length: LADDER_LAYERS }, (_, layer) => layer);
    const slots = Array.from({ length: LADDER_WIDTH }, (_, slot) => slot);
    const claims = layers.flatMap((layer) =>
      slots.map((slot) =>
        recordEnvelope("claim", validClaimBody({ id: node(layer, slot), kind: "observation", body: `The kid cache keeps rung ${String(layer)}, slot ${String(slot)} of the key` })),
      ),
    );
    const edges = layers.flatMap((layer) =>
      slots.flatMap((from) =>
        slots.map((to) =>
          recordEnvelope(
            "claim_edge",
            validClaimEdgeBody({
              id: `edge_rung_${String(layer)}_${String(from)}_${String(to)}`,
              fromClaimId: node((layer + 1) % LADDER_LAYERS, from),
              toClaimId: node(layer, to),
              kind: "supersedes",
            }),
          ),
        ),
      ),
    );
    const refs = Array.from({ length: CITED_REFS }, (_, index) => node(index % LADDER_LAYERS, Math.floor(index / LADDER_LAYERS) % LADDER_WIDTH));
    const seededClaims = await postRecords(harness, nick, {
      records: [recordEnvelope("work_context", validWorkContextBody({ title: "Kid cache ladder" })), ...claims, cause("clm_cites_ladder", refs)],
    });
    const seededEdges = await postRecords(harness, nick, { records: edges });
    expect(seededClaims.data?.accepted).toBe(claims.length + 2);
    expect(seededEdges.data?.accepted).toBe(edges.length);

    // Act
    const started = performance.now();
    const counts = await resolvedEvidenceCounts(harness.db, ["clm_cites_ladder"]);
    const elapsed = performance.now() - started;

    // Assert — every claim on the ladder is revised, so nothing backs it, and quickly
    expect(counts.get("clm_cites_ladder")).toBeUndefined();
    expect(elapsed).toBeLessThan(RESOLUTION_BUDGET_MS);
  });
});
