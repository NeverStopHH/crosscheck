/**
 * A DOTTED NAME IS A WORD WHOLE AND IN ITS PARTS, on the hub too (hold-out
 * review round 5, L2). A prompt always read "products.name" as products and
 * name besides the whole; a teammate's text was read whole only, so "SELECT *
 * FROM products WHERE name ILIKE $1" never met the finding "ILIKE on
 * products.name does a sequential scan". The shared rule (`@crosscheck/schema`
 * textLexemes) reads the parts now, and the hub's database reads the same
 * parts — one pattern in two regex dialects, held together here.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { DOTTED_NAME_DOT_SQL, dottedNamePartsText, knownTermsIn, promptTerms } from "@crosscheck/schema";

import { BOOTSTRAP_SQL_URL } from "./fixtures/bootstrap-sql.ts";
import { hubFloorTermsOf } from "../src/services/hints.ts";
import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  validClaimBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
const FINDING = "ILIKE '%term%' on products.name does a sequential scan, p95 2.8s";
const TRACE = "QueryFailedError: canceling statement due to statement timeout\n  query: SELECT * FROM products WHERE name ILIKE $1 ORDER BY rank LIMIT 20";

const candidateIds = async (harness: TestHarness, developer: TestDeveloper, query: string): Promise<readonly string[]> => {
  const search = new URLSearchParams({ repo: REPO, query });
  const response = await harness.app.request(`/api/hints/candidates?${search.toString()}`, jsonRequest("GET", developer.apiKey));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { candidates: readonly { readonly workContext: { readonly id: string } }[] } };
  return body.data.candidates.map((candidate) => candidate.workContext.id);
};

/** Tobi's search tree, whose finding names the column dotted. */
const setup = async (): Promise<{ harness: TestHarness; robin: TestDeveloper }> => {
  const { harness, developer: tobi } = await createHarnessWithSession();
  const seeded = await postRecords(harness, tobi, {
    records: [
      recordEnvelope("work_context", validWorkContextBody({ title: "Reduce product search latency with a trigram index", description: "Ranking on products.title" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_ilike", body: FINDING })),
    ],
  });
  expect(seeded.data?.accepted).toBe(2);
  const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });
  return { harness, robin };
};

describe("a dotted name's parts are words of a teammate's text (round 5, L2)", () => {
  test("a trace that names the table and the column reaches the finding that names them dotted", async () => {
    // Arrange
    const { harness, robin } = await setup();

    // Act
    const ids = await candidateIds(harness, robin, TRACE);

    // Assert
    expect(ids).toEqual([WORK_CONTEXT_ID]);
  });

  test("the hub's known words and the shared rule's agree, word for word, on dotted names", async () => {
    // Arrange
    const { harness } = await setup();
    const terms = promptTerms("products name title search, the node js build on api example com");
    const statement = "Reduce product search latency with a trigram index Ranking on products.title";

    // Act
    const hub = await hubFloorTermsOf(harness.db, REPO, terms);

    // Assert — a dotted name's parts are known, the claim's and the statement's, by the index and by the rule alike
    expect(hub.all).toEqual(knownTermsIn(terms.ranked, [statement, FINDING]));
    expect(hub.all).toEqual(expect.arrayContaining(["products", "name", "title"]));
  });
});

describe("one pattern, two dialects", () => {
  test.each([
    [FINDING],
    ["see node.js and api.example.com, not src/auth/refresh.ts or ops@example.com"],
    ["'orders.created_at' v1.2.3 e.g. 4.5, x.y/z, https://a.b.com/c"],
    ["café.menu größe.wert\nnext.line"],
    ["foo. bar baz."],
  ])("the database splits %p where the shared rule does", async (text) => {
    // Arrange
    const harness = await createTestHarness();

    // Act
    const result = await harness.db.execute<{ parts: string }>(sql`SELECT regexp_replace(${text}, ${DOTTED_NAME_DOT_SQL}, ' ', 'g') AS parts`);

    // Assert
    expect(result.rows[0]?.parts).toBe(dottedNamePartsText(text));
  });

  test("bootstrap.sql stores both word columns on the pattern, verbatim, and indexes them", async () => {
    // Arrange
    const bootstrap = await Bun.file(BOOTSTRAP_SQL_URL).text();
    const harness = await createTestHarness();

    // Act
    const indexes = await harness.db.execute<{ name: string }>(
      sql`SELECT indexname AS name FROM pg_indexes WHERE indexname IN ('claims_words_tsv_idx', 'work_contexts_words_tsv_idx') ORDER BY indexname`,
    );
    const columns = await harness.db.execute<{ name: string }>(
      sql`SELECT table_name AS name FROM information_schema.columns WHERE column_name = 'words_tsv' AND is_generated = 'ALWAYS' ORDER BY table_name`,
    );

    // Assert
    expect(bootstrap.split(`'${DOTTED_NAME_DOT_SQL}'`).length - 1).toBe(2);
    expect(indexes.rows.map((row) => row.name)).toEqual(["claims_words_tsv_idx", "work_contexts_words_tsv_idx"]);
    expect(columns.rows.map((row) => row.name)).toEqual(["claims", "work_contexts"]);
  });
});
