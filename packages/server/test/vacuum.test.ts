/**
 * EVERY VACUUM THE HUB RUNS IS ONE WITHOUT PARALLEL WORKERS, AT A BOUNDED
 * CADENCE (batch-2 integration review, follow-up to M10).
 *
 * PGlite runs no autovacuum, so the passes that delete or rewrite rows VACUUM
 * what they touched: the words backfill, the skeleton identity backfill and
 * the record receipts prune. A plain VACUUM may plan parallel index
 * vacuuming, which maps a dynamic shared memory segment, and on the review's
 * synthetic hub PGlite failed to map one ("could not map shared memory
 * segment": out of memory) after a few hundred VACUUMs in one process — the
 * receipts prune ran one per chunk, every day, in the same long-lived
 * process. So:
 *
 *   - db/vacuum.ts is the one place a VACUUM is spelled, as
 *     `VACUUM (PARALLEL 0) <table>`;
 *   - no other server source spells one;
 *   - the receipts prune VACUUMs every CHUNKS_PER_VACUUM chunks and once
 *     after its last, as the words backfill does — not after every chunk.
 */
import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sql } from "drizzle-orm";

import { CHUNKS_PER_VACUUM, MS_PER_DAY, RECORD_RECEIPT_PRUNE_CHUNK, RECORD_RECEIPT_RETENTION_DAYS } from "../src/constants.ts";
import { vacuumTable } from "../src/db/vacuum.ts";
import { pruneRecordReceipts } from "../src/services/record-receipts.ts";
import { createHarnessWithSession, createTestHarness } from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const SERVER_SRC = resolve(import.meta.dir, "..", "src");
const VACUUM_MODULE = join(SERVER_SRC, "db", "vacuum.ts");

interface Recorder {
  query: (text: string, ...rest: unknown[]) => Promise<unknown>;
}

/** Every VACUUM statement the database is sent while `act` runs. */
const vacuumsDuring = async (harness: TestHarness, act: () => Promise<unknown>): Promise<readonly string[]> => {
  const client = (harness.db as unknown as { $client: Recorder }).$client;
  const query = client.query.bind(client);
  const seen: string[] = [];
  client.query = (text: string, ...rest: unknown[]) => {
    if (/^\s*VACUUM\b/i.test(text)) {
      seen.push(text.replace(/\s+/g, " ").trim());
    }
    return query(text, ...rest);
  };
  try {
    await act();
  } finally {
    client.query = query;
  }
  return seen;
};

const sourcesUnder = async (dir: string): Promise<readonly string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return sourcesUnder(path);
      }
      return Promise.resolve(entry.name.endsWith(".ts") ? [path] : []);
    }),
  );
  return nested.flat();
};

/** `count` receipts past the retention; the time to prune them at. */
const expiredReceipts = async (harness: TestHarness, developerId: string, count: number): Promise<Date> => {
  const now = harness.clock.now();
  const expiredS = Math.floor(now.getTime() / 1000) - (RECORD_RECEIPT_RETENTION_DAYS + 1) * (MS_PER_DAY / 1000);
  await harness.db.execute(
    sql.raw(`INSERT INTO record_receipts (id, developer_id, result_id, received_at)
      SELECT 'env_' || g, '${developerId}', NULL, to_timestamp(${String(expiredS)} + g)
      FROM generate_series(1, ${String(count)}) g`),
  );
  return now;
};

describe("one VACUUM, spelled once (follow-up to M10)", () => {
  test("vacuumTable runs it without parallel workers", async () => {
    // Arrange
    const harness = await createTestHarness();

    // Act
    const vacuums = await vacuumsDuring(harness, () => vacuumTable(harness.db, "record_receipts"));

    // Assert
    expect(vacuums).toEqual(['VACUUM (PARALLEL 0) "record_receipts"']);
  });

  test("no server source but db/vacuum.ts spells a VACUUM statement", async () => {
    // Arrange
    const sources = (await sourcesUnder(SERVER_SRC)).filter((path) => path !== VACUUM_MODULE);

    // Act
    const spelled = (
      await Promise.all(
        sources.map(async (path) => ((await Bun.file(path).text()).match(/sql`\s*VACUUM\b/g) === null ? [] : [path])),
      )
    ).flat();

    // Assert
    expect(spelled).toEqual([]);
  });
});

describe("the record receipts prune VACUUMs at the words backfill's cadence (follow-up to M10)", () => {
  test("every CHUNKS_PER_VACUUM chunks and once after the last, each without parallel workers", async () => {
    // Arrange — two full rounds of chunks and a half chunk after them
    const { harness, developer } = await createHarnessWithSession();
    const expired = 2 * CHUNKS_PER_VACUUM * RECORD_RECEIPT_PRUNE_CHUNK + RECORD_RECEIPT_PRUNE_CHUNK / 2;
    const now = await expiredReceipts(harness, developer.developerId, expired);

    // Act
    let pruned = 0;
    const vacuums = await vacuumsDuring(harness, async () => {
      pruned = await pruneRecordReceipts({ db: harness.db, now: () => now });
    });

    // Assert
    expect(pruned).toBe(expired);
    expect(vacuums).toEqual(Array.from({ length: 3 }, () => 'VACUUM (PARALLEL 0) "record_receipts"'));
  }, 120_000);

  test("a backlog that ends on a full chunk still VACUUMs after it", async () => {
    // Arrange — three full chunks: none reaches the cadence, the last is full
    const { harness, developer } = await createHarnessWithSession();
    const now = await expiredReceipts(harness, developer.developerId, 3 * RECORD_RECEIPT_PRUNE_CHUNK);

    // Act
    const vacuums = await vacuumsDuring(harness, () => pruneRecordReceipts({ db: harness.db, now: () => now }));

    // Assert
    expect(vacuums).toEqual(['VACUUM (PARALLEL 0) "record_receipts"']);
  });

  test("a prune with nothing to delete VACUUMs nothing", async () => {
    // Arrange
    const harness = await createTestHarness();

    // Act
    const vacuums = await vacuumsDuring(harness, () => pruneRecordReceipts({ db: harness.db, now: harness.clock.now }));

    // Assert
    expect(vacuums).toEqual([]);
  });
});
