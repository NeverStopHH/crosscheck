/**
 * WHAT A TEAMMATE CAN REACH OF SOMEBODY'S DRAFTS (the review's HIGH-1 probe,
 * kept as a regression test). The promise the nudge and doctor make: an
 * unreviewed draft is never PUSHED to anyone, and a discarded one is never
 * offered as a finding. A teammate who SEARCHES may still find a tree by a
 * draft's words — it is a pull — but the result says the only match was a
 * draft; once the draft is discarded, nothing finds the tree by its words.
 */
import { describe, expect, test } from "bun:test";

import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  validClaimBody,
  validClaimEdgeBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const DRAFT_WORD = "zebrafrobnicator";

interface SearchRow {
  readonly id: string;
  readonly derivedOnly?: boolean;
}

const search = async (harness: TestHarness, developer: TestDeveloper, query: string): Promise<readonly SearchRow[]> => {
  const params = new URLSearchParams({ query, repo: VALID_SESSION_BODY.repo });
  const response = await harness.app.request(`/api/search?${params.toString()}`, jsonRequest("GET", developer.apiKey));
  const body = (await response.json()) as { data: { results: SearchRow[] } };
  return body.data.results;
};

const draft = (id: string, extra: Record<string, unknown> = {}): unknown =>
  recordEnvelope(
    "claim",
    validClaimBody({
      id,
      captureMode: "auto",
      provenance: "derived",
      confidence: 0.4,
      body: `The ${DRAFT_WORD} cache poisons the quuxinator`,
      ...extra,
    }),
  );

/** Nick's tree, whose ONLY mention of the word is a draft; Robin searches. */
const seed = async (discarded: boolean): Promise<{ harness: TestHarness; robin: TestDeveloper }> => {
  const { harness, developer: nick } = await createHarnessWithSession();
  await postRecords(harness, nick, {
    records: [
      recordEnvelope("work_context", validWorkContextBody({ title: "Unrelated title words" })),
      draft("clm_draft"),
      ...(discarded
        ? [
            draft("clm_discard", { status: "rejected" }),
            recordEnvelope(
              "claim_edge",
              validClaimEdgeBody({ id: "edge_discard", fromClaimId: "clm_discard", toClaimId: "clm_draft", kind: "supersedes" }),
            ),
          ]
        : []),
    ],
  });
  const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02", branch: "x" });
  return { harness, robin };
};

describe("a draft's words in a teammate's explicit search", () => {
  test("an unreviewed draft is found by a search — and marked as a draft-only match", async () => {
    const { harness, robin } = await seed(false);

    const results = await search(harness, robin, DRAFT_WORD);

    const hit = results.find((row) => row.id === WORK_CONTEXT_ID);
    expect(hit).toBeDefined();
    expect(hit?.derivedOnly).toBe(true);
  });

  test("once discarded, nothing finds the tree by the draft's words", async () => {
    const { harness, robin } = await seed(true);

    const results = await search(harness, robin, DRAFT_WORD);

    expect(results.some((row) => row.id === WORK_CONTEXT_ID)).toBe(false);
  });

  test("a match through a declared claim is not marked draft-only", async () => {
    const { harness, developer: nick } = await createHarnessWithSession();
    await postRecords(harness, nick, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ title: "Unrelated title words" })),
        recordEnvelope("claim", validClaimBody({ id: "clm_vouched", body: `The ${DRAFT_WORD} cache is cold` })),
      ],
    });
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02", branch: "x" });

    const hit = (await search(harness, robin, DRAFT_WORD)).find((row) => row.id === WORK_CONTEXT_ID);

    expect(hit?.derivedOnly).toBe(false);
  });
});
