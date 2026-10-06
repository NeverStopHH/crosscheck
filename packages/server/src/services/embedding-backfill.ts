/**
 * EVERY CONTEXT GETS A VECTOR OF ITS CURRENT DOC, EVENTUALLY (review round 4,
 * H2).
 *
 * A vector is cleared whenever its doc is rebuilt (normalized-doc.ts: a vector
 * of the old doc no longer describes the new one), and re-minting it can fail
 * for reasons that heal later: an embedding provider's 503, a start with no
 * embedder configured, a process killed between the rebuild and the embed.
 * Before this, nothing ever re-embedded a null vector — each such loss was
 * for good, and the context silently left the vector tier.
 *
 * So with an embedder configured, EVERY start re-embeds, page by page, every
 * context whose vector is missing or was minted by another model ("model
 * change = re-embed migration", DESIGN.md §6). Idempotent: a hub whose
 * vectors are all current finds nothing. Each page is ONE embedder call
 * (the array form), and only vectors actually stored are counted; a failed
 * call is logged with its count and retried by the next start.
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";

import { DOC_UPGRADE_BATCH } from "../constants.ts";
import type { Db, DbExecutor } from "../db/client.ts";
import { workContexts } from "../db/schema.ts";
import type { Embedder } from "./embedder.ts";
import { yieldToEventLoop } from "./event-loop.ts";

export interface EmbedOutcome {
  /** Vectors minted and stored. */
  readonly embedded: number;
  /** Contexts whose vector could not be minted this time. */
  readonly failed: number;
}

const NOTHING: EmbedOutcome = { embedded: 0, failed: 0 };

const sum = (a: EmbedOutcome, b: EmbedOutcome): EmbedOutcome => ({
  embedded: a.embedded + b.embedded,
  failed: a.failed + b.failed,
});

/** The embedder's answer, or null when it threw — logged with how many it cost. */
const tryEmbed = async (
  embedder: Embedder,
  docs: readonly string[],
): Promise<ReadonlyArray<readonly number[]> | null> => {
  try {
    return await embedder.embed(docs);
  } catch (error) {
    console.error(
      `[crosscheck] embedding ${String(docs.length)} work context doc(s) failed; ` +
        "they stay out of the vector tier until the next start re-embeds them",
      error,
    );
    return null;
  }
};

/**
 * Embeds the CURRENT docs of `ids` in ONE embedder call and stores each
 * vector only if its doc is still the doc on the row (the race
 * embedContextDoc closes the same way). Counts what was stored.
 */
export const embedContextDocs = async (
  db: DbExecutor,
  embedder: Embedder,
  ids: readonly string[],
): Promise<EmbedOutcome> => {
  if (ids.length === 0) {
    return NOTHING;
  }
  const rows = await db
    .select({ id: workContexts.id, doc: workContexts.normalizedDoc })
    .from(workContexts)
    .where(inArray(workContexts.id, [...ids]));
  const docs = rows.flatMap((row) => (row.doc === null || row.doc.length === 0 ? [] : [{ id: row.id, doc: row.doc }]));
  if (docs.length === 0) {
    return NOTHING;
  }
  const vectors = await tryEmbed(
    embedder,
    docs.map((entry) => entry.doc),
  );
  if (vectors === null) {
    return { embedded: 0, failed: docs.length };
  }
  const stored = await Promise.all(
    docs.map(async (entry, index) => {
      const vector = vectors[index];
      if (vector === undefined) {
        return false;
      }
      const written = await db
        .update(workContexts)
        .set({ embedding: [...vector], embeddingModel: embedder.model })
        .where(and(eq(workContexts.id, entry.id), eq(workContexts.normalizedDoc, entry.doc)))
        .returning({ id: workContexts.id });
      return written.length > 0;
    }),
  );
  const embedded = stored.filter(Boolean).length;
  return { embedded, failed: docs.length - embedded };
};

/** One page of contexts with a doc but no vector of the current model. */
const missingPage = async (db: Db, model: string, after: string, batch: number): Promise<readonly string[]> => {
  const rows = await db
    .select({ id: workContexts.id })
    .from(workContexts)
    .where(
      and(
        gt(workContexts.id, after),
        isNotNull(workContexts.normalizedDoc),
        ne(workContexts.normalizedDoc, ""),
        or(isNull(workContexts.embedding), sql`${workContexts.embeddingModel} IS DISTINCT FROM ${model}`),
      ),
    )
    .orderBy(asc(workContexts.id))
    .limit(batch);
  return rows.map((row) => row.id);
};

/** No id sorts before this, so the first page starts at the beginning. */
const BEFORE_EVERY_ID = "";

const backfillFrom = async (
  deps: { readonly db: Db; readonly embedder: Embedder },
  batch: number,
  after: string,
  done: EmbedOutcome,
): Promise<EmbedOutcome> => {
  const ids = await missingPage(deps.db, deps.embedder.model, after, batch);
  const last = ids[ids.length - 1];
  if (last === undefined) {
    return done;
  }
  const page = await embedContextDocs(deps.db, deps.embedder, ids);
  await yieldToEventLoop();
  return backfillFrom(deps, batch, last, sum(done, page));
};

export const backfillEmbeddings = (
  deps: { readonly db: Db; readonly embedder: Embedder },
  options: { readonly batch?: number } = {},
): Promise<EmbedOutcome> => backfillFrom(deps, options.batch ?? DOC_UPGRADE_BATCH, BEFORE_EVERY_ID, NOTHING);
