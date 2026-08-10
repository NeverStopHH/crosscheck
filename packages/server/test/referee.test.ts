/**
 * Referee mode (VISION.md §4): GET /api/contradictions/:id/brief — the
 * structured case file over one contradiction pair, plus the deterministic
 * pair id the listing now carries so that a brief can be asked for at all.
 *
 * THE HUB PICKS NO WINNER. Everything asserted here is facts a human can act
 * on in thirty seconds: both positions with author and status, the evidence
 * each side cites (refs and supports edges, depth-capped), what each side has
 * ruled out, the shared ground, and — retirement honesty — whether a side has
 * since been superseded by its own author. The "one test that would separate
 * them" line from VISION.md §4 is LLM territory and is deliberately absent.
 */
import { describe, expect, test } from "bun:test";

import {
  addTestDeveloperWithSession,
  createTestHarness,
  createTestDeveloper,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validClaimBody,
  validClaimEdgeBody,
  validWorkContextBody,
} from "./helpers.ts";
import type { TestHarness, TestDeveloper } from "./helpers.ts";
import { CONTRADICTIONS_MAX_LIMIT } from "../src/services/contradictions.ts";
import { REFEREE_MAX_EVIDENCE_PER_SIDE } from "../src/services/referee.ts";
import { createFakeEmbedder } from "./fixtures/fake-embedder.ts";

const SECOND_SESSION_ID = "ses_02";
const FINGERPRINT = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const PAIR_ID_PATTERN = /^cx_[0-9a-f]{32}$/;

interface BriefClaim {
  readonly id: string;
  readonly workContextId: string;
  readonly kind: string;
  readonly status: string;
  readonly confidence: number;
  readonly body: string;
  readonly authorDeveloperName: string;
  readonly createdAt: string;
}

interface BriefPosition {
  readonly claim: BriefClaim;
  readonly workContextTitle: string;
  readonly evidence: readonly BriefClaim[];
  readonly evidenceTruncated: boolean;
  readonly ruledOut: readonly BriefClaim[];
  readonly ruledOutTruncated: boolean;
  readonly supersededByClaimId: string | null;
}

interface BriefView {
  readonly id: string;
  readonly reason: string;
  readonly similarity: number | null;
  readonly positionA: BriefPosition;
  readonly positionB: BriefPosition;
  readonly sharedTargets: readonly { kind: string; value: string }[];
  readonly sharedTargetsTruncated: boolean;
}

interface ListedCandidate {
  readonly id: string;
  readonly claimA: { readonly id: string; readonly authorDeveloperName?: string };
  readonly claimB: { readonly id: string; readonly authorDeveloperName?: string };
}

const listCandidates = async (
  harness: TestHarness,
  apiKey: string,
): Promise<readonly ListedCandidate[]> => {
  const response = await harness.app.request(
    "/api/contradictions",
    jsonRequest("GET", apiKey),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: { candidates: ListedCandidate[] };
  };
  return body.data.candidates;
};

const fetchBrief = async (
  harness: TestHarness,
  apiKey: string | null,
  id: string,
): Promise<{ status: number; brief: BriefView | null }> => {
  const response = await harness.app.request(
    `/api/contradictions/${id}/brief`,
    jsonRequest("GET", apiKey),
  );
  if (response.status !== 200) {
    return { status: response.status, brief: null };
  }
  const body = (await response.json()) as { data: { brief: BriefView } };
  return { status: response.status, brief: body.data.brief };
};

interface Deadlock {
  readonly harness: TestHarness;
  readonly nick: TestDeveloper;
  readonly robin: TestDeveloper;
}

/**
 * Nick's wc_01 and Robin's wc_02 share one error fingerprint. Nick holds an
 * open hypothesis with evidence through BOTH channels — an evidenceRefs entry
 * (clm_ev1) and a supports edge (clm_ev2 → clm_01) — plus a second-level
 * supporter (clm_deep → clm_ev2) and a third-level one past the walk depth
 * (clm_toodeep → clm_deep). Robin rejected the same theory citing nothing.
 * Each side ruled one approach out; Robin also planted a rejected_approach in
 * NICK's context, which must never be billed to Nick.
 */
const seedDeadlock = async (): Promise<Deadlock> => {
  const harness = await createTestHarness();
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  await registerTestSession(harness, nick.apiKey);
  const robin = await addTestDeveloperWithSession(
    harness,
    "Robin",
    "robin@example.com",
    { id: SECOND_SESSION_ID },
  );

  await postRecords(harness, nick, {
    records: [
      recordEnvelope("work_context", validWorkContextBody()),
      recordEnvelope("target", {
        workContextId: "wc_01",
        kind: "error_fingerprint",
        value: FINGERPRINT,
      }),
      recordEnvelope("target", {
        workContextId: "wc_01",
        kind: "file",
        value: "src/auth/rotate.ts",
      }),
      recordEnvelope(
        "claim",
        validClaimBody({
          kind: "hypothesis",
          status: "proposed",
          body: "The rotation job overruns its window and drops the key",
          evidenceRefs: ["clm_ev1"],
        }),
      ),
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_ev1",
          kind: "evidence",
          body: "Rotation log shows a 41 s run against a 30 s window",
        }),
      ),
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_ev2",
          kind: "evidence",
          body: "Key absent from the store during the failure minute",
        }),
      ),
      recordEnvelope(
        "claim_edge",
        validClaimEdgeBody({ fromClaimId: "clm_ev2", toClaimId: "clm_01" }),
      ),
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_deep",
          kind: "evidence",
          body: "Scheduler tick drifted through the DST boundary",
        }),
      ),
      recordEnvelope(
        "claim_edge",
        validClaimEdgeBody({
          id: "edge_deep",
          fromClaimId: "clm_deep",
          toClaimId: "clm_ev2",
        }),
      ),
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_toodeep",
          kind: "observation",
          body: "The runner image pins an old tzdata",
        }),
      ),
      recordEnvelope(
        "claim_edge",
        validClaimEdgeBody({
          id: "edge_toodeep",
          fromClaimId: "clm_toodeep",
          toClaimId: "clm_deep",
        }),
      ),
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_ra_nick",
          kind: "rejected_approach",
          body: "Clock skew on the runner ruled out by NTP logs",
        }),
      ),
    ],
  });
  await postRecords(harness, robin, {
    records: [
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          id: "wc_02",
          sessionId: SECOND_SESSION_ID,
          title: "Key rotation timing audit",
        }),
        { sessionId: SECOND_SESSION_ID },
      ),
      recordEnvelope(
        "target",
        {
          workContextId: "wc_02",
          kind: "error_fingerprint",
          value: FINGERPRINT,
        },
        { sessionId: SECOND_SESSION_ID },
      ),
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_02",
          workContextId: "wc_02",
          authorSessionId: SECOND_SESSION_ID,
          kind: "hypothesis",
          status: "rejected",
          body: "Rotation finished inside its window on every sampled failure",
        }),
        { sessionId: SECOND_SESSION_ID },
      ),
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_ra_robin",
          workContextId: "wc_02",
          authorSessionId: SECOND_SESSION_ID,
          kind: "rejected_approach",
          body: "Sampling bias ruled out: failures span all shards",
        }),
        { sessionId: SECOND_SESSION_ID },
      ),
      // Robin's rejected_approach inside NICK's context: cross-context claims
      // are legal (extend_diagnosis), but it is Robin's statement, not Nick's.
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_ra_foreign",
          workContextId: "wc_01",
          authorSessionId: SECOND_SESSION_ID,
          kind: "rejected_approach",
          body: "Robin ruling something out inside Nick's context",
        }),
        { sessionId: SECOND_SESSION_ID },
      ),
    ],
  });
  return { harness, nick, robin };
};

/**
 * Nick's clm_01 (open) citing `refIds` as evidence — only `existingRefIds`
 * are ingested as claims, the rest stay dead refs — against Robin's rejected
 * clm_02 on a shared fingerprint.
 */
const seedEvidenceRefsPair = async (
  refIds: readonly string[],
  existingRefIds: readonly string[],
): Promise<Deadlock> => {
  const harness = await createTestHarness();
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  await registerTestSession(harness, nick.apiKey);
  const robin = await addTestDeveloperWithSession(
    harness,
    "Robin",
    "robin@example.com",
    { id: SECOND_SESSION_ID },
  );
  await postRecords(harness, nick, {
    records: [
      recordEnvelope("work_context", validWorkContextBody()),
      recordEnvelope("target", {
        workContextId: "wc_01",
        kind: "error_fingerprint",
        value: FINGERPRINT,
      }),
      recordEnvelope(
        "claim",
        validClaimBody({
          kind: "hypothesis",
          status: "proposed",
          body: "Every shard sees the same stale key",
          evidenceRefs: refIds,
        }),
      ),
      ...existingRefIds.map((id, index) =>
        recordEnvelope(
          "claim",
          validClaimBody({
            id,
            kind: "evidence",
            body: `Shard ${String(index)} log shows the stale key`,
          }),
        ),
      ),
    ],
  });
  await postRecords(harness, robin, {
    records: [
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          id: "wc_02",
          sessionId: SECOND_SESSION_ID,
          title: "Stale key audit",
        }),
        { sessionId: SECOND_SESSION_ID },
      ),
      recordEnvelope(
        "target",
        {
          workContextId: "wc_02",
          kind: "error_fingerprint",
          value: FINGERPRINT,
        },
        { sessionId: SECOND_SESSION_ID },
      ),
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_02",
          workContextId: "wc_02",
          authorSessionId: SECOND_SESSION_ID,
          kind: "hypothesis",
          status: "rejected",
          body: "Keys are fresh on every shard sampled",
        }),
        { sessionId: SECOND_SESSION_ID },
      ),
    ],
  });
  return { harness, nick, robin };
};

const sideOf = (brief: BriefView, claimId: string): BriefPosition => {
  const side =
    brief.positionA.claim.id === claimId ? brief.positionA : brief.positionB;
  expect(side.claim.id).toBe(claimId);
  return side;
};

describe("contradiction pair ids", () => {
  test("every listed candidate carries a deterministic cx_ id, stable across reads", async () => {
    // Arrange
    const { harness, nick } = await seedDeadlock();

    // Act
    const first = await listCandidates(harness, nick.apiKey);
    const second = await listCandidates(harness, nick.apiKey);

    // Assert
    expect(first.length).toBe(1);
    expect(first[0]?.id).toMatch(PAIR_ID_PATTERN);
    expect(second[0]?.id).toBe(first[0]?.id ?? "");
  });

  test("listed candidates name both authors, for the briefing pointer", async () => {
    // Arrange
    const { harness, nick } = await seedDeadlock();

    // Act
    const candidates = await listCandidates(harness, nick.apiKey);

    // Assert
    const names = [
      candidates[0]?.claimA.authorDeveloperName,
      candidates[0]?.claimB.authorDeveloperName,
    ].sort();
    expect(names).toEqual(["Nick", "Robin"]);
  });
});

describe("GET /api/contradictions/:id/brief", () => {
  test("is auth-gated like every route, and answers the case file with a key", async () => {
    // Arrange
    const { harness, nick } = await seedDeadlock();
    const [candidate] = await listCandidates(harness, nick.apiKey);

    // Act
    const withoutKey = await fetchBrief(harness, null, candidate?.id ?? "");
    const withKey = await fetchBrief(harness, nick.apiKey, candidate?.id ?? "");

    // Assert
    expect(withoutKey.status).toBe(401);
    expect(withKey.status).toBe(200);
  });

  test("assembles both positions symmetrically: claim, author, context title, evidence, ruled-out", async () => {
    // Arrange
    const { harness, nick } = await seedDeadlock();
    const [candidate] = await listCandidates(harness, nick.apiKey);

    // Act
    const { brief } = await fetchBrief(harness, nick.apiKey, candidate?.id ?? "");

    // Assert: the pair
    expect(brief?.id).toBe(candidate?.id ?? "");
    expect(brief?.reason).toBe("shared_target");
    const nickSide = sideOf(brief as BriefView, "clm_01");
    const robinSide = sideOf(brief as BriefView, "clm_02");

    // Nick's position
    expect(nickSide.claim.authorDeveloperName).toBe("Nick");
    expect(nickSide.claim.status).toBe("proposed");
    expect(nickSide.workContextTitle).toBe("Login 500s on staging");
    expect(nickSide.ruledOut.map((claim) => claim.id)).toEqual(["clm_ra_nick"]);
    expect(nickSide.supersededByClaimId).toBeNull();

    // Robin's position — same fields, same shape, nothing extra on either side
    expect(robinSide.claim.authorDeveloperName).toBe("Robin");
    expect(robinSide.claim.status).toBe("rejected");
    expect(robinSide.workContextTitle).toBe("Key rotation timing audit");
    expect(robinSide.evidence).toEqual([]);
    expect(robinSide.ruledOut.map((claim) => claim.id)).toEqual(["clm_ra_robin"]);
    expect(Object.keys(nickSide).sort()).toEqual(Object.keys(robinSide).sort());

    // Shared ground: the fingerprint both contexts target — never Nick's
    // private file target, which Robin's context does not touch
    expect(brief?.sharedTargets).toEqual([
      { kind: "error_fingerprint", value: FINGERPRINT },
    ]);

    // Every claim is dated, so a renderer can assemble the timeline
    const allClaims = [
      nickSide.claim,
      robinSide.claim,
      ...nickSide.evidence,
      ...nickSide.ruledOut,
      ...robinSide.ruledOut,
    ];
    for (const claim of allClaims) {
      expect(Date.parse(claim.createdAt)).not.toBeNaN();
    }
  });

  test("evidence arrives through refs AND supports edges, walk depth-capped at 2", async () => {
    // Arrange
    const { harness, nick } = await seedDeadlock();
    const [candidate] = await listCandidates(harness, nick.apiKey);

    // Act
    const { brief } = await fetchBrief(harness, nick.apiKey, candidate?.id ?? "");

    // Assert: clm_ev1 via evidenceRefs, clm_ev2 via a supports edge, clm_deep
    // via clm_ev2 (depth 2) — clm_toodeep (depth 3) stays out
    const ids = sideOf(brief as BriefView, "clm_01").evidence.map(
      (claim) => claim.id,
    );
    expect([...ids].sort()).toEqual(["clm_deep", "clm_ev1", "clm_ev2"]);
  });

  test("a rejected_approach by another developer in the same context is not billed to the position", async () => {
    // Arrange
    const { harness, nick } = await seedDeadlock();
    const [candidate] = await listCandidates(harness, nick.apiKey);

    // Act
    const { brief } = await fetchBrief(harness, nick.apiKey, candidate?.id ?? "");

    // Assert: Robin's clm_ra_foreign sits in wc_01 but is not Nick's statement
    const nickRuledOut = sideOf(brief as BriefView, "clm_01").ruledOut.map(
      (claim) => claim.id,
    );
    expect(nickRuledOut).not.toContain("clm_ra_foreign");
  });

  test("an unknown contradiction id answers 404, never an empty brief", async () => {
    // Arrange
    const { harness, nick } = await seedDeadlock();

    // Act + Assert
    const result = await fetchBrief(
      harness,
      nick.apiKey,
      "cx_00000000000000000000000000000000",
    );
    expect(result.status).toBe(404);
  });

  test("a superseded side retires the pair from the listing, but its brief says so instead of vanishing", async () => {
    // Arrange: capture the pair id, then Nick revises his hypothesis away
    const { harness, nick } = await seedDeadlock();
    const [candidate] = await listCandidates(harness, nick.apiKey);
    const pairId = candidate?.id ?? "";
    await postRecords(harness, nick, {
      records: [
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_revised",
            kind: "hypothesis",
            status: "proposed",
            body: "The rotation job deadlocks on the metadata lock instead",
          }),
        ),
        recordEnvelope(
          "claim_edge",
          validClaimEdgeBody({
            id: "edge_supersede",
            fromClaimId: "clm_revised",
            toClaimId: "clm_01",
            kind: "supersedes",
          }),
        ),
      ],
    });

    // Act
    const listed = await listCandidates(harness, nick.apiKey);
    const { status, brief } = await fetchBrief(harness, nick.apiKey, pairId);

    // Assert: the listing no longer offers the retired pair …
    const listedClaimIds = listed.flatMap((entry) => [
      entry.claimA.id,
      entry.claimB.id,
    ]);
    expect(listedClaimIds).not.toContain("clm_01");
    // … but the brief still resolves and says the deadlock may be over
    expect(status).toBe(200);
    expect(sideOf(brief as BriefView, "clm_01").supersededByClaimId).toBe(
      "clm_revised",
    );
  });

  test("a same-context pair never bills the context's own targets as shared ground", async () => {
    // Arrange: the similarity gate deliberately flags a developer against
    // their own history, so a stored pair can have BOTH sides in one work
    // context (same developer, different kinds, opposite statuses). Joining
    // that context's targets against themselves would present every one of
    // them as jointly-held "shared ground" — there is no second context to
    // share anything with.
    const harness = await createTestHarness({ embedder: createFakeEmbedder() });
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    await registerTestSession(harness, nick.apiKey);
    await postRecords(harness, nick, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope("target", {
          workContextId: "wc_01",
          kind: "error_fingerprint",
          value: FINGERPRINT,
        }),
        recordEnvelope("target", {
          workContextId: "wc_01",
          kind: "file",
          value: "src/auth/rotate.ts",
        }),
        recordEnvelope(
          "claim",
          validClaimBody({
            kind: "hypothesis",
            status: "rejected",
            body: "Login endpoint returns 500 after a token refresh",
          }),
        ),
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_03",
            kind: "root_cause",
            status: "partially_confirmed",
            body: "The signin flow answers HTTP 500 following refresh",
          }),
        ),
      ],
    });
    const [candidate] = await listCandidates(harness, nick.apiKey);
    expect(candidate?.id).toMatch(PAIR_ID_PATTERN);

    // Act
    const { brief } = await fetchBrief(harness, nick.apiKey, candidate?.id ?? "");

    // Assert
    expect(brief?.sharedTargets).toEqual([]);
    expect(brief?.sharedTargetsTruncated).toBe(false);
  });

  test("a pair the live listing shows resolves, however many retired pairs exist", async () => {
    // Arrange: one LIVE pair whose open claim is the oldest, buried behind a
    // full candidate pool of NEWER retired pairs. The live listing excludes
    // the retired ones and shows the pair — so its id must resolve; a
    // resolution pool that re-admits retired pairs under the same cap would
    // evict it and 404 an id the reader is looking at.
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    await registerTestSession(harness, nick.apiKey);
    const robin = await addTestDeveloperWithSession(
      harness,
      "Robin",
      "robin@example.com",
      { id: SECOND_SESSION_ID },
    );
    const retiredIds = Array.from(
      { length: CONTRADICTIONS_MAX_LIMIT },
      (_, i) => `clm_r${String(i).padStart(3, "0")}`,
    );
    await postRecords(harness, nick, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope("target", {
          workContextId: "wc_01",
          kind: "error_fingerprint",
          value: FINGERPRINT,
        }),
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_live",
            kind: "hypothesis",
            status: "proposed",
            body: "The rotation job overruns its window and drops the key",
            createdAt: "2026-07-20T09:00:00.000Z",
          }),
        ),
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_rev",
            kind: "observation",
            body: "Revision that retired every abandoned theory below",
          }),
        ),
      ],
    });
    const retiredClaims = retiredIds.map((id, index) =>
      recordEnvelope(
        "claim",
        validClaimBody({
          id,
          kind: "hypothesis",
          status: "proposed",
          body: `Abandoned theory ${String(index)} about the same failure`,
          createdAt: "2026-07-25T09:00:00.000Z",
        }),
      ),
    );
    const supersedeEdges = retiredIds.map((id, index) =>
      recordEnvelope(
        "claim_edge",
        validClaimEdgeBody({
          id: `edge_r${String(index).padStart(3, "0")}`,
          fromClaimId: "clm_rev",
          toClaimId: id,
          kind: "supersedes",
        }),
      ),
    );
    const INGEST_CHUNK = 100;
    for (const batch of [retiredClaims, supersedeEdges]) {
      for (let at = 0; at < batch.length; at += INGEST_CHUNK) {
        await postRecords(harness, nick, {
          records: batch.slice(at, at + INGEST_CHUNK),
        });
      }
    }
    await postRecords(harness, robin, {
      records: [
        recordEnvelope(
          "work_context",
          validWorkContextBody({
            id: "wc_02",
            sessionId: SECOND_SESSION_ID,
            title: "Key rotation timing audit",
          }),
          { sessionId: SECOND_SESSION_ID },
        ),
        recordEnvelope(
          "target",
          {
            workContextId: "wc_02",
            kind: "error_fingerprint",
            value: FINGERPRINT,
          },
          { sessionId: SECOND_SESSION_ID },
        ),
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_02",
            workContextId: "wc_02",
            authorSessionId: SECOND_SESSION_ID,
            kind: "hypothesis",
            status: "rejected",
            body: "Rotation finished inside its window on every sampled failure",
          }),
          { sessionId: SECOND_SESSION_ID },
        ),
      ],
    });

    // Act
    const listed = await listCandidates(harness, nick.apiKey);
    const { status } = await fetchBrief(harness, nick.apiKey, listed[0]?.id ?? "");

    // Assert: the one live pair is listed, and the id it shows resolves
    expect(listed.length).toBe(1);
    expect(listed[0]?.claimA.id === "clm_live" || listed[0]?.claimB.id === "clm_live").toBe(true);
    expect(status).toBe(200);
  });

  test("evidence is capped per side and the cap is reported, not silent", async () => {
    // Arrange: one open claim citing more refs than the per-side bound
    const overCap = REFEREE_MAX_EVIDENCE_PER_SIDE + 1;
    const refIds = Array.from({ length: overCap }, (_, i) => `clm_ref_${i}`);
    const { harness, nick } = await seedEvidenceRefsPair(refIds, refIds);
    const [candidate] = await listCandidates(harness, nick.apiKey);

    // Act
    const { brief } = await fetchBrief(harness, nick.apiKey, candidate?.id ?? "");

    // Assert
    const side = sideOf(brief as BriefView, "clm_01");
    expect(side.evidence.length).toBe(REFEREE_MAX_EVIDENCE_PER_SIDE);
    expect(side.evidenceTruncated).toBe(true);
  });

  test("a ref that never arrived cannot mask the truncation of live evidence", async () => {
    // Arrange: a dead ref AHEAD of more live refs than the per-side bound.
    // The dead id spends a slot of the bounded load window, so a live claim
    // past the window is dropped — the flag must still say so (DESIGN.md §5:
    // referenced claims may arrive later, so dead refs are a designed state).
    const liveIds = Array.from(
      { length: REFEREE_MAX_EVIDENCE_PER_SIDE + 1 },
      (_, i) => `clm_ref_${i}`,
    );
    const { harness, nick } = await seedEvidenceRefsPair(
      ["clm_never_arrived", ...liveIds],
      liveIds,
    );
    const [candidate] = await listCandidates(harness, nick.apiKey);

    // Act
    const { brief } = await fetchBrief(harness, nick.apiKey, candidate?.id ?? "");

    // Assert: fewer live claims shown than cited — never reported as whole
    const side = sideOf(brief as BriefView, "clm_01");
    expect(side.evidence.length).toBe(REFEREE_MAX_EVIDENCE_PER_SIDE);
    expect(side.evidenceTruncated).toBe(true);
  });

  test("dead refs alone claim no truncation while every live claim is shown", async () => {
    // Arrange: a dead ref plus fewer live refs than the bound — everything
    // resolvable fits, so the honest flag is false
    const liveIds = Array.from(
      { length: REFEREE_MAX_EVIDENCE_PER_SIDE - 1 },
      (_, i) => `clm_ref_${i}`,
    );
    const { harness, nick } = await seedEvidenceRefsPair(
      ["clm_never_arrived", ...liveIds],
      liveIds,
    );
    const [candidate] = await listCandidates(harness, nick.apiKey);

    // Act
    const { brief } = await fetchBrief(harness, nick.apiKey, candidate?.id ?? "");

    // Assert
    const side = sideOf(brief as BriefView, "clm_01");
    expect(side.evidence.length).toBe(liveIds.length);
    expect(side.evidenceTruncated).toBe(false);
  });
});
