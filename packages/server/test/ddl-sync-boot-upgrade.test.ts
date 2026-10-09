/**
 * THE BOOT AND UPGRADE DDL OF THE BATCH-2 INTEGRATION REVIEW, in both DDL
 * authorities: bootstrap.sql (what a hub runs on every start) and drizzle's
 * schema.ts (what every service writes by).
 *
 * H6: the draft-link cleanup's wire-record lookup reads
 * events_claim_edge_added_edge_idx, an expression index on the edge id of
 * claim_edge_added events only.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import { events } from "../src/db/schema.ts";
import { BOOTSTRAP_SQL_URL } from "./fixtures/bootstrap-sql.ts";
import { createTestHarness } from "./helpers.ts";

const WIRE_RECORD_INDEX = "events_claim_edge_added_edge_idx";

describe("the draft-link cleanup's wire-record index (H6)", () => {
  test("bootstrap.sql builds it on the edge id, for claim_edge_added events only", async () => {
    // Arrange
    const harness = await createTestHarness();

    // Act
    const rows = await harness.db.execute<{ def: string }>(
      sql`SELECT indexdef AS def FROM pg_indexes WHERE indexname = ${WIRE_RECORD_INDEX}`,
    );

    // Assert
    const definition = rows.rows[0]?.def ?? "";
    expect(definition).toContain("((payload ->> 'edgeId'::text))");
    expect(definition).toContain("WHERE (kind = 'claim_edge_added'::text)");
  });

  test("drizzle's schema.ts declares the same index", async () => {
    // Arrange
    const bootstrap = await Bun.file(BOOTSTRAP_SQL_URL).text();

    // Act
    const names = getTableConfig(events).indexes.map((index) => index.config.name);

    // Assert
    expect(names).toContain(WIRE_RECORD_INDEX);
    expect(bootstrap).toContain(`CREATE INDEX IF NOT EXISTS ${WIRE_RECORD_INDEX}\n`);
  });
});
