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
import { eq } from "drizzle-orm";

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
import { createFakeEmbedder } from "./fixtures/fake-embedder.ts";

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
