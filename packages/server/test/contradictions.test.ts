/**
 * GET /api/contradictions — diagnostic conflicts for briefings (DESIGN.md §3).
 *
 * Two sources behind one endpoint:
 *
 *   DERIVED, deterministic, keyless: two work contexts share a target (an
 *   error fingerprint is the strongest form) and hold theory claims with
 *   OPPOSITE status — one side still open, the other rejected. Recomputed
 *   fresh per read, so a target that arrives after both claims still forms
 *   the pair, with no ingest-order dependence.
 *
 *   STORED, similarity-detected: rows the ingest gate wrote while an embedder
 *   was configured (similarity-gate.test.ts proves the writing half).
 *
 * The keyless install must get the deterministic tier in full — asserted
 * here first-class, on a harness with no embedder at all.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import {
  addTestDeveloperWithSession,
  createTestHarness,
  createTestDeveloper,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validClaimBody,
  validWorkContextBody,
} from "./helpers.ts";
import type { TestHarness, TestDeveloper } from "./helpers.ts";
import { contradictionIdFor } from "../src/services/contradictions.ts";
import { createFakeEmbedder } from "./fixtures/fake-embedder.ts";

const SECOND_SESSION_ID = "ses_02";
const FINGERPRINT = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

interface CandidateSide {
  readonly id: string;
  readonly workContextId: string;
  readonly kind: string;
  readonly status: string;
  readonly body: string;
}

interface CandidateView {
  readonly claimA: CandidateSide;
  readonly claimB: CandidateSide;
  readonly reason: string;
  readonly similarity: number | null;
}

const fetchContradictions = async (
  harness: TestHarness,
  apiKey: string | null,
  params: Record<string, string> = {},
): Promise<{ status: number; candidates: readonly CandidateView[] }> => {
  const query = new URLSearchParams(params).toString();
  const response = await harness.app.request(
    `/api/contradictions${query.length > 0 ? `?${query}` : ""}`,
    jsonRequest("GET", apiKey),
  );
  if (response.status !== 200) {
    return { status: response.status, candidates: [] };
  }
  const body = (await response.json()) as {
    data: { candidates: CandidateView[] };
  };
  return { status: response.status, candidates: body.data.candidates };
};

interface TwoContextSetup {
  readonly harness: TestHarness;
  readonly nick: TestDeveloper;
  readonly robin: TestDeveloper;
}

/**
 * Nick's wc_01 and Robin's wc_02 sharing one error fingerprint, each holding
 * one hypothesis — statuses supplied per test, extra claim fields (provenance,
 * captureMode, confidence) per side where a test needs them.
 */
const seedSharedFingerprint = async (
  statusA: string,
  statusB: string,
  kindB: string = "hypothesis",
  claimOverridesA: Record<string, unknown> = {},
  claimOverridesB: Record<string, unknown> = {},
): Promise<TwoContextSetup> => {
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
          status: statusA,
          body: "The rotation job overruns its window and drops the key",
          ...claimOverridesA,
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
          kind: kindB,
          status: statusB,
          body: "Rotation finished inside its window on every sampled failure",
          ...claimOverridesB,
        }),
        { sessionId: SECOND_SESSION_ID },
      ),
    ],
  });
  return { harness, nick, robin };
};

/** A Tier-1 summarizer draft's trust fields — machine-minted, never vouched. */
const DERIVED_DRAFT_FIELDS = {
  captureMode: "auto",
  provenance: "derived",
  confidence: 0.4,
} as const;

describe("GET /api/contradictions", () => {
  test("requires an api key like every other route", async () => {
    // Arrange
    const harness = await createTestHarness();

    // Act + Assert
    const result = await fetchContradictions(harness, null);
    expect(result.status).toBe(401);
  });

  test("derives a candidate from a shared fingerprint and opposite statuses — keyless", async () => {
    // Arrange: NO embedder anywhere in this harness
    const { harness, nick } = await seedSharedFingerprint(
      "proposed",
      "rejected",
    );

    // Act
    const result = await fetchContradictions(harness, nick.apiKey);

    // Assert
    expect(result.status).toBe(200);
    expect(result.candidates.length).toBe(1);
    const candidate = result.candidates[0];
    expect(candidate?.reason).toBe("shared_target");
    expect(candidate?.similarity).toBeNull();
    const statuses = [
      candidate?.claimA.status,
      candidate?.claimB.status,
    ].sort();
    expect(statuses).toEqual(["proposed", "rejected"]);
    const ids = [candidate?.claimA.id, candidate?.claimB.id].sort();
    expect(ids).toEqual(["clm_01", "clm_02"]);
  });

  test("same-status theories on a shared fingerprint are parallel work, not a conflict", async () => {
    // Arrange
    const { harness, nick } = await seedSharedFingerprint(
      "proposed",
      "proposed",
    );

    // Act + Assert
    const result = await fetchContradictions(harness, nick.apiKey);
    expect(result.candidates).toEqual([]);
  });

  test("only theory kinds form candidates — an observation cannot contradict", async () => {
    // Arrange: same statuses as the positive case, but side B is an
    // observation; status semantics belong to hypotheses and root causes
    const { harness, nick } = await seedSharedFingerprint(
      "proposed",
      "rejected",
      "observation",
    );

    // Act + Assert
    const result = await fetchContradictions(harness, nick.apiKey);
    expect(result.candidates).toEqual([]);
  });

  test("repo filters candidates to those touching the repo", async () => {
    // Arrange: both contexts live in VALID_SESSION_BODY.repo
    const { harness, nick } = await seedSharedFingerprint(
      "proposed",
      "rejected",
    );

    // Act
    const matching = await fetchContradictions(harness, nick.apiKey, {
      repo: "github.com/acme/api",
    });
    const foreign = await fetchContradictions(harness, nick.apiKey, {
      repo: "github.com/acme/web",
    });

    // Assert
    expect(matching.candidates.length).toBe(1);
    expect(foreign.candidates).toEqual([]);
  });

  test("similarity-detected candidates from the ingest gate appear too", async () => {
    // Arrange: an embedder harness where the gate stores the candidate
    // (the writing half is pinned by similarity-gate.test.ts)
    const harness = await createTestHarness({ embedder: createFakeEmbedder() });
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    await registerTestSession(harness, nick.apiKey);
    await postRecords(harness, nick, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope(
          "claim",
          validClaimBody({
            kind: "hypothesis",
            status: "rejected",
            body: "Login endpoint returns 500 after a token refresh",
          }),
        ),
        recordEnvelope(
          "work_context",
          validWorkContextBody({ id: "wc_02", title: "Signin flow audit" }),
        ),
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_02",
            workContextId: "wc_02",
            kind: "hypothesis",
            status: "partially_confirmed",
            body: "The signin flow answers HTTP 500 following refresh",
          }),
        ),
      ],
    });

    // Act
    const result = await fetchContradictions(harness, nick.apiKey);

    // Assert
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0]?.reason).toBe("similarity");
    expect(result.candidates[0]?.similarity ?? 0).toBeGreaterThan(0.93);
  });

  test("one developer's own opposite-status theories are not a derived conflict", async () => {
    // Arrange: Nick alone holds proposed in wc_01 and rejected in wc_02 on a
    // shared fingerprint — that is one person's investigation evolving (the
    // formal channel for it is a supersedes edge), not a teammate deadlock
    const harness = await createTestHarness();
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
        recordEnvelope(
          "claim",
          validClaimBody({
            kind: "hypothesis",
            status: "proposed",
            body: "The rotation job overruns its window and drops the key",
          }),
        ),
        recordEnvelope(
          "work_context",
          validWorkContextBody({ id: "wc_02", title: "Second look" }),
        ),
        recordEnvelope("target", {
          workContextId: "wc_02",
          kind: "error_fingerprint",
          value: FINGERPRINT,
        }),
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_02",
            workContextId: "wc_02",
            kind: "hypothesis",
            status: "rejected",
            body: "Rotation finished inside its window on every sampled failure",
          }),
        ),
      ],
    });

    // Act + Assert
    const result = await fetchContradictions(harness, nick.apiKey);
    expect(result.candidates).toEqual([]);
  });

  test("an unreviewed derived draft cannot hold the open side of a deadlock", async () => {
    // Arrange: Nick's open theory is a Tier-1 summarizer draft — nobody ever
    // vouched for it. A briefing pointer built from this pair would tell Robin
    // that Nick HOLDS a conflicting position Nick never authored (DESIGN.md §3
    // Tier 1: drafts are never proactively injected to teammates).
    const { harness, nick } = await seedSharedFingerprint(
      "proposed",
      "rejected",
      "hypothesis",
      DERIVED_DRAFT_FIELDS,
    );

    // Act + Assert: no manufactured conflict from a machine guess
    const result = await fetchContradictions(harness, nick.apiKey);
    expect(result.candidates).toEqual([]);
  });

  test("a derived discard revision cannot hold the rejected side either", async () => {
    // Arrange: the rejected side is a derived draft's discard revision —
    // provenance stays derived on discard because nobody vouched for the
    // content, so it cannot anchor a deadlock any more than the open form
    const { harness, nick } = await seedSharedFingerprint(
      "proposed",
      "rejected",
      "hypothesis",
      {},
      DERIVED_DRAFT_FIELDS,
    );

    // Act + Assert
    const result = await fetchContradictions(harness, nick.apiKey);
    expect(result.candidates).toEqual([]);
  });

  test("a stored candidate row naming a derived claim leaves the listing", async () => {
    // Arrange: a contradiction_candidates row that references a derived draft
    // — written before the exclusion existed, or by an older hub. The listing
    // must filter it even though the row is already on disk.
    const { harness, nick } = await seedSharedFingerprint(
      "proposed",
      "rejected",
      "hypothesis",
      DERIVED_DRAFT_FIELDS,
    );
    await harness.db.execute(
      sql`INSERT INTO contradiction_candidates (id, claim_a_id, claim_b_id, similarity, created_at)
          VALUES ('ccd_stored_derived', 'clm_01', 'clm_02', 0.99, NOW())`,
    );

    // Act + Assert: neither the stored source nor the derived one lists it
    const result = await fetchContradictions(harness, nick.apiKey);
    expect(result.candidates).toEqual([]);
  });

  test("pair ids of claims carrying a colon cannot collide", () => {
    // Arrange: claim ids have no charset restriction (schema nonEmptyId), so
    // a join delimiter that can appear IN an id is not injective —
    // ("x","y:z") and ("x:y","z") must never share a pair id
    const first = contradictionIdFor("x", "y:z");
    const second = contradictionIdFor("x:y", "z");

    // Assert
    expect(first).not.toBe(second);
  });

  test("two distinct pairs whose ids join ambiguously both stay listed", async () => {
    // Arrange: pair (x, y:z) on FP1 and pair (x:y, z) on FP2 — under a
    // colon-joined pair key both collapse to "x:y:z" and the listing dedup
    // silently drops one real deadlock
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    await registerTestSession(harness, nick.apiKey);
    const robin = await addTestDeveloperWithSession(
      harness,
      "Robin",
      "robin@example.com",
      { id: SECOND_SESSION_ID },
    );
    const secondFingerprint = "ffffc3d4e5f60718293a4b5c6d7e8f90";
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
            id: "x",
            kind: "hypothesis",
            status: "proposed",
            body: "The rotation job overruns its window and drops the key",
          }),
        ),
        recordEnvelope(
          "work_context",
          validWorkContextBody({ id: "wc_03", title: "Cache stampede" }),
        ),
        recordEnvelope("target", {
          workContextId: "wc_03",
          kind: "error_fingerprint",
          value: secondFingerprint,
        }),
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "x:y",
            workContextId: "wc_03",
            kind: "hypothesis",
            status: "proposed",
            body: "The cache warms twice and stampedes the origin",
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
            id: "y:z",
            workContextId: "wc_02",
            authorSessionId: SECOND_SESSION_ID,
            kind: "hypothesis",
            status: "rejected",
            body: "Rotation finished inside its window on every sampled failure",
          }),
          { sessionId: SECOND_SESSION_ID },
        ),
        recordEnvelope(
          "work_context",
          validWorkContextBody({
            id: "wc_04",
            sessionId: SECOND_SESSION_ID,
            title: "Origin load audit",
          }),
          { sessionId: SECOND_SESSION_ID },
        ),
        recordEnvelope(
          "target",
          {
            workContextId: "wc_04",
            kind: "error_fingerprint",
            value: secondFingerprint,
          },
          { sessionId: SECOND_SESSION_ID },
        ),
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "z",
            workContextId: "wc_04",
            authorSessionId: SECOND_SESSION_ID,
            kind: "hypothesis",
            status: "rejected",
            body: "Origin load stayed flat through every stampede window",
          }),
          { sessionId: SECOND_SESSION_ID },
        ),
      ],
    });

    // Act
    const result = await fetchContradictions(harness, nick.apiKey);

    // Assert: both real pairs listed, under distinct ids
    expect(result.candidates.length).toBe(2);
    const ids = result.candidates.map((candidate) =>
      [candidate.claimA.id, candidate.claimB.id].sort().join("|"),
    );
    expect([...ids].sort()).toEqual(["x:y|z", "x|y:z"]);
  });

  test("derived candidates order newest open side first, ids breaking ties", async () => {
    // Arrange: two open theories against one rejection — the NEWER open
    // claim ingested last AND sorting last by id, so both physical scan order
    // and an incidental DISTINCT sort would list the older pair first. Which
    // pairs survive a limit (and which cx_ ids stay resolvable) must not be
    // query-plan luck.
    const { harness, nick } = await seedSharedFingerprint(
      "proposed",
      "rejected",
    );
    await postRecords(harness, nick, {
      records: [
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_zz_newer",
            kind: "hypothesis",
            status: "proposed",
            body: "The rotation lease is lost to a second claimant",
            createdAt: "2026-07-25T09:00:00.000Z",
          }),
        ),
      ],
    });

    // Act
    const result = await fetchContradictions(harness, nick.apiKey);

    // Assert: (clm_zz_newer, clm_02) precedes the older (clm_01, clm_02)
    const openSides = result.candidates.map((candidate) =>
      [candidate.claimA.id, candidate.claimB.id].filter((id) => id !== "clm_02"),
    );
    expect(openSides).toEqual([["clm_zz_newer"], ["clm_01"]]);
  });

  test("the derived join is backed by a (kind, value) index on targets", async () => {
    // Arrange: the derived-candidates join matches targets on (kind, value)
    // with the leading PK column unconstrained — without this index every
    // read of the endpoint scans and sorts the whole targets table twice.
    const harness = await createTestHarness();

    // Act
    const rows = await harness.db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE tablename = 'work_context_targets'`,
    );

    // Assert
    const names = rows.rows.map((row) => (row as { indexname: string }).indexname);
    expect(names).toContain("work_context_targets_kind_value_idx");
  });
});
