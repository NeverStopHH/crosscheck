/**
 * THE BOOT AND UPGRADE DDL OF THE BATCH-2 INTEGRATION REVIEW, in both DDL
 * authorities: bootstrap.sql (what a hub runs on every start) and drizzle's
 * schema.ts (what every service writes by).
 *
 * H6: the draft-link cleanup's wire-record lookup reads
 * events_claim_edge_added_edge_idx, an expression index on the edge id of
 * claim_edge_added events only.
 *
 * M10: `words_tsv` is a PLAIN column in both — no generation expression, so
 * adding it rewrites no table — with its GIN index and the partial index of
 * the rows the background backfill has yet to fill.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import { claims, events, workContexts } from "../src/db/schema.ts";
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

describe("the words column and its indexes (M10)", () => {
  const WORDS_INDEXES = {
    claims: ["claims_words_tsv_idx", "claims_words_tsv_pending_idx"],
    work_contexts: ["work_contexts_words_tsv_idx", "work_contexts_words_tsv_pending_idx"],
  } as const;

  test("drizzle declares words_tsv plain on both tables, with both indexes", () => {
    // Arrange
    const tables = [getTableConfig(claims), getTableConfig(workContexts)];

    // Act
    const shapes = tables.map((config) => ({
      table: config.name,
      generated: config.columns.find((column) => column.name === "words_tsv")?.generated ?? null,
      indexes: config.indexes.map((index) => index.config.name).filter((name) => name?.includes("words_tsv")).sort(),
    }));

    // Assert
    expect(shapes).toEqual([
      { table: "claims", generated: null, indexes: [...WORDS_INDEXES.claims] },
      { table: "work_contexts", generated: null, indexes: [...WORDS_INDEXES.work_contexts] },
    ]);
  });

  test("bootstrap.sql builds the same: a plain column, the GIN index, and the pending rows' partial index", async () => {
    // Arrange
    const harness = await createTestHarness();

    // Act
    const columns = await harness.db.execute<{ table: string; generated: string; nullable: string }>(
      sql`SELECT table_name AS table, is_generated AS generated, is_nullable AS nullable FROM information_schema.columns WHERE column_name = 'words_tsv' ORDER BY table_name`,
    );
    const indexes = await harness.db.execute<{ name: string; def: string }>(
      sql`SELECT indexname AS name, indexdef AS def FROM pg_indexes WHERE indexname LIKE '%words_tsv%' ORDER BY indexname`,
    );

    // Assert
    expect(columns.rows).toEqual([
      { table: "claims", generated: "NEVER", nullable: "YES" },
      { table: "work_contexts", generated: "NEVER", nullable: "YES" },
    ]);
    expect(indexes.rows.map((row) => row.name)).toEqual([...WORDS_INDEXES.claims, ...WORDS_INDEXES.work_contexts]);
    expect(indexes.rows.filter((row) => row.name.endsWith("_pending_idx")).map((row) => row.def)).toEqual([
      expect.stringContaining("WHERE (words_tsv IS NULL)"),
      expect.stringContaining("WHERE (words_tsv IS NULL)"),
    ]);
  });
});
