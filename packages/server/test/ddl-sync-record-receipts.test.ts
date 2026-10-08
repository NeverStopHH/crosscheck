/**
 * DDL sync for the receipts' key (review-2 round 9, L3): one receipt per
 * developer and envelope id. Keyed by the id alone, the first developer to
 * send an id held it, and another developer's envelope under it was never
 * receipted — its re-send after its producer ended was refused, and counted
 * lost. Both DDL sources hold the key to the pair; an existing hub's key over
 * the id alone is swapped once, and a restart leaves it alone.
 *
 * Its own file because ddl-sync.test.ts is past the 800-line bound; the
 * helpers both read bootstrap.sql through are in fixtures/bootstrap-sql.ts.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import { recordReceipts } from "../src/db/schema.ts";
import { BOOTSTRAP_SQL_URL, guardedBlockNamed } from "./fixtures/bootstrap-sql.ts";
import { createTestHarness } from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const PAIR_KEY = "PRIMARY KEY (developer_id, id)";

const keyOf = async (harness: TestHarness): Promise<{ readonly oid: string; readonly def: string }> => {
  const result = (await harness.db.execute(
    sql`SELECT oid::text AS oid, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'record_receipts_pkey'`,
  )) as unknown as { readonly rows: readonly { readonly oid: string; readonly def: string }[] };
  return result.rows[0] ?? { oid: "", def: "" };
};

describe("bootstrap.sql DDL sync — the receipts' key (review-2 round 9, L3)", () => {
  test("both DDL sources key a receipt by its developer and its envelope id", async () => {
    // Arrange
    const harness = await createTestHarness();

    // Act
    const drizzleKey = getTableConfig(recordReceipts).primaryKeys[0]?.columns.map((column) => column.name);
    const bootstrapped = await keyOf(harness);

    // Assert
    expect(drizzleKey).toEqual(["developer_id", "id"]);
    expect(bootstrapped.def).toBe(PAIR_KEY);
  });

  test("a hub keyed by the id alone is re-keyed once, and a restart leaves it alone", async () => {
    // Arrange: a hub bootstrapped before the key carried the developer
    const harness = await createTestHarness();
    const block = guardedBlockNamed(await Bun.file(BOOTSTRAP_SQL_URL).text(), "record_receipts_pkey");
    await harness.db.execute(sql`ALTER TABLE record_receipts DROP CONSTRAINT record_receipts_pkey`);
    await harness.db.execute(sql`ALTER TABLE record_receipts ADD CONSTRAINT record_receipts_pkey PRIMARY KEY (id)`);

    // Act
    await harness.db.execute(sql.raw(block));
    const upgraded = await keyOf(harness);
    await harness.db.execute(sql.raw(block));
    const restarted = await keyOf(harness);

    // Assert
    expect(upgraded.def).toBe(PAIR_KEY);
    expect(restarted.oid).toBe(upgraded.oid);
  });
});
