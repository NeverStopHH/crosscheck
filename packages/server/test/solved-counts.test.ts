/**
 * `GET /api/solved-matches?counts=1` — the precision loop for solved
 * pointers (VISION.md §1, DESIGN.md §4 "telemetry from day one").
 *
 * The surface these numbers describe asserts that an old diagnosis is
 * relevant to work happening NOW, unasked. Without a reading of the delivery
 * ledger it could be wrong for months with every instrument green, which is
 * the finding-#14 shape. So the questions here are the two a tired human
 * asks at 23:00: how many of these did it show me, and did I ever open one.
 */
import { describe, expect, test } from "bun:test";

import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  TEST_START_ISO,
  validClaimBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
const SESSION = VALID_SESSION_BODY.id;
const SOLVED_ID = "wc_solved";
const UNSOLVED_ID = "wc_unsolved";

interface CountsView {
  readonly shown: number;
  readonly pulled: number;
  readonly windowDays: number;
}

const fetchCounts = async (
  harness: TestHarness,
  apiKey: string,
): Promise<CountsView> => {
  const response = await harness.app.request(
    `/api/solved-matches?repo=${encodeURIComponent(REPO)}&counts=1`,
    jsonRequest("GET", apiKey),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { counts?: CountsView } };
  return body.data.counts ?? { shown: -1, pulled: -1, windowDays: -1 };
};

/** A tree that IS solved: an evidenced, declared, standing root cause. */
const solvedTreeRecords = (
  contextId: string,
): readonly Record<string, unknown>[] => [
  recordEnvelope(
    "work_context",
    validWorkContextBody({
      id: contextId,
      sessionId: SESSION,
      title: "Refresh 500s after key rotation",
      description: undefined,
      createdAt: TEST_START_ISO,
    }),
  ),
  recordEnvelope(
    "claim",
    validClaimBody({
      id: `${contextId}_evidence`,
      workContextId: contextId,
      kind: "evidence",
      body: "The trace shows the rotated key id being dropped",
      createdAt: TEST_START_ISO,
    }),
  ),
  recordEnvelope(
    "claim",
    validClaimBody({
      id: `${contextId}_root`,
      workContextId: contextId,
      kind: "root_cause",
      status: "likely_root_cause",
      confidence: 0.9,
      evidenceRefs: [`${contextId}_evidence`],
      body: "The ingestion mapping drops the key id on rotation",
      createdAt: TEST_START_ISO,
    }),
  ),
];

/** A tree with no root cause at all — a pointer, but never a solved one. */
const unsolvedTreeRecords = (): readonly Record<string, unknown>[] => [
  recordEnvelope(
    "work_context",
    validWorkContextBody({
      id: UNSOLVED_ID,
      sessionId: SESSION,
      title: "Key rotation cleanup",
      description: undefined,
      createdAt: TEST_START_ISO,
    }),
  ),
];

const deliveryRecord = (
  id: string,
  refId: string,
  sessionId: string = SESSION,
  developerId?: string,
): Record<string, unknown> =>
  recordEnvelope(
    "hint_delivery",
    {
      id,
      sessionId,
      refKind: "work_context",
      refId,
      deliveredAt: TEST_START_ISO,
    },
    { sessionId, ...(developerId === undefined ? {} : { developerId }) },
  );

interface Setup {
  readonly harness: TestHarness;
  readonly developer: TestDeveloper;
}

const seed = async (
  setup: Setup,
  records: readonly Record<string, unknown>[],
): Promise<void> => {
  const posted = await postRecords(setup.harness, setup.developer, { records });
  if (posted.status !== 200 || (posted.data?.rejected ?? 1) > 0) {
    throw new Error(`seed failed: ${JSON.stringify(posted.data?.results)}`);
  }
};

describe("GET /api/solved-matches?counts=1", () => {
  test("counts only the deliveries whose tree is actually solved", async () => {
    // Arrange: two pointers delivered, one to a solved tree and one to an
    // ordinary open context. Both are `work_context` deliveries and only one
    // of them is what this counter is about — a counter that just totalled
    // the ledger would report two.
    const context = await createHarnessWithSession();
    await seed(context, [
      ...solvedTreeRecords(SOLVED_ID),
      ...unsolvedTreeRecords(),
    ]);
    await seed(context, [
      deliveryRecord("hd_0000000000000000000000000000000a", SOLVED_ID),
      deliveryRecord("hd_0000000000000000000000000000000b", UNSOLVED_ID),
    ]);

    // Act
    const counts = await fetchCounts(context.harness, context.developer.apiKey);

    // Assert
    expect(counts.shown).toBe(1);
    expect(counts.pulled).toBe(0);
    expect(counts.windowDays).toBeGreaterThan(0);
  });

  test("reading the tree marks the pointer pulled and the count follows", async () => {
    // Arrange
    const context = await createHarnessWithSession();
    await seed(context, solvedTreeRecords(SOLVED_ID));
    await seed(context, [
      deliveryRecord("hd_0000000000000000000000000000000a", SOLVED_ID),
    ]);
    const before = await fetchCounts(context.harness, context.developer.apiKey);
    expect(before).toMatchObject({ shown: 1, pulled: 0 });

    // Act: the reader opens the tree — the same GET `get_diagnosis` makes.
    const read = await context.harness.app.request(
      `/api/work-contexts/${SOLVED_ID}/diagnosis`,
      jsonRequest("GET", context.developer.apiKey),
    );
    expect(read.status).toBe(200);

    // Assert
    const after = await fetchCounts(context.harness, context.developer.apiKey);
    expect(after).toMatchObject({ shown: 1, pulled: 1 });
  });

  test("a teammate's deliveries are not counted as mine", async () => {
    // Arrange: the SAME solved tree pointed at in Ken's session. The ledger
    // is hub-wide; the question "were the pointers I was shown read?" is not.
    const context = await createHarnessWithSession();
    const teammate = await addTestDeveloperWithSession(
      context.harness,
      "Ken",
      "ken@example.com",
      { id: "ses_ken" },
    );
    await seed(context, solvedTreeRecords(SOLVED_ID));
    const posted = await context.harness.app.request(
      "/api/records",
      jsonRequest("POST", teammate.apiKey, {
        records: [
          deliveryRecord(
            "hd_0000000000000000000000000000000c",
            SOLVED_ID,
            "ses_ken",
            teammate.developerId,
          ),
        ],
      }),
    );
    expect(posted.status).toBe(200);

    // Act
    const mine = await fetchCounts(context.harness, context.developer.apiKey);
    const theirs = await fetchCounts(context.harness, teammate.apiKey);

    // Assert: theirs counts it, mine does not — the contrast is what makes
    // the "0" a scoping fact rather than an empty hub.
    expect(theirs.shown).toBe(1);
    expect(mine.shown).toBe(0);
  });

  test("the counters answer without computing the listing", async () => {
    // Arrange: `?counts=1` is a different question about the same ledger and
    // must not pay for the matching pass whose answer it would discard.
    const context = await createHarnessWithSession();
    await seed(context, solvedTreeRecords(SOLVED_ID));

    // Act
    const response = await context.harness.app.request(
      `/api/solved-matches?repo=${encodeURIComponent(REPO)}&counts=1`,
      jsonRequest("GET", context.developer.apiKey),
    );
    const body = (await response.json()) as {
      data: { matches: readonly unknown[]; counts: CountsView };
    };

    // Assert
    expect(body.data.matches).toEqual([]);
    expect(body.data.counts.shown).toBe(0);
  });

  test("an over-long fingerprint is refused rather than truncated", async () => {
    // Arrange: a bounded parameter on an indexed lookup. Clamping it would
    // silently match the wrong failure, or nothing, and say neither.
    const context = await createHarnessWithSession();

    // Act
    const response = await context.harness.app.request(
      `/api/solved-matches?repo=${encodeURIComponent(REPO)}&fingerprint=${"z".repeat(500)}`,
      jsonRequest("GET", context.developer.apiKey),
    );

    // Assert
    expect(response.status).toBe(400);
  });
});
