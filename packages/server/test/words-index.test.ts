/**
 * THE HINT FLOOR'S WORDS ARRIVE WITHOUT CLOSING THE PORT (batch-2 integration
 * review, M10 and the "upgrade timing" section).
 *
 * `words_tsv` — a row's words and its dotted names' parts — was a STORED
 * generated column. Adding it to a 0.10 hub rewrote `work_contexts` and
 * `claims` before the hub listened: 51 s and 13.8 s at pilot scale, the
 * port closed for 79 s, +325 MB of disk at the peak. It is now a plain
 * column the database fills as it writes a row (a trigger, so it can never
 * drift from the text), which an upgraded hub adds EMPTY — no rewrite — and a
 * background pass fills a chunk at a time after the port opens. Until the
 * pass reaches a row, the floor reads that row's plain words (`tsv`, what a
 * 0.10 hub matched it by); a crash mid-pass loses nothing, since every chunk
 * is its own statement and the next start fills whatever is still empty.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { dottedNamePartsText, knownTermsIn, promptTerms } from "@crosscheck/schema";

import { hubFloorTermsOf } from "../src/services/hints.ts";
import { backfillWordsIndex, countWordsIndexPending } from "../src/services/words-index.ts";
import { BOOTSTRAP_SQL_URL } from "./fixtures/bootstrap-sql.ts";
import {
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  validClaimBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
const FINDING = "ILIKE '%term%' on products.name does a sequential scan, p95 2.8s";
const STATEMENT = "Reduce product search latency with a trigram index Ranking on products.title";
const CLAIM_IDS = ["clm_a", "clm_b", "clm_c", "clm_d", "clm_e"] as const;

interface World {
  readonly harness: TestHarness;
  readonly tobi: TestDeveloper;
}

/** Tobi's search tree: a statement and five findings, all naming columns dotted. */
const seed = async (): Promise<World> => {
  const { harness, developer: tobi } = await createHarnessWithSession();
  const posted = await postRecords(harness, tobi, {
    records: [
      recordEnvelope("work_context", validWorkContextBody({ title: "Reduce product search latency with a trigram index", description: "Ranking on products.title" })),
      ...CLAIM_IDS.map((id, index) => recordEnvelope("claim", validClaimBody({ id, body: index === 0 ? FINDING : `${FINDING} (${id})` }))),
    ],
  });
  expect(posted.data?.accepted).toBe(1 + CLAIM_IDS.length);
  return { harness, tobi };
};

const runBootstrap = async (harness: TestHarness): Promise<void> => {
  const client = (harness.db as unknown as { $client: { exec: (text: string) => Promise<unknown> } }).$client;
  await client.exec(await Bun.file(BOOTSTRAP_SQL_URL).text());
};

const storageOf = async (harness: TestHarness): Promise<Record<string, number>> => {
  const rows = await harness.db.execute<{ name: string; node: number }>(
    sql`SELECT relname AS name, relfilenode::int AS node FROM pg_class WHERE relname IN ('claims', 'work_contexts')`,
  );
  return Object.fromEntries(rows.rows.map((row) => [row.name, Number(row.node)]));
};

const storedWords = async (harness: TestHarness): Promise<readonly string[]> =>
  (
    await harness.db.execute<{ words: string | null }>(sql`
      SELECT words_tsv::text AS words FROM claims
      UNION ALL SELECT words_tsv::text FROM work_contexts
      ORDER BY 1`)
  ).rows.map((row) => String(row.words));

/** What an upgrade from 0.10 leaves: every row's words empty (setting them fires no trigger). */
const emptyEveryRowsWords = async (harness: TestHarness): Promise<void> => {
  await harness.db.execute(sql`UPDATE claims SET words_tsv = NULL`);
  await harness.db.execute(sql`UPDATE work_contexts SET words_tsv = NULL`);
};

describe("the words column reaches an upgraded hub without rewriting a table (M10)", () => {
  test("a 0.10 hub keeps its storage: the column arrives empty and the rows wait for the backfill", async () => {
    // Arrange — the 0.10 shape: no words column, no trigger filling it
    const { harness } = await seed();
    await harness.db.execute(sql`DROP TRIGGER claims_words_tsv_fill ON claims`);
    await harness.db.execute(sql`DROP TRIGGER work_contexts_words_tsv_fill ON work_contexts`);
    await harness.db.execute(sql`ALTER TABLE claims DROP COLUMN words_tsv`);
    await harness.db.execute(sql`ALTER TABLE work_contexts DROP COLUMN words_tsv`);
    const before = await storageOf(harness);

    // Act
    await runBootstrap(harness);

    // Assert
    expect(await storageOf(harness)).toEqual(before);
    expect(await countWordsIndexPending(harness.db)).toBe(1 + CLAIM_IDS.length);
  });

  test("a hub that ran the generated column keeps its words and its storage, and the column turns plain", async () => {
    // Arrange — the shape of this batch before the fix: words_tsv GENERATED ALWAYS … STORED
    const { harness } = await seed();
    await harness.db.execute(sql`DROP TRIGGER claims_words_tsv_fill ON claims`);
    await harness.db.execute(sql`ALTER TABLE claims DROP COLUMN words_tsv`);
    await harness.db.execute(
      sql`ALTER TABLE claims ADD COLUMN words_tsv tsvector GENERATED ALWAYS AS (crosscheck_words_tsv(body)) STORED`,
    );
    const before = await storageOf(harness);
    const words = await storedWords(harness);

    // Act
    await runBootstrap(harness);

    // Assert
    const generated = await harness.db.execute<{ table: string; generated: string }>(
      sql`SELECT table_name AS table, is_generated AS generated FROM information_schema.columns WHERE column_name = 'words_tsv' ORDER BY table_name`,
    );
    expect(generated.rows).toEqual([
      { table: "claims", generated: "NEVER" },
      { table: "work_contexts", generated: "NEVER" },
    ]);
    expect(await storageOf(harness)).toEqual(before);
    expect(await storedWords(harness)).toEqual(words);
    expect(await countWordsIndexPending(harness.db)).toBe(0);
  });

  test("a second boot leaves the words column, its rows and its storage alone", async () => {
    // Arrange
    const { harness } = await seed();
    const before = await storageOf(harness);
    const words = await storedWords(harness);

    // Act
    await runBootstrap(harness);

    // Assert
    expect(await storageOf(harness)).toEqual(before);
    expect(await storedWords(harness)).toEqual(words);
  });
});

describe("the database fills a row's words as it writes the row", () => {
  test("a claim's words are its words and its dotted names' parts, as the shared rule splits them", async () => {
    // Arrange
    const { harness } = await seed();

    // Act
    const rows = await harness.db.execute<{ same: boolean; parts: boolean }>(sql`
      SELECT words_tsv = (to_tsvector('english', body) || to_tsvector('english', ${dottedNamePartsText(FINDING)})) AS same,
             words_tsv @@ to_tsquery('english', 'name') AS parts
      FROM claims WHERE id = 'clm_a'`);

    // Assert
    expect(rows.rows[0]).toEqual({ same: true, parts: true });
  });

  test("a rebuilt doc's words follow the doc", async () => {
    // Arrange
    const { harness } = await seed();

    // Act
    await harness.db.execute(sql`UPDATE work_contexts SET normalized_doc = 'the orders.total column overflows'`);
    const rows = await harness.db.execute<{ total: boolean; stale: boolean }>(sql`
      SELECT words_tsv @@ to_tsquery('english', 'total') AS total, words_tsv @@ to_tsquery('english', 'trigram') AS stale
      FROM work_contexts`);

    // Assert
    expect(rows.rows[0]).toEqual({ total: true, stale: false });
  });
});

describe("the background backfill (M10)", () => {
  test("fills every row the upgrade left empty with exactly what the database stores on write", async () => {
    // Arrange
    const { harness } = await seed();
    const written = await storedWords(harness);
    await emptyEveryRowsWords(harness);

    // Act
    const report = await backfillWordsIndex({ db: harness.db }, { batch: 2 });

    // Assert
    expect(report).toEqual({ claims: CLAIM_IDS.length, workContexts: 1 });
    expect(await storedWords(harness)).toEqual(written);
    expect(await countWordsIndexPending(harness.db)).toBe(0);
  });

  test("a pass cut short is finished by the next start, which fills only what is still empty", async () => {
    // Arrange — a first pass that got through two claims before the process died
    const { harness } = await seed();
    const written = await storedWords(harness);
    await emptyEveryRowsWords(harness);
    await harness.db.execute(sql`UPDATE claims SET words_tsv = crosscheck_words_tsv(body) WHERE id IN ('clm_a', 'clm_b')`);

    // Act
    const report = await backfillWordsIndex({ db: harness.db }, { batch: 2 });

    // Assert
    expect(report).toEqual({ claims: CLAIM_IDS.length - 2, workContexts: 1 });
    expect(await storedWords(harness)).toEqual(written);
  });

  test("takes a turn of the event loop between chunks", async () => {
    // Arrange
    const { harness } = await seed();
    await emptyEveryRowsWords(harness);
    let turned = false;
    setImmediate(() => {
      turned = true;
    });

    // Act
    const turnedBeforeTheEnd = await backfillWordsIndex({ db: harness.db }, { batch: 1 }).then(() => turned);

    // Assert
    expect(turnedBeforeTheEnd).toBe(true);
  });
});

describe("the hint floor while the backfill runs (M10)", () => {
  const TERMS = promptTerms("products name title search ilike sequential trigram");

  test("a row the backfill has not reached is still known by its plain words", async () => {
    // Arrange
    const { harness } = await seed();
    await emptyEveryRowsWords(harness);

    // Act
    const hub = await hubFloorTermsOf(harness.db, REPO, TERMS);

    // Assert
    expect(hub.all).toEqual(expect.arrayContaining(["search", "ilike", "sequential", "trigram"]));
  });

  test("once the backfill has filled it, its dotted names' parts are known as well, as the shared rule knows them", async () => {
    // Arrange
    const { harness } = await seed();
    await emptyEveryRowsWords(harness);

    // Act
    await backfillWordsIndex({ db: harness.db });
    const hub = await hubFloorTermsOf(harness.db, REPO, TERMS);

    // Assert
    expect(hub.all).toEqual(knownTermsIn(TERMS.ranked, [STATEMENT, FINDING]));
    expect(hub.all).toEqual(expect.arrayContaining(["name", "title"]));
  });
});

describe("GET /api/hub-status counts the rows still waiting for their words", () => {
  const pending = async (world: World): Promise<unknown> => {
    const response = await world.harness.app.request("/api/hub-status", jsonRequest("GET", world.tobi.apiKey));
    expect(response.status).toBe(200);
    return ((await response.json()) as { data: { wordsIndexPending: unknown } }).data.wordsIndexPending;
  };

  test("every empty row while the backfill runs, and 0 once it is done", async () => {
    // Arrange
    const world = await seed();
    await emptyEveryRowsWords(world.harness);

    // Act
    const during = await pending(world);
    await backfillWordsIndex({ db: world.harness.db });
    const after = await pending(world);

    // Assert
    expect(during).toBe(1 + CLAIM_IDS.length);
    expect(after).toBe(0);
  });
});
