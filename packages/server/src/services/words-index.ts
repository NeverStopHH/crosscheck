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
 *   - a chunk of rows per statement (WORDS_INDEX_CLAIMS_BATCH claims — each
 *     re-enters the HNSW graph on a hub with an embedder — or
 *     WORDS_INDEX_BACKFILL_BATCH work contexts), with a turn of the event
 *     loop between chunks, so a request waits out one chunk at most;
 *   - claims first (the floor's own statements), then work contexts;
 *   - each chunk is its own statement and commits on its own, and the next
 *     chunk is simply the next rows still empty: a start that dies mid-pass
 *     loses nothing, and the next start fills what is left;
 *   - the table VACUUMed every WORDS_INDEX_VACUUM_CHUNKS chunks and once at
 *     its end: PGlite runs no autovacuum, and every filled row left its old
 *     version behind. Every 10 chunks, the next chunks reuse the space the
 *     last ones freed: on the review's synthetic hub the database grew
 *     185 MB, not 346 MB, the pass took 38 s, not 67 s, and no VACUUM held a
 *     request past 219 ms (one VACUUM at the end: 666 ms).
 *
 * Until the pass reaches a row, the floor reads it by its plain words
 * (isWordsIndexComplete below; services/hints.ts), and GET /api/hub-status
 * counts what is left, which `crosscheck doctor` prints.
 */
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import {
  WORDS_INDEX_BACKFILL_BATCH,
  WORDS_INDEX_CLAIMS_BATCH,
  WORDS_INDEX_PROGRESS_CHUNKS,
  WORDS_INDEX_VACUUM_CHUNKS,
} from "../constants.ts";
import type { Db, DbExecutor } from "../db/client.ts";
import { yieldToRequests } from "../db/yield-to-requests.ts";

export interface WordsBackfillReport {
  /** Claims whose words this pass filled. */
  readonly claims: number;
  /** Work contexts whose words this pass filled. */
  readonly workContexts: number;
}

/** One table's backfill: the table, the text its words are built from, and its chunk. */
interface WordsTable {
  readonly name: "claims" | "work_contexts";
  readonly label: string;
  readonly text: SQL;
  readonly batch: number;
}

const CLAIMS: WordsTable = { name: "claims", label: "claim", text: sql`body`, batch: WORDS_INDEX_CLAIMS_BATCH };
const WORK_CONTEXTS: WordsTable = {
  name: "work_contexts",
  label: "work context",
  text: sql`coalesce(normalized_doc, '')`,
  batch: WORDS_INDEX_BACKFILL_BATCH,
};

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
  /** The chunk for every table, when the caller sets one (tests); otherwise each table's own. */
  readonly batch: number | undefined;
  readonly progress: (line: string) => void;
}

/**
 * The dead row versions the filled chunks left, made reusable. PARALLEL 0:
 * a parallel VACUUM maps a dynamic shared memory segment, and PGlite failed
 * to map one ("could not map shared memory segment": out of memory) after a
 * few hundred VACUUMs in one process on the review's synthetic hub.
 */
const vacuum = async (db: Db, table: WordsTable): Promise<void> => {
  await db.execute(sql`VACUUM (PARALLEL 0) ${sql.identifier(table.name)}`);
};

const fillTable = async (db: Db, table: WordsTable, options: Progress, done = 0, chunks = 0): Promise<number> => {
  const filled = await fillChunk(db, table, options.batch ?? table.batch);
  if (filled === 0) {
    return done;
  }
  await yieldToRequests();
  const total = done + filled;
  const chunk = chunks + 1;
  if (chunk % WORDS_INDEX_PROGRESS_CHUNKS === 0) {
    options.progress(`${String(total)} ${table.label}(s) filled`);
  }
  if (chunk % WORDS_INDEX_VACUUM_CHUNKS === 0) {
    await vacuum(db, table);
    await yieldToRequests();
  }
  return fillTable(db, table, options, total, chunk);
};

/** One table filled to the end, and VACUUMed once more when anything was written. */
const backfillTable = async (db: Db, table: WordsTable, options: Progress): Promise<number> => {
  const pending = await countIn(db, table);
  if (pending === 0) {
    return 0;
  }
  options.progress(`starting: ${String(pending)} ${table.label}(s) to fill; until each is, it is matched by its plain words`);
  const filled = await fillTable(db, table, options);
  await vacuum(db, table);
  return filled;
};

/** Fills every empty words column, claims first; idempotent, and a no-op once done. */
export const backfillWordsIndex = async (
  deps: { readonly db: Db },
  options: { readonly batch?: number; readonly progress?: (line: string) => void } = {},
): Promise<WordsBackfillReport> => {
  const progress: Progress = {
    batch: options.batch,
    progress: options.progress ?? (() => undefined),
  };
  const claims = await backfillTable(deps.db, CLAIMS, progress);
  const workContexts = await backfillTable(deps.db, WORK_CONTEXTS, progress);
  return { claims, workContexts };
};

/** The start-up log line. */
export const describeWordsBackfill = (report: WordsBackfillReport): string =>
  `${String(report.claims)} claim(s) and ${String(report.workContexts)} work context(s) given their dotted names' parts`;
