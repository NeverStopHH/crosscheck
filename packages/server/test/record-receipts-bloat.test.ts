/**
 * THE RECEIPTS TABLE STAYS ITS RETENTION'S SIZE (review-2 round 9, H3).
 *
 * PGlite runs no autovacuum, so every receipt the daily prune deleted left a
 * dead row behind for good: at 10 000 receipts a day the table grew from
 * 74 MB at day 30 to 443 MB at day 180, and the prune, paid on the
 * SessionStart register route, from 1 ms to 94 ms. A prune that deleted rows
 * now VACUUMs the table (the skeleton backfill's pattern,
 * services/skeleton-identity.ts), and the space is reused.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { MS_PER_DAY, RECORD_RECEIPT_RETENTION_DAYS } from "../src/constants.ts";
import { pruneRecordReceipts } from "../src/services/record-receipts.ts";
import { createHarnessWithSession } from "./helpers.ts";

const RECEIPTS_PER_DAY = 2000;
const DAYS = 180;
const SECONDS_PER_DAY = MS_PER_DAY / 1000;
/** Near the size at the retention: what a reused table may grow past it. */
const NEAR = 1.25;

describe("the record receipts table over half a year", () => {
  test(`stays near its size at ${String(RECORD_RECEIPT_RETENTION_DAYS)} days after ${String(DAYS)} days of daily prunes`, async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();
    const startS = Math.floor(harness.clock.now().getTime() / 1000);
    const sizeOf = async (): Promise<number> =>
      Number(
        ((await harness.db.execute(sql`select pg_total_relation_size('record_receipts') as size`)).rows[0] as { size: unknown })
          .size,
      );

    // Act: a day of receipts, then the day's prune, for half a year
    let atRetention = 0;
    for (let day = 1; day <= DAYS; day += 1) {
      const dayS = startS + day * SECONDS_PER_DAY;
      await harness.db.execute(
        sql.raw(`INSERT INTO record_receipts (id, developer_id, result_id, received_at)
          SELECT 'env_' || gen_random_uuid()::text, '${developer.developerId}', NULL, to_timestamp(${String(dayS - SECONDS_PER_DAY)} + g)
          FROM generate_series(1, ${String(RECEIPTS_PER_DAY)}) g`),
      );
      await pruneRecordReceipts({ db: harness.db, now: () => new Date(dayS * 1000) });
      if (day === RECORD_RECEIPT_RETENTION_DAYS + 1) {
        atRetention = await sizeOf();
      }
    }

    // Assert
    expect(await sizeOf()).toBeLessThan(atRetention * NEAR);
  }, 120_000);
});
