/**
 * THE ENVELOPES THE HUB TOOK (review-2 round 8, M4).
 *
 * A connector that never heard the answer to a batch — its request timed out
 * after the hub committed — sends the batch again, and by then the hub may
 * have ended the life it sends under. The producer check answered `rejected`
 * for records the hub already held, so the connector counted them as lost:
 * 6.6% of the losses the spool simulation counted at production timing were
 * records sitting on the hub. A receipt per envelope taken — its id, and the
 * id the hub answered with — lets ingest answer such a re-send `duplicate`
 * where the producer check would refuse it (services/records.ts).
 *
 * Kept RECORD_RECEIPT_RETENTION_DAYS, pruned on the reaper pass.
 */
import { and, eq, inArray, lte, sql } from "drizzle-orm";

import { MS_PER_DAY, RECORD_RECEIPT_RETENTION_DAYS } from "../constants.ts";
import { recordReceipts } from "../db/schema.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

/** One envelope taken: its id, and the id the hub answered with (a claim's, an edge's). */
export interface Receipt {
  readonly id: string;
  readonly resultId: string | null;
}

/** What the hub holds of an envelope: the id its answer carried. */
export interface Held {
  readonly resultId: string | null;
}

/** The receipts this developer holds among one flush's envelope ids. */
export const heldReceipts = async (
  deps: Deps,
  developerId: string,
  ids: readonly string[],
): Promise<ReadonlyMap<string, Held>> => {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await deps.db
    .select({ id: recordReceipts.id, resultId: recordReceipts.resultId })
    .from(recordReceipts)
    .where(and(eq(recordReceipts.developerId, developerId), inArray(recordReceipts.id, [...ids])));
  return new Map(rows.map((row) => [row.id, { resultId: row.resultId }]));
};

/**
 * Writes the receipts of what a flush took — and only ever over this
 * developer's own receipt. One row per id: the same envelope twice in one
 * flush would otherwise touch its row twice in one statement.
 */
export const writeReceipts = async (deps: Deps, developerId: string, taken: readonly Receipt[]): Promise<void> => {
  const byId = new Map(taken.map((receipt) => [receipt.id, receipt]));
  if (byId.size === 0) {
    return;
  }
  const receivedAt = deps.now();
  await deps.db
    .insert(recordReceipts)
    .values([...byId.values()].map((receipt) => ({ ...receipt, developerId, receivedAt })))
    .onConflictDoUpdate({
      target: recordReceipts.id,
      set: { resultId: sql`excluded.result_id`, receivedAt: sql`excluded.received_at` },
      setWhere: sql`${recordReceipts.developerId} = excluded.developer_id`,
    });
};

/**
 * Receipts past the retention, on the hub's reaper pass. A prune that deleted
 * rows VACUUMs the table (review-2 round 9, H3): PGlite runs no autovacuum,
 * and every deleted receipt left a dead row for good — the table grew six
 * times its retention's size in half a year, and the prune with it. Only when
 * something went, so a pass with nothing to prune costs nothing more
 * (services/skeleton-identity.ts does the same).
 */
export const pruneRecordReceipts = async (deps: Deps): Promise<void> => {
  const cutoff = new Date(deps.now().getTime() - RECORD_RECEIPT_RETENTION_DAYS * MS_PER_DAY);
  const pruned = await deps.db
    .delete(recordReceipts)
    .where(lte(recordReceipts.receivedAt, cutoff))
    .returning({ id: recordReceipts.id });
  if (pruned.length > 0) {
    await deps.db.execute(sql`VACUUM record_receipts`);
  }
};
