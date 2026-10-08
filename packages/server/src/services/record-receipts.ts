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
 * Kept RECORD_RECEIPT_RETENTION_DAYS, pruned on the reaper pass and at boot.
 */
import { and, eq, inArray, lte, sql } from "drizzle-orm";

import { MS_PER_DAY, RECORD_RECEIPT_PRUNE_CHUNK, RECORD_RECEIPT_RETENTION_DAYS } from "../constants.ts";
import { recordReceipts } from "../db/schema.ts";
import type { Db } from "../db/client.ts";
import { yieldToRequests } from "../db/yield-to-requests.ts";
import type { Clock } from "../types.ts";

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

/** What the hub holds of an envelope: the id its answer carried, and whether it kept the change inside it back. */
export interface Held {
  readonly resultId: string | null;
  readonly isIgnored: boolean;
}

/** One envelope the hub holds: its id, and what it answered (a claim's id, an edge's; `ignored`). */
export interface Receipt extends Held {
  readonly id: string;
}

/**
 * The receipts this developer holds among one flush's envelope ids.
 * BEST-EFFORT, like the write below (review-2 round 9, M5): a receipt only
 * spares a re-send its refusal, so a read that fails answers the flush as a
 * hub without receipts would, never with a 500 for the whole batch.
 */
export const heldReceipts = async (
  deps: Deps,
  developerId: string,
  ids: readonly string[],
): Promise<ReadonlyMap<string, Held>> => {
  if (ids.length === 0) {
    return new Map();
  }
  try {
    const rows = await deps.db
      .select({ id: recordReceipts.id, resultId: recordReceipts.resultId, isIgnored: recordReceipts.isIgnored })
      .from(recordReceipts)
      .where(and(eq(recordReceipts.developerId, developerId), inArray(recordReceipts.id, [...ids])));
    return new Map(rows.map((row) => [row.id, { resultId: row.resultId, isIgnored: row.isIgnored }]));
  } catch (error) {
    console.error("[crosscheck] reading record receipts failed; this flush is answered without them", error);
    return new Map();
  }
};

/**
 * Writes the receipt of one envelope the hub now holds, as its record lands
 * (review-2 round 9, L3): written after the whole flush, a batch that failed
 * midway left the records before the failure landed and unreceipted, and
 * their re-send was refused. Keyed by developer and id, so it is only ever
 * this developer's own. Best-effort: a receipt that does not land costs a
 * later re-send its answer.
 */
export const writeReceipt = async (deps: Deps, developerId: string, receipt: Receipt): Promise<void> => {
  try {
    await deps.db
      .insert(recordReceipts)
      .values({ ...receipt, developerId, receivedAt: deps.now() })
      .onConflictDoUpdate({
        target: [recordReceipts.developerId, recordReceipts.id],
        set: { resultId: sql`excluded.result_id`, isIgnored: sql`excluded.ignored`, receivedAt: sql`excluded.received_at` },
      });
  } catch (error) {
    console.error("[crosscheck] writing record receipts failed; their records landed without them", error);
  }
};

/** The oldest RECORD_RECEIPT_PRUNE_CHUNK receipts past the cutoff, deleted: how many went. */
const deleteChunk = async (deps: Deps, cutoff: Date): Promise<number> => {
  const oldest = deps.db
    .select({ id: recordReceipts.id })
    .from(recordReceipts)
    .where(lte(recordReceipts.receivedAt, cutoff))
    .orderBy(recordReceipts.receivedAt)
    .limit(RECORD_RECEIPT_PRUNE_CHUNK);
  const pruned = await deps.db
    .delete(recordReceipts)
    .where(and(lte(recordReceipts.receivedAt, cutoff), inArray(recordReceipts.id, oldest)))
    .returning({ id: recordReceipts.id });
  return pruned.length;
};

/**
 * Receipts past the retention, on the hub's reaper pass and once at boot —
 * never on a SessionStart's (review-2 round 9, M4). A CHUNK AT A TIME: PGlite
 * serves one statement at a time, and a request waits out at most one
 * statement, where one DELETE of a restarted hub's backlog held it 457 ms. AND
 * A TURN OF THE EVENT LOOP after each statement: PGlite answers in
 * microtasks, so a loop of statements that never yields reads no request
 * until it is done.
 *
 * A chunk that deleted rows VACUUMs the table (review-2 round 9, H3): PGlite
 * runs no autovacuum, and every deleted receipt left a dead row for good — the
 * table grew six times its retention's size in half a year, and the prune with
 * it. Only when something went, so a pass with nothing to prune costs nothing
 * more (services/skeleton-identity.ts does the same). Per chunk, not once at
 * the end: a VACUUM of a chunk's dead rows takes a millisecond or two, one of a
 * million took 230 ms.
 */
export const pruneRecordReceipts = async (deps: Deps): Promise<number> => {
  const cutoff = new Date(deps.now().getTime() - RECORD_RECEIPT_RETENTION_DAYS * MS_PER_DAY);
  let pruned = 0;
  for (;;) {
    const chunk = await deleteChunk(deps, cutoff);
    pruned += chunk;
    await yieldToRequests();
    if (chunk === 0) {
      return pruned;
    }
    await deps.db.execute(sql`VACUUM record_receipts`);
    await yieldToRequests();
    if (chunk < RECORD_RECEIPT_PRUNE_CHUNK) {
      return pruned;
    }
  }
};
