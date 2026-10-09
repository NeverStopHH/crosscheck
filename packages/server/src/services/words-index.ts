/**
 * THE HINT FLOOR'S WORDS FOR THE ROWS AN UPGRADE FOUND (batch-2 integration
 * review, M10).
 *
 * `claims.words_tsv` and `work_contexts.words_tsv` — a row's words and its
 * dotted names' parts (round 5, L2) — are plain columns the database fills
 * on every write (bootstrap.sql: crosscheck_words_tsv and its two triggers).
 * An upgraded hub adds them EMPTY rather than rewriting both tables before
 * it listens, which kept a pilot-scale hub's port closed for 79 s; this pass
 * fills the rows it found, after serving:
 *
 *   - a chunk of WORDS_INDEX_BACKFILL_BATCH rows per statement, with a turn of
 *     the event loop between chunks, so a request waits out one chunk at most;
 *   - claims first (the floor's own statements), then work contexts;
 *   - each chunk is its own statement and commits on its own, and the next
 *     chunk is simply the next rows still empty: a start that dies mid-pass
 *     loses nothing, and the next start fills what is left;
 *   - each table VACUUMed once it was filled: PGlite runs no autovacuum, and
 *     every filled row left its old version behind.
 *
 * Until the pass reaches a row, the floor reads it by its plain words
 * (isWordsIndexComplete below; services/hints.ts), and GET /api/hub-status
 * counts what is left, which `crosscheck doctor` prints.
 */
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { WORDS_INDEX_BACKFILL_BATCH, WORDS_INDEX_PROGRESS_CHUNKS } from "../constants.ts";
import type { Db, DbExecutor } from "../db/client.ts";
import { yieldToRequests } from "../db/yield-to-requests.ts";

export interface WordsBackfillReport {
  /** Claims whose words this pass filled. */
  readonly claims: number;
  /** Work contexts whose words this pass filled. */
  readonly workContexts: number;
}

/** One table's backfill: the table, and the text its words are built from. */
interface WordsTable {
  readonly name: "claims" | "work_contexts";
  readonly label: string;
  readonly text: SQL;
}

const CLAIMS: WordsTable = { name: "claims", label: "claim", text: sql`body` };
const WORK_CONTEXTS: WordsTable = { name: "work_contexts", label: "work context", text: sql`coalesce(normalized_doc, '')` };

const countIn = async (db: DbExecutor, table: WordsTable): Promise<number> => {
  const rows = await db.execute<{ pending: number }>(
    sql`SELECT count(*)::int AS pending FROM ${sql.identifier(table.name)} WHERE words_tsv IS NULL`,
  );
  return Number(rows.rows[0]?.pending ?? 0);
};

/** Rows whose words the backfill has yet to fill — 0 on a hub that never ran without the column. */
export const countWordsIndexPending = async (db: DbExecutor): Promise<number> =>
  (await countIn(db, CLAIMS)) + (await countIn(db, WORK_CONTEXTS));

/**
 * Whether every row has its words, asked of the two partial indexes of the
 * rows still empty — a probe of two empty indexes once the backfill is done.
 * The hint floor reads it per request: until it is true, a row the backfill
 * has not reached is matched by its plain words.
 */
export const isWordsIndexComplete = async (db: DbExecutor): Promise<boolean> => {
  const rows = await db.execute<{ pending: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM claims WHERE words_tsv IS NULL)
        OR EXISTS (SELECT 1 FROM work_contexts WHERE words_tsv IS NULL) AS pending`);
  return rows.rows[0]?.pending !== true;
};

/** Fills the next chunk of empty rows; how many it filled. */
const fillChunk = async (db: Db, table: WordsTable, batch: number): Promise<number> => {
  const name = sql.identifier(table.name);
  const filled = await db.execute(sql`
    UPDATE ${name} SET words_tsv = crosscheck_words_tsv(${table.text})
    WHERE id IN (SELECT id FROM ${name} WHERE words_tsv IS NULL ORDER BY id LIMIT ${batch})
    RETURNING id`);
  return filled.rows.length;
};

interface Progress {
  readonly batch: number;
  readonly progress: (line: string) => void;
}

const fillTable = async (db: Db, table: WordsTable, options: Progress, done = 0, chunks = 0): Promise<number> => {
  const filled = await fillChunk(db, table, options.batch);
  if (filled === 0) {
    return done;
  }
  await yieldToRequests();
  const total = done + filled;
  if ((chunks + 1) % WORDS_INDEX_PROGRESS_CHUNKS === 0) {
    options.progress(`${String(total)} ${table.label}(s) filled`);
  }
  return fillTable(db, table, options, total, chunks + 1);
};

/** One table filled to the end, and VACUUMed when anything was written. */
const backfillTable = async (db: Db, table: WordsTable, options: Progress): Promise<number> => {
  const pending = await countIn(db, table);
  if (pending === 0) {
    return 0;
  }
  options.progress(`starting: ${String(pending)} ${table.label}(s) to fill; until each is, it is matched by its plain words`);
  const filled = await fillTable(db, table, options);
  await db.execute(sql`VACUUM ${sql.identifier(table.name)}`);
  return filled;
};

/** Fills every empty words column, claims first; idempotent, and a no-op once done. */
export const backfillWordsIndex = async (
  deps: { readonly db: Db },
  options: { readonly batch?: number; readonly progress?: (line: string) => void } = {},
): Promise<WordsBackfillReport> => {
  const progress: Progress = {
    batch: options.batch ?? WORDS_INDEX_BACKFILL_BATCH,
    progress: options.progress ?? (() => undefined),
  };
  const claims = await backfillTable(deps.db, CLAIMS, progress);
  const workContexts = await backfillTable(deps.db, WORK_CONTEXTS, progress);
  return { claims, workContexts };
};

/** The start-up log line. */
export const describeWordsBackfill = (report: WordsBackfillReport): string =>
  `${String(report.claims)} claim(s) and ${String(report.workContexts)} work context(s) given their dotted names' parts`;
