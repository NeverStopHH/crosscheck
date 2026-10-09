/**
 * ONE VACUUM OF ONE TABLE, the only way the hub spells it (batch-2
 * integration review, follow-up to M10; test/vacuum.test.ts holds every other
 * server source to it).
 *
 * PGlite runs no autovacuum, so a pass that deletes or rewrites rows VACUUMs
 * what it touched: the words backfill (services/words-index.ts), the skeleton
 * identity backfill (services/skeleton-identity.ts) and the record receipts
 * prune (services/record-receipts.ts). PARALLEL 0: a plain VACUUM may plan
 * parallel index vacuuming, which maps a dynamic shared memory segment, and
 * PGlite failed to map one ("could not map shared memory segment": out of
 * memory) after a few hundred VACUUMs in one process on the review's
 * synthetic hub. The hub is one long-lived process.
 *
 * A VACUUM cannot run inside a transaction: every caller hands it the
 * database its pass was given, never an open transaction.
 */
import { sql } from "drizzle-orm";

import type { DbExecutor } from "./client.ts";

/** The tables a pass VACUUMs. */
export type VacuumedTable = "claims" | "work_contexts" | "record_receipts" | "session_events";

export const vacuumTable = async (db: DbExecutor, table: VacuumedTable): Promise<void> => {
  await db.execute(sql`VACUUM (PARALLEL 0) ${sql.identifier(table)}`);
};
