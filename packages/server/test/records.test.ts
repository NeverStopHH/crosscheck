import { describe, expect, test } from "bun:test";

import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  createTestDeveloper,
  fetchEvents,
  jsonRequest,
  postRecords,
  recordEnvelope,
  TEST_START_ISO,
  validClaimBody,
  validClaimEdgeBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const SECOND_SESSION_ID = "ses_02";

const readDedupCount = async (
  harness: TestHarness,
  developer: TestDeveloper,
  claimId: string,
): Promise<number | undefined> => {
  const response = await harness.app.request(
    `/api/work-contexts/${WORK_CONTEXT_ID}/diagnosis`,
    jsonRequest("GET", developer.apiKey),
  );
  const body = (await response.json()) as {
    data: { claims: { id: string; dedupCount: number }[] };
  };
  return body.data.claims.find((claim) => claim.id === claimId)?.dedupCount;
};

interface CrossAuthorSetup {
  readonly harness: TestHarness;
  readonly developer: TestDeveloper;
  readonly second: TestDeveloper;
}

/** Nick's wc_01 + clm_01, plus Robin's own session and claim clm_robin. */
const seedCrossAuthorClaims = async (): Promise<CrossAuthorSetup> => {
  const { harness, developer } = await createHarnessWithSession();
  await postRecords(harness, developer, {
    records: [
      recordEnvelope("work_context", validWorkContextBody()),
      recordEnvelope("claim", validClaimBody()),
    ],
  });
  const second = await addTestDeveloperWithSession(
    harness,
    "Robin",
    "robin@example.com",
    { id: SECOND_SESSION_ID },
  );
  await postRecords(
    harness,
    second,
    recordEnvelope(
      "claim",
      validClaimBody({
        id: "clm_robin",
        authorSessionId: SECOND_SESSION_ID,
        body: "The refresh path drops the rotated signing key",
      }),
      { sessionId: SECOND_SESSION_ID },
    ),
  );
  return { harness, developer, second };
};

const crossAuthorEdgeEnvelope = (
  kind: string,
): Record<string, unknown> =>
  recordEnvelope(
    "claim_edge",
    validClaimEdgeBody({
      fromClaimId: "clm_robin",
      toClaimId: "clm_01",
      kind,
      authorSessionId: SECOND_SESSION_ID,
    }),
    { sessionId: SECOND_SESSION_ID },
  );

describe("POST /api/records", () => {
  test("ingests a full batch in order: context, targets, claims, edge", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();
    const batch = {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope("target", {
          workContextId: WORK_CONTEXT_ID,
          kind: "file",
          value: "src/auth/jwt.ts",
        }),
        recordEnvelope("target", {
          workContextId: WORK_CONTEXT_ID,
          kind: "symbol",
          value: "validateJwt",
        }),
        recordEnvelope("claim", validClaimBody()),
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_02",
            kind: "evidence",
            body: "Refresh flow reuses the stale signing key",
          }),
        ),
        recordEnvelope("claim_edge", validClaimEdgeBody()),
      ],
    };

    // Act
    const { status, data } = await postRecords(harness, developer, batch);

    // Assert
    expect(status).toBe(200);
    expect(data?.results.map((result) => result.status)).toEqual([
      "accepted",
      "accepted",
      "accepted",
      "accepted",
      "accepted",
      "accepted",
    ]);
    expect(data?.results.map((result) => result.index)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(data?.accepted).toBe(6);
    expect(data?.duplicates).toBe(0);
    expect(data?.ignored).toBe(0);
    expect(data?.rejected).toBe(0);

    const events = await fetchEvents(harness, developer.apiKey);
    const ingestKinds = events
      .map((event) => event.kind)
      .filter(
        (kind) => kind.startsWith("work_context") || kind.startsWith("claim"),
      );
    expect(ingestKinds).toEqual([
      "work_context_created",
      "claim_added",
      "claim_added",
      "claim_edge_added",
    ]);
  });

  test("accepts a single bare envelope as a batch of one", async () => {
    const { harness, developer } = await createHarnessWithSession();

    const { status, data } = await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );

    expect(status).toBe(200);
    expect(data?.results).toHaveLength(1);
    expect(data?.results[0]?.status).toBe("accepted");
    expect(data?.results[0]?.id).toBe(WORK_CONTEXT_ID);
  });

  test("returns 401 without an api key", async () => {
    const { harness } = await createHarnessWithSession();

    const { status } = await postRecords(
      harness,
      null,
      recordEnvelope("work_context", validWorkContextBody()),
    );

    expect(status).toBe(401);
  });

  test("rejects records whose producer session belongs to another developer", async () => {
    // Arrange: Nick owns the registered session, Robin sends with Nick's session id
    const { harness } = await createHarnessWithSession();
    const intruder = await createTestDeveloper(harness, "Robin", "robin@example.com");

    // Act
    const { status, data } = await postRecords(
      harness,
      intruder,
      recordEnvelope("work_context", validWorkContextBody()),
    );

    // Assert
    expect(status).toBe(200);
    expect(data?.results[0]?.status).toBe("rejected");
    expect(data?.results[0]?.issues?.join(" ")).toContain("another developer");
  });

  test("rejects records from an ended producer session", async () => {
    const { harness, developer } = await createHarnessWithSession();
    await harness.app.request(
      `/api/sessions/${VALID_SESSION_BODY.id}/end`,
      jsonRequest("POST", developer.apiKey, {}),
    );

    const { data } = await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );

    expect(data?.results[0]?.status).toBe("rejected");
    expect(data?.results[0]?.issues?.join(" ")).toContain("ended");
  });

  test("ignores unknown record kinds for forward compatibility", async () => {
    const { harness, developer } = await createHarnessWithSession();

    const { data } = await postRecords(
      harness,
      developer,
      recordEnvelope("telemetry_blob", { anything: true }),
    );

    expect(data?.results[0]?.status).toBe("ignored");
    expect(data?.ignored).toBe(1);
    expect(data?.rejected).toBe(0);
  });

  test("ignores session and hint kinds with an explanatory issue", async () => {
    const { harness, developer } = await createHarnessWithSession();
    const sessionBody = {
      id: "ses_wire",
      developerId: developer.developerId,
      agentKind: "claude-code",
      repo: VALID_SESSION_BODY.repo,
      branch: "feat/x",
      baseCommit: "deadbeef",
      status: "analyzing",
      startedAt: TEST_START_ISO,
    };
    const hintBody = {
      id: "hint_01",
      receiverSessionId: VALID_SESSION_BODY.id,
      refKind: "claim",
      refId: "clm_01",
      renderedText: "Robin rejected the cache theory 2h ago.",
      trust: { authorName: "Robin", ageSeconds: 7200 },
      deliveredAt: TEST_START_ISO,
    };

    const { data } = await postRecords(harness, developer, {
      records: [
        recordEnvelope("session", sessionBody),
        recordEnvelope("hint", hintBody),
      ],
    });

    expect(data?.results.map((result) => result.status)).toEqual([
      "ignored",
      "ignored",
    ]);
    expect(data?.results[0]?.issues?.join(" ")).toContain("/api/sessions");
    expect(data?.results[1]?.issues?.join(" ")).toContain("server-emitted");
  });

  test("rejects a malformed envelope with issues", async () => {
    const { harness, developer } = await createHarnessWithSession();

    const { data } = await postRecords(harness, developer, {
      records: [{ cx: "0.1", kind: "claim", body: validClaimBody() }],
    });

    expect(data?.results[0]?.status).toBe("rejected");
    expect(data?.results[0]?.issues?.length).toBeGreaterThan(0);
  });

  test("rejects a claim body over 400 chars via schema issues", async () => {
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );

    const { data } = await postRecords(
      harness,
      developer,
      recordEnvelope("claim", validClaimBody({ body: "x".repeat(401) })),
    );

    expect(data?.results[0]?.status).toBe("rejected");
    expect(data?.results[0]?.issues?.join(" ")).toContain("body");
  });

  test("rejects likely_root_cause without evidence refs", async () => {
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );

    const { data } = await postRecords(
      harness,
      developer,
      recordEnvelope(
        "claim",
        validClaimBody({ status: "likely_root_cause", evidenceRefs: [] }),
      ),
    );

    expect(data?.results[0]?.status).toBe("rejected");
    expect(data?.results[0]?.issues?.join(" ")).toContain("evidence");
  });

  test("dedups a re-sent claim body from the same developer", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope("claim", validClaimBody()),
      ],
    });

    // Act: same body modulo whitespace and case, different claim id
    const { data } = await postRecords(
      harness,
      developer,
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_resent",
          body: "  JWT   VALIDATION fails after token refresh ",
        }),
      ),
    );

    // Assert: duplicate against the existing claim, count bumped, no new event
    expect(data?.results[0]?.status).toBe("duplicate");
    expect(data?.results[0]?.id).toBe("clm_01");
    expect(data?.duplicates).toBe(1);

    const diagnosis = await harness.app.request(
      `/api/work-contexts/${WORK_CONTEXT_ID}/diagnosis`,
      jsonRequest("GET", developer.apiKey),
    );
    const body = (await diagnosis.json()) as {
      data: { claims: { id: string; dedupCount: number }[] };
    };
    expect(body.data.claims).toHaveLength(1);
    expect(body.data.claims[0]?.dedupCount).toBe(2);

    const events = await fetchEvents(harness, developer.apiKey);
    const claimAdds = events.filter((event) => event.kind === "claim_added");
    expect(claimAdds).toHaveLength(1);
  });

  test("a promotion revision is not deduplicated into the draft it supersedes", async () => {
    // Arrange: a Tier-1 draft — machine-derived, capped confidence (DESIGN.md §3)
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_draft",
            captureMode: "auto",
            provenance: "derived",
            confidence: 0.4,
          }),
        ),
      ],
    });

    // Act: the promotion — SAME body, provenance now declared, plus the
    // supersedes edge onto the draft, in one batch (append-only revision).
    const { data } = await postRecords(harness, developer, {
      records: [
        recordEnvelope("claim", validClaimBody({ id: "clm_promoted" })),
        recordEnvelope(
          "claim_edge",
          validClaimEdgeBody({
            id: "edge_promote",
            fromClaimId: "clm_promoted",
            toClaimId: "clm_draft",
            kind: "supersedes",
          }),
        ),
      ],
    });

    // Assert: dedup collapses re-observations, not provenance upgrades — a
    // declared restatement of a derived draft must mint its own row, or the
    // promotion loop cannot exist.
    expect(data?.results[0]?.status).toBe("accepted");
    expect(data?.results[0]?.id).toBe("clm_promoted");
    expect(data?.results[1]?.status).toBe("accepted");
  });

  test("a discard revision (status rejected) is not deduplicated into the draft", async () => {
    // Arrange: the same draft
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_draft",
            captureMode: "auto",
            provenance: "derived",
            confidence: 0.4,
          }),
        ),
      ],
    });

    // Act: discard — same body, same provenance, but status rejected, plus edge
    const { data } = await postRecords(harness, developer, {
      records: [
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_discard",
            captureMode: "auto",
            provenance: "derived",
            confidence: 0.4,
            status: "rejected",
          }),
        ),
        recordEnvelope(
          "claim_edge",
          validClaimEdgeBody({
            id: "edge_discard",
            fromClaimId: "clm_discard",
            toClaimId: "clm_draft",
            kind: "supersedes",
          }),
        ),
      ],
    });

    // Assert: a status-change revision is not a re-observation
    expect(data?.results[0]?.status).toBe("accepted");
    expect(data?.results[1]?.status).toBe("accepted");
  });

  test("does not dedup the same body from a different developer", async () => {
    // Arrange: Robin has his own session and extends Nick's work context
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope("claim", validClaimBody()),
      ],
    });
    const second = await addTestDeveloperWithSession(
      harness,
      "Robin",
      "robin@example.com",
      { id: SECOND_SESSION_ID },
    );

    // Act: identical body, same work context, different author developer
    const { data } = await postRecords(
      harness,
      second,
      recordEnvelope(
        "claim",
        validClaimBody({ id: "clm_robin", authorSessionId: SECOND_SESSION_ID }),
        { sessionId: SECOND_SESSION_ID },
      ),
    );

    // Assert: provenance is the product — no cross-author dedup
    expect(data?.results[0]?.status).toBe("accepted");
    expect(data?.results[0]?.id).toBe("clm_robin");

    const diagnosis = await harness.app.request(
      `/api/work-contexts/${WORK_CONTEXT_ID}/diagnosis`,
      jsonRequest("GET", developer.apiKey),
    );
    const body = (await diagnosis.json()) as { data: { claims: unknown[] } };
    expect(body.data.claims).toHaveLength(2);
  });

  test("rejects an edge whose claims do not exist", async () => {
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );

    const { data } = await postRecords(
      harness,
      developer,
      recordEnvelope("claim_edge", validClaimEdgeBody()),
    );

    expect(data?.results[0]?.status).toBe("rejected");
    expect(data?.results[0]?.issues?.join(" ")).toContain("not found");
  });

  test("reports a duplicate edge as duplicate", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope("claim", validClaimBody()),
        recordEnvelope(
          "claim",
          validClaimBody({ id: "clm_02", body: "A different supporting fact" }),
        ),
        recordEnvelope("claim_edge", validClaimEdgeBody()),
      ],
    });

    // Act: same (from, to, kind) under a fresh edge id
    const { data } = await postRecords(
      harness,
      developer,
      recordEnvelope("claim_edge", validClaimEdgeBody({ id: "edge_02" })),
    );

    // Assert
    expect(data?.results[0]?.status).toBe("duplicate");
    expect(data?.results[0]?.id).toBe("edge_01");
  });

  test("rejects a batch larger than the ingest cap with 422", async () => {
    const { harness, developer } = await createHarnessWithSession();
    const oversized = Array.from({ length: 101 }, () =>
      recordEnvelope("work_context", validWorkContextBody()),
    );

    const { status } = await postRecords(harness, developer, {
      records: oversized,
    });

    expect(status).toBe(422);
  });

  test("rejects a record with a spoofed producer developerId", async () => {
    const { harness, developer } = await createHarnessWithSession();

    const { data } = await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody(), {
        developerId: "dev_spoofed",
      }),
    );

    expect(data?.results[0]?.status).toBe("rejected");
    expect(data?.results[0]?.issues?.join(" ")).toContain(
      "producer.developerId",
    );
  });

  test("rejects a derived claim with confidence above the cap", async () => {
    const { harness, developer } = await createHarnessWithSession();

    const { data } = await postRecords(
      harness,
      developer,
      recordEnvelope(
        "claim",
        validClaimBody({ provenance: "derived", confidence: 0.9 }),
      ),
    );

    expect(data?.results[0]?.status).toBe("rejected");
    expect(data?.results[0]?.issues?.join(" ")).toContain("confidence");
  });

  test("does not bump dedupCount on a byte-identical claim replay", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();
    const claimEnvelope = recordEnvelope("claim", validClaimBody());
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        claimEnvelope,
      ],
    });

    // Act: exact spool replay — same claim id and body
    const replay = await postRecords(harness, developer, claimEnvelope);

    // Assert: retransmission, not a re-observation
    expect(replay.data?.results[0]?.status).toBe("duplicate");
    expect(replay.data?.results[0]?.id).toBe("clm_01");
    expect(await readDedupCount(harness, developer, "clm_01")).toBe(1);

    // Act: the same body under a fresh id is a re-observation
    const reobserved = await postRecords(
      harness,
      developer,
      recordEnvelope("claim", validClaimBody({ id: "clm_resent" })),
    );

    // Assert: now the count bumps
    expect(reobserved.data?.results[0]?.status).toBe("duplicate");
    expect(await readDedupCount(harness, developer, "clm_01")).toBe(2);
  });

  test("rejects a claim id already used by another developer", async () => {
    // Arrange: Nick owns clm_01, Robin has his own session
    const { harness, second } = await seedCrossAuthorClaims();

    // Act: Robin reuses Nick's claim id with a different body
    const { data } = await postRecords(
      harness,
      second,
      recordEnvelope(
        "claim",
        validClaimBody({
          authorSessionId: SECOND_SESSION_ID,
          body: "Cache invalidation misses the refresh path entirely",
        }),
        { sessionId: SECOND_SESSION_ID },
      ),
    );

    // Assert
    expect(data?.results[0]?.status).toBe("rejected");
    expect(data?.results[0]?.issues?.join(" ")).toContain(
      "claim id already used by another developer",
    );
  });

  test("rejects a cross-author supersedes edge", async () => {
    // Arrange: Robin's clm_robin and Nick's clm_01 in the same tree
    const { harness, second } = await seedCrossAuthorClaims();

    // Act: Robin tries to supersede Nick's claim
    const { data } = await postRecords(
      harness,
      second,
      crossAuthorEdgeEnvelope("supersedes"),
    );

    // Assert
    expect(data?.results[0]?.status).toBe("rejected");
    expect(data?.results[0]?.issues?.join(" ")).toContain(
      "supersedes requires ownership of both claims",
    );
  });

  test("accepts a cross-author contradicts edge", async () => {
    // Arrange
    const { harness, second } = await seedCrossAuthorClaims();

    // Act: cross-author disagreement is the product
    const { data } = await postRecords(
      harness,
      second,
      crossAuthorEdgeEnvelope("contradicts"),
    );

    // Assert
    expect(data?.results[0]?.status).toBe("accepted");
    expect(data?.results[0]?.id).toBe("edge_01");
  });

  test("rejects an edge id reused for a different triple", async () => {
    // Arrange: edge_01 already links clm_02 -> clm_01
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope("claim", validClaimBody()),
        recordEnvelope(
          "claim",
          validClaimBody({ id: "clm_02", body: "A different supporting fact" }),
        ),
        recordEnvelope(
          "claim",
          validClaimBody({ id: "clm_03", body: "A third supporting fact" }),
        ),
        recordEnvelope("claim_edge", validClaimEdgeBody()),
      ],
    });

    // Act: same edge id, different (from, to, kind) triple
    const { data } = await postRecords(
      harness,
      developer,
      recordEnvelope("claim_edge", validClaimEdgeBody({ fromClaimId: "clm_03" })),
    );

    // Assert
    expect(data?.results[0]?.status).toBe("rejected");
    expect(data?.results[0]?.issues?.join(" ")).toContain(
      "already used by a different edge",
    );
  });

  test("reports an exact edge replay as duplicate with its own id", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();
    const edgeEnvelope = recordEnvelope("claim_edge", validClaimEdgeBody());
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope("claim", validClaimBody()),
        recordEnvelope(
          "claim",
          validClaimBody({ id: "clm_02", body: "A different supporting fact" }),
        ),
        edgeEnvelope,
      ],
    });

    // Act
    const { data } = await postRecords(harness, developer, edgeEnvelope);

    // Assert
    expect(data?.results[0]?.status).toBe("duplicate");
    expect(data?.results[0]?.id).toBe("edge_01");
  });
});

/**
 * The intent MERGE rule (trial finding #16). Every registration re-sends a
 * work_context record WITHOUT an intent — SessionStart on `--resume`, the
 * mid-session recovery, Cursor's late registration — and on main that
 * record wiped the stored intent to null (`body.intent ?? null`).
 */
const DERIVED_INTENT = {
  summary: "Stop the login 500s after the JWKS key rotation",
  provenance: "derived",
  confidence: 0.4,
  capturedAt: TEST_START_ISO,
} as const;

const DECLARED_INTENT = {
  summary: "Make verifyToken refetch the JWKS on an unknown kid",
  provenance: "declared",
  confidence: 1,
  capturedAt: TEST_START_ISO,
} as const;

const readStoredIntent = async (
  harness: TestHarness,
  developer: TestDeveloper,
): Promise<Record<string, unknown> | null> => {
  const response = await harness.app.request(
    `/api/work-contexts/${WORK_CONTEXT_ID}/diagnosis`,
    jsonRequest("GET", developer.apiKey),
  );
  const body = (await response.json()) as {
    data: { workContext: { intent: Record<string, unknown> | null } };
  };
  return body.data.workContext.intent;
};

describe("work_context intent merge", () => {
  test("a later work_context record WITHOUT an intent keeps the stored one", async () => {
    // Arrange: registration, then the derived intent lands
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, recordEnvelope("work_context", validWorkContextBody()));
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody({ intent: DERIVED_INTENT })),
    );

    // Act: a SessionStart re-fire / recovery re-sends title + status only
    const replay = await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody({ status: "implementing" })),
    );

    // Assert: status replaced, intent NOT wiped
    expect(replay.data?.accepted).toBe(1);
    expect(await readStoredIntent(harness, developer)).toEqual(DERIVED_INTENT);
  });

  test("a derived intent never overwrites a declared one — a late spool replay cannot undo set_intent", async () => {
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody({ intent: DECLARED_INTENT })),
    );

    const late = await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody({ intent: DERIVED_INTENT })),
    );

    // The record carried nothing new once merged: a duplicate, not a rejection
    expect(late.data?.results[0]?.status).toBe("duplicate");
    expect(await readStoredIntent(harness, developer)).toEqual(DECLARED_INTENT);
  });

  test("a declared intent replaces a derived one, and a re-declaration supersedes", async () => {
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody({ intent: DERIVED_INTENT })),
    );

    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody({ intent: DECLARED_INTENT })),
    );
    expect(await readStoredIntent(harness, developer)).toEqual(DECLARED_INTENT);

    const redeclared = { ...DECLARED_INTENT, summary: "Rotate the JWKS cache every minute" };
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody({ intent: redeclared })),
    );
    expect(await readStoredIntent(harness, developer)).toEqual(redeclared);
  });

  test("a derived intent is replaced by a newer derived one (re-derivation)", async () => {
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody({ intent: DERIVED_INTENT })),
    );
    const newer = { ...DERIVED_INTENT, summary: "Find why verifyToken rejects rotated keys" };

    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody({ intent: newer })),
    );

    expect(await readStoredIntent(harness, developer)).toEqual(newer);
  });

  test("a derived intent above the cap rejects the record at the hub too", async () => {
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, recordEnvelope("work_context", validWorkContextBody()));

    const posted = await postRecords(
      harness,
      developer,
      recordEnvelope(
        "work_context",
        validWorkContextBody({ intent: { ...DERIVED_INTENT, confidence: 0.9 } }),
      ),
    );

    expect(posted.data?.results[0]?.status).toBe("rejected");
    expect(await readStoredIntent(harness, developer)).toBeNull();
  });

  test("the update event names the changed field, never the intent's text", async () => {
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, recordEnvelope("work_context", validWorkContextBody()));
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody({ intent: DERIVED_INTENT })),
    );

    const events = await fetchEvents(harness, developer.apiKey);
    const updated = events.find((event) => event.kind === "work_context_updated");

    expect(updated?.payload["changed"]).toEqual(["intent"]);
    expect(JSON.stringify(updated?.payload)).not.toContain(DERIVED_INTENT.summary);
  });
});
