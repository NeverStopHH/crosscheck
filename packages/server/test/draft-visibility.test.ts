/**
 * WHAT A TEAMMATE CAN REACH OF SOMEBODY'S DRAFTS (the review's HIGH-1 probe,
 * kept as a regression test). The promise the nudge and doctor make: an
 * unreviewed draft is never PUSHED to anyone, and a discarded one is never
 * offered as a finding. A teammate who SEARCHES may still find a tree by a
 * draft's words — it is a pull — but the result says the only match was a
 * draft; once the draft is discarded, nothing finds the tree by its words.
 */
import { describe, expect, test } from "bun:test";

import { MAX_INGEST_BATCH } from "../src/constants.ts";
import { NORMALIZED_DOC_CLAIM_SUMMARY_MAX_CHARS, NORMALIZED_DOC_MAX_TARGETS } from "../src/services/normalized-doc.ts";
import { searchWorkContexts } from "../src/services/search.ts";
import { createFakeEmbedder } from "./fixtures/fake-embedder.ts";
import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
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

/**
 * THE HINT CALLER'S OPTION (review round 3, LOW-8): a pushed surface must not
 * find a tree by a draft's words at all, so `excludeDerivedClaims` drops
 * derived claims inside the claim pass's own WHERE — never after its LIMIT.
 */
describe("searchWorkContexts' excludeDerivedClaims", () => {
  const searchDirect = (harness: TestHarness, viewer: TestDeveloper, excludeDerivedClaims: boolean) =>
    searchWorkContexts(
      { db: harness.db, now: harness.clock.now, embedder: null },
      { query: DRAFT_WORD, repo: VALID_SESSION_BODY.repo, limit: 10, excludeDerivedClaims, viewerDeveloperId: viewer.developerId },
    );

  test("a tree found only through a draft's words is not found at all", async () => {
    const { harness, robin } = await seed(false);

    const excluded = await searchDirect(harness, robin, true);
    const included = await searchDirect(harness, robin, false);

    expect(excluded.results.some((row) => row.id === WORK_CONTEXT_ID)).toBe(false);
    expect(included.results.find((row) => row.id === WORK_CONTEXT_ID)?.derivedOnly).toBe(true);
  });

  test("a vouched claim's words still find the tree", async () => {
    const { harness, developer: nick } = await createHarnessWithSession();
    const pastTheCut = `${"filler words about nothing ".repeat(8)}then the ${DRAFT_WORD} shows up`;
    await postRecords(harness, nick, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ title: "Unrelated title words", description: "nothing here" })),
        recordEnvelope("claim", validClaimBody({ id: "clm_vouched", body: pastTheCut })),
        draft("clm_draft"),
      ],
    });

    const excluded = await searchDirect(harness, nick, true);

    expect(excluded.results.find((row) => row.id === WORK_CONTEXT_ID)?.derivedOnly).toBe(false);
  });
});

/**
 * A MATCH IS DRAFT-ONLY ONLY WHEN NOTHING ELSE MATCHED (review round 3,
 * MEDIUM-6): a target, the title, or a vouched claim beside the draft makes
 * it an ordinary match. Each case is built so that ONLY the named other match
 * and the draft's words reach the query, which is what lets a wrong fusion
 * rule show.
 */
describe("a draft beside any other match is never marked draft-only", () => {
  const nickAndRobin = async (): Promise<{ harness: TestHarness; nick: TestDeveloper; robin: TestDeveloper }> => {
    const { harness, developer: nick } = await createHarnessWithSession();
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02", branch: "x" });
    return { harness, nick, robin };
  };
  const plainContext = (overrides: Record<string, unknown> = {}): unknown =>
    recordEnvelope("work_context", validWorkContextBody({ title: "Unrelated title words", description: "nothing here", ...overrides }));
  const target = (value: string): unknown => recordEnvelope("target", { workContextId: WORK_CONTEXT_ID, kind: "file", value });

  test("an exact target match beside a draft-only claim match", async () => {
    // Arrange: the matched target sorts past the doc's target cap, so the
    // exact tier is the only one that sees it — the fts tier sees the draft
    const { harness, nick, robin } = await nickAndRobin();
    const filler = Array.from({ length: NORMALIZED_DOC_MAX_TARGETS }, (_, i) => target(`aa/f${String(i).padStart(3, "0")}.ts`));
    await postRecords(harness, nick, { records: [plainContext(), ...filler.slice(0, MAX_INGEST_BATCH - 1)] });
    await postRecords(harness, nick, { records: [...filler.slice(MAX_INGEST_BATCH - 1), target("zztargetonly"), draft("clm_draft")] });

    // Act
    const hit = (await search(harness, robin, `zztargetonly ${DRAFT_WORD}`)).find((row) => row.id === WORK_CONTEXT_ID);

    // Assert
    expect(hit?.derivedOnly).toBe(false);
  });

  test("a title match beside a draft-only claim match", async () => {
    const { harness, nick, robin } = await nickAndRobin();
    await postRecords(harness, nick, { records: [plainContext({ title: `The ${DRAFT_WORD} flakes` }), draft("clm_draft")] });

    const hit = (await search(harness, robin, DRAFT_WORD)).find((row) => row.id === WORK_CONTEXT_ID);

    expect(hit?.derivedOnly).toBe(false);
  });

  test("a vouched claim and a draft that both match", async () => {
    // Arrange: the vouched claim's word sits past the doc's per-claim cut, so
    // only the claim pass sees it — grouped with the draft's row
    const { harness, nick, robin } = await nickAndRobin();
    const pastTheCut = `${"filler words about nothing ".repeat(8)}then the ${DRAFT_WORD} shows up`;
    expect(pastTheCut.indexOf(DRAFT_WORD)).toBeGreaterThan(NORMALIZED_DOC_CLAIM_SUMMARY_MAX_CHARS);
    await postRecords(harness, nick, {
      records: [plainContext(), recordEnvelope("claim", validClaimBody({ id: "clm_vouched", body: pastTheCut })), draft("clm_draft")],
    });

    const hit = (await search(harness, robin, DRAFT_WORD)).find((row) => row.id === WORK_CONTEXT_ID);

    expect(hit?.derivedOnly).toBe(false);
  });
});

/**
 * THE MARK IS A LEXICAL FACT (review round 3, HIGH-2): the vector tier embeds
 * the context's doc, never a claim, so its row says nothing about which words
 * matched — and fusing it in used to clear the mark, showing a draft-only
 * match as vouched on every hub with an embedder.
 */
describe("the vector tier never decides whether a match was a draft's", () => {
  const withEmbedder = async (): Promise<{ harness: TestHarness; nick: TestDeveloper; robin: TestDeveloper }> => {
    const harness = await createTestHarness({ embedder: createFakeEmbedder() });
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    await registerTestSession(harness, nick.apiKey);
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02", branch: "x" });
    return { harness, nick, robin };
  };

  const searchWithTiers = async (harness: TestHarness, developer: TestDeveloper, query: string) => {
    const params = new URLSearchParams({ query, repo: VALID_SESSION_BODY.repo });
    const response = await harness.app.request(`/api/search?${params.toString()}`, jsonRequest("GET", developer.apiKey));
    return ((await response.json()) as { data: { vectorTierActive: boolean; results: SearchRow[] } }).data;
  };

  test("a draft-only match the vector tier also lists stays marked draft-only", async () => {
    // Arrange: the fake embedder puts the doc and the query on the same axis
    const { harness, nick, robin } = await withEmbedder();
    await postRecords(harness, nick, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ title: "Unrelated title words", description: "nothing here" })),
        draft("clm_draft"),
      ],
    });

    // Act
    const data = await searchWithTiers(harness, robin, DRAFT_WORD);

    // Assert
    expect(data.vectorTierActive).toBe(true);
    expect(data.results.find((row) => row.id === WORK_CONTEXT_ID)?.derivedOnly).toBe(true);
  });

  test("a match found by the vector tier alone is never marked draft-only", async () => {
    // Arrange: "warm" shares the fake embedder's cache axis, and no word
    const { harness, nick, robin } = await withEmbedder();
    await postRecords(harness, nick, {
      records: [recordEnvelope("work_context", validWorkContextBody({ title: "The cache misses on boot", description: "nothing here" }))],
    });

    // Act
    const data = await searchWithTiers(harness, robin, "warm");

    // Assert
    expect(data.results.find((row) => row.id === WORK_CONTEXT_ID)?.derivedOnly).toBe(false);
  });
});
