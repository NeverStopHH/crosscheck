/**
 * The embedding half of the ingest gate (DESIGN.md §3).
 *
 * Only alive while an embedder is configured — the keyless install keeps the
 * deterministic gate (normalized-body equality) and nothing else, and that
 * degradation is asserted here first-class, not assumed.
 *
 * The rules under test, in gate order:
 *   - same developer + same work context + same kind, cosine > 0.93
 *     → NO new row; dedup_count bump + last_seen_at (a re-observation).
 *   - NEVER dedup across authors — provenance is the product. A near-duplicate
 *     from another developer stays a separate row and becomes a relates_to
 *     edge, authored by the INGESTING session, note "auto: similarity".
 *   - near-duplicate in another work context → keep both + relates_to edge.
 *   - near-duplicate with OPPOSITE status → contradiction candidate row
 *     instead of an edge (the §1 "diagnostic conflict" signal).
 */
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import {
  claimEdges,
  claims,
  contradictionCandidates,
} from "../src/db/schema.ts";
import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  createTestHarness,
  createTestDeveloper,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validClaimBody,
  validWorkContextBody,
} from "./helpers.ts";
import type { TestHarness, TestDeveloper } from "./helpers.ts";
import {
  createFakeEmbedder,
  createRecordingEmbedder,
} from "./fixtures/fake-embedder.ts";

const SECOND_SESSION_ID = "ses_02";

/** Same topic axis for the fake embedder, different normalized bodies. */
const LOGIN_OBSERVATION = "Login endpoint returns 500 after a token refresh";
const LOGIN_REWORDED = "The signin flow answers HTTP 500 following refresh";

/** A body on no topic axis — orthogonal to everything. */
const UNRELATED_BODY = "Parquet export drops the last row group";

interface GateHarness {
  readonly harness: TestHarness;
  readonly developer: TestDeveloper;
}

const createGateHarness = async (): Promise<GateHarness> => {
  const harness = await createTestHarness({ embedder: createFakeEmbedder() });
  const developer = await createTestDeveloper(
    harness,
    "Nick",
    "nick@example.com",
  );
  await registerTestSession(harness, developer.apiKey);
  await postRecords(
    harness,
    developer,
    recordEnvelope("work_context", validWorkContextBody()),
  );
  return { harness, developer };
};

const countClaims = async (harness: TestHarness): Promise<number> => {
  const rows = await harness.db.select({ id: claims.id }).from(claims);
  return rows.length;
};

describe("similarity dedup within one developer's context", () => {
  test("a reworded re-observation bumps dedup_count instead of inserting", async () => {
    // Arrange
    const { harness, developer } = await createGateHarness();
    await postRecords(
      harness,
      developer,
      recordEnvelope("claim", validClaimBody({ body: LOGIN_OBSERVATION })),
    );

    // Act: same developer, same context, same kind, different words
    const second = await postRecords(
      harness,
      developer,
      recordEnvelope(
        "claim",
        validClaimBody({ id: "clm_02", body: LOGIN_REWORDED }),
      ),
    );

    // Assert: reported as a duplicate OF THE FIRST CLAIM, and no second row
    expect(second.data?.duplicates).toBe(1);
    expect(second.data?.results[0]?.id).toBe("clm_01");
    expect(await countClaims(harness)).toBe(1);
    const rows = await harness.db
      .select({ dedupCount: claims.dedupCount, lastSeenAt: claims.lastSeenAt })
      .from(claims)
      .where(eq(claims.id, "clm_01"));
    expect(rows[0]?.dedupCount).toBe(2);
    expect(rows[0]?.lastSeenAt).not.toBeNull();
  });

  test("an unrelated claim in the same context is inserted, not deduped", async () => {
    // Arrange
    const { harness, developer } = await createGateHarness();
    await postRecords(
      harness,
      developer,
      recordEnvelope("claim", validClaimBody({ body: LOGIN_OBSERVATION })),
    );

    // Act
    const second = await postRecords(
      harness,
      developer,
      recordEnvelope(
        "claim",
        validClaimBody({ id: "clm_02", body: UNRELATED_BODY }),
      ),
    );

    // Assert
    expect(second.data?.accepted).toBe(1);
    expect(await countClaims(harness)).toBe(2);
  });

  test("keyless: the same rewording inserts a second row — first-class degradation", async () => {
    // Arrange: NO embedder — the default install. The deterministic gate
    // cannot see that two differently-worded bodies mean the same thing.
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );
    await postRecords(
      harness,
      developer,
      recordEnvelope("claim", validClaimBody({ body: LOGIN_OBSERVATION })),
    );

    // Act
    const second = await postRecords(
      harness,
      developer,
      recordEnvelope(
        "claim",
        validClaimBody({ id: "clm_02", body: LOGIN_REWORDED }),
      ),
    );

    // Assert
    expect(second.data?.accepted).toBe(1);
    expect(await countClaims(harness)).toBe(2);
  });
});

describe("never across authors", () => {
  test("another developer's near-duplicate stays a row and becomes a relates_to edge", async () => {
    // Arrange
    const { harness, developer } = await createGateHarness();
    await postRecords(
      harness,
      developer,
      recordEnvelope("claim", validClaimBody({ body: LOGIN_OBSERVATION })),
    );
    const robin = await addTestDeveloperWithSession(
      harness,
      "Robin",
      "robin@example.com",
      { id: SECOND_SESSION_ID },
    );

    // Act: Robin publishes a near-duplicate INTO Nick's context
    const posted = await postRecords(
      harness,
      robin,
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_robin",
          authorSessionId: SECOND_SESSION_ID,
          body: LOGIN_REWORDED,
        }),
        { sessionId: SECOND_SESSION_ID },
      ),
    );

    // Assert: both rows exist — never merged across authors
    expect(posted.data?.accepted).toBe(1);
    expect(await countClaims(harness)).toBe(2);

    // And the auto edge carries the ingesting session as author, with the note
    const edges = await harness.db.select().from(claimEdges);
    expect(edges.length).toBe(1);
    expect(edges[0]?.kind).toBe("relates_to");
    expect(edges[0]?.fromClaimId).toBe("clm_robin");
    expect(edges[0]?.toClaimId).toBe("clm_01");
    expect(edges[0]?.authorSessionId).toBe(SECOND_SESSION_ID);
    expect(edges[0]?.note).toBe("auto: similarity");
  });
});

describe("cross-context near-duplicates", () => {
  test("keeps both and links them with an auto relates_to edge", async () => {
    // Arrange: the same developer investigating the same symptom in a second
    // work context — the cross-session case of DESIGN.md §3
    const { harness, developer } = await createGateHarness();
    await postRecords(
      harness,
      developer,
      recordEnvelope("claim", validClaimBody({ body: LOGIN_OBSERVATION })),
    );
    await postRecords(
      harness,
      developer,
      recordEnvelope(
        "work_context",
        validWorkContextBody({ id: "wc_02", title: "Signin flow audit" }),
      ),
    );

    // Act
    await postRecords(
      harness,
      developer,
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_02",
          workContextId: "wc_02",
          body: LOGIN_REWORDED,
        }),
      ),
    );

    // Assert
    expect(await countClaims(harness)).toBe(2);
    const edges = await harness.db.select().from(claimEdges);
    expect(edges.length).toBe(1);
    expect(edges[0]?.kind).toBe("relates_to");
    expect(edges[0]?.note).toBe("auto: similarity");
  });

  test("opposite status yields a contradiction candidate instead of an edge", async () => {
    // Arrange: the same theory, already rejected in an older context — a
    // diagnostic conflict, not a relation
    const { harness, developer } = await createGateHarness();
    await postRecords(
      harness,
      developer,
      recordEnvelope(
        "claim",
        validClaimBody({
          kind: "hypothesis",
          status: "rejected",
          body: LOGIN_OBSERVATION,
        }),
      ),
    );
    await postRecords(
      harness,
      developer,
      recordEnvelope(
        "work_context",
        validWorkContextBody({ id: "wc_02", title: "Signin flow audit" }),
      ),
    );

    // Act
    await postRecords(
      harness,
      developer,
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_02",
          workContextId: "wc_02",
          kind: "hypothesis",
          status: "partially_confirmed",
          body: LOGIN_REWORDED,
        }),
      ),
    );

    // Assert: a candidate row, no auto edge
    const candidates = await harness.db.select().from(contradictionCandidates);
    expect(candidates.length).toBe(1);
    expect(candidates[0]?.similarity ?? 0).toBeGreaterThan(0.93);
    const pair = [candidates[0]?.claimAId, candidates[0]?.claimBId].sort();
    expect(pair).toEqual(["clm_01", "clm_02"]);
    expect(await harness.db.select().from(claimEdges)).toEqual([]);
  });

  test("a derived draft near a declared rejection relates, never deadlocks", async () => {
    // Arrange: a declared, rejected theory in an older context — then a
    // Tier-1 summarizer draft (provenance derived) restates it as open in a
    // fresh context. A machine guess nobody vouched for must not mint a
    // contradiction candidate (the briefing's proactive surface); the real
    // similarity is still recorded, as a pull-only relates_to edge.
    const { harness, developer } = await createGateHarness();
    await postRecords(
      harness,
      developer,
      recordEnvelope(
        "claim",
        validClaimBody({
          kind: "hypothesis",
          status: "rejected",
          body: LOGIN_OBSERVATION,
        }),
      ),
    );
    await postRecords(
      harness,
      developer,
      recordEnvelope(
        "work_context",
        validWorkContextBody({ id: "wc_02", title: "Signin flow audit" }),
      ),
    );

    // Act
    await postRecords(
      harness,
      developer,
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_02",
          workContextId: "wc_02",
          kind: "hypothesis",
          status: "proposed",
          captureMode: "auto",
          provenance: "derived",
          confidence: 0.4,
          body: LOGIN_REWORDED,
        }),
      ),
    );

    // Assert: no candidate row; one relates_to edge instead
    expect(await harness.db.select().from(contradictionCandidates)).toEqual([]);
    const edges = await harness.db.select().from(claimEdges);
    expect(edges.length).toBe(1);
    expect(edges[0]?.kind).toBe("relates_to");
  });

  test("a developer's own cross-kind contradiction in one context is flagged", async () => {
    // Arrange: same developer, same context — but different KINDS, so the
    // dedup gate (kind-scoped) never sees the pair. A rejected root cause and
    // a near-identical fresh hypothesis are exactly the "two contradictory
    // theories" signal, and DESIGN.md §3 restricts only MERGING across
    // authors, not flagging a developer against their own history.
    const { harness, developer } = await createGateHarness();
    await postRecords(
      harness,
      developer,
      recordEnvelope(
        "claim",
        validClaimBody({
          kind: "root_cause",
          status: "rejected",
          body: LOGIN_OBSERVATION,
        }),
      ),
    );

    // Act
    await postRecords(
      harness,
      developer,
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_02",
          kind: "hypothesis",
          status: "proposed",
          body: LOGIN_REWORDED,
        }),
      ),
    );

    // Assert: both rows (kinds differ — nothing to dedup), one candidate
    expect(await countClaims(harness)).toBe(2);
    const candidates = await harness.db.select().from(contradictionCandidates);
    expect(candidates.length).toBe(1);
    const pair = [candidates[0]?.claimAId, candidates[0]?.claimBId].sort();
    expect(pair).toEqual(["clm_01", "clm_02"]);
  });

  test("a spool replay of a stored claim never re-triggers gate work", async () => {
    // Arrange
    const { harness, developer } = await createGateHarness();
    await postRecords(
      harness,
      developer,
      recordEnvelope("claim", validClaimBody({ body: LOGIN_OBSERVATION })),
    );
    await postRecords(
      harness,
      developer,
      recordEnvelope(
        "work_context",
        validWorkContextBody({ id: "wc_02", title: "Signin flow audit" }),
      ),
    );

    // Act: replay of clm_01 — already stored
    const replay = await postRecords(
      harness,
      developer,
      recordEnvelope("claim", validClaimBody({ body: LOGIN_OBSERVATION })),
    );

    // Assert: no edges, no candidates, still one claim
    expect(replay.data?.duplicates).toBe(1);
    expect(await countClaims(harness)).toBe(1);
    expect(await harness.db.select().from(claimEdges)).toEqual([]);
    expect(await harness.db.select().from(contradictionCandidates)).toEqual([]);
  });
});

describe("gate scans are index-backed", () => {
  test("claims.embedding carries an hnsw cosine index", async () => {
    // Arrange: the cross-similarity probe is a nearest-neighbor over every
    // embedded claim, inside the ingest transaction on the single connection.
    // Without an ANN index that is a sequential scan per ingest — O(n²) for
    // the store as it grows.
    const { harness } = await createGateHarness();

    // Act
    const rows = await harness.db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE tablename = 'claims'`,
    );

    // Assert
    const names = rows.rows.map(
      (row) => (row as { indexname: string }).indexname,
    );
    expect(names).toContain("claims_embedding_hnsw_idx");
  });
});

describe("the 0.93 threshold is a boundary, not a suggestion", () => {
  test("cosine just above the threshold dedups", async () => {
    // Arrange: the fixture embeds a `neardup94` body at cosine 0.94 to the
    // login axis — barely inside the gate.
    const { harness, developer } = await createGateHarness();
    await postRecords(
      harness,
      developer,
      recordEnvelope("claim", validClaimBody({ body: LOGIN_OBSERVATION })),
    );

    // Act
    const second = await postRecords(
      harness,
      developer,
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_02",
          body: "neardup94 wording of the same re-observed failure",
        }),
      ),
    );

    // Assert
    expect(second.data?.duplicates).toBe(1);
    expect(await countClaims(harness)).toBe(1);
  });

  test("cosine just below the threshold stays a second row", async () => {
    // Arrange: `neardup92` embeds at cosine 0.92 — barely outside the gate.
    const { harness, developer } = await createGateHarness();
    await postRecords(
      harness,
      developer,
      recordEnvelope("claim", validClaimBody({ body: LOGIN_OBSERVATION })),
    );

    // Act
    const second = await postRecords(
      harness,
      developer,
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_02",
          body: "neardup92 wording of a merely similar observation",
        }),
      ),
    );

    // Assert
    expect(second.data?.accepted).toBe(1);
    expect(await countClaims(harness)).toBe(2);
  });
});

describe("embedding cost at the gate", () => {
  const claimEnvelope = (
    id: string,
    body: string,
  ): Record<string, unknown> =>
    recordEnvelope("claim", validClaimBody({ id, body }));

  test("a spool replay of a stored claim is classified without re-embedding", async () => {
    // Arrange: a slow provider must not be paid again for a claim the hub
    // already holds — replays are the NORMAL path when a flush times out.
    const embedder = createRecordingEmbedder();
    const harness = await createTestHarness({ embedder });
    const developer = await createTestDeveloper(
      harness,
      "Nick",
      "nick@example.com",
    );
    await registerTestSession(harness, developer.apiKey);
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );
    await postRecords(harness, developer, claimEnvelope("clm_01", LOGIN_OBSERVATION));
    const bodyEmbeds = (): number =>
      embedder.embeddedTexts.filter((text) => text === LOGIN_OBSERVATION).length;
    const afterFirst = bodyEmbeds();

    // Act: exact replay — same id, same body
    const replay = await postRecords(
      harness,
      developer,
      claimEnvelope("clm_01", LOGIN_OBSERVATION),
    );

    // Assert: classified as duplicate, body not embedded a second time
    expect(replay.data?.duplicates).toBe(1);
    expect(bodyEmbeds()).toBe(afterFirst);
  });

  test("a deterministic re-observation is deduped without embedding it", async () => {
    // Arrange
    const embedder = createRecordingEmbedder();
    const harness = await createTestHarness({ embedder });
    const developer = await createTestDeveloper(
      harness,
      "Nick",
      "nick@example.com",
    );
    await registerTestSession(harness, developer.apiKey);
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );
    await postRecords(harness, developer, claimEnvelope("clm_01", LOGIN_OBSERVATION));

    // Act: different id, same body up to whitespace/case normalization
    const rewrapped = LOGIN_OBSERVATION.toUpperCase();
    const second = await postRecords(
      harness,
      developer,
      claimEnvelope("clm_02", rewrapped),
    );

    // Assert: deduped by the deterministic gate, never sent to the embedder
    expect(second.data?.duplicates).toBe(1);
    expect(embedder.embeddedTexts).not.toContain(rewrapped);
  });

  test("a batch of claims embeds the context doc once, not per claim", async () => {
    // Arrange: the doc only matters in its final state — re-embedding it after
    // every claim in a flush is N−1 wasted provider calls and writes.
    const embedder = createRecordingEmbedder();
    const harness = await createTestHarness({ embedder });
    const developer = await createTestDeveloper(
      harness,
      "Nick",
      "nick@example.com",
    );
    await registerTestSession(harness, developer.apiKey);
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );
    // The doc always opens with the context title (normalized-doc.ts).
    const docEmbeds = (): number =>
      embedder.embeddedTexts.filter((text) =>
        text.startsWith("Login 500s on staging"),
      ).length;
    const beforeBatch = docEmbeds();

    // Act: one flush, three claims on distinct topic axes (nothing dedups)
    const posted = await postRecords(harness, developer, {
      records: [
        claimEnvelope("clm_a", LOGIN_OBSERVATION),
        claimEnvelope("clm_b", "Cache warm path drops entries on deploy"),
        claimEnvelope("clm_c", "Rate limit burst window is misconfigured"),
      ],
    });

    // Assert: all accepted, one doc embed for the whole flush
    expect(posted.data?.accepted).toBe(3);
    expect(docEmbeds() - beforeBatch).toBe(1);
  });
});
