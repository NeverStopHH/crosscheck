/**
 * `hint_outcomes` in BOTH DDL authorities (1.0 spec 07 §13).
 *
 * drizzle's `schema.ts` is what every service writes by and `bootstrap.sql` is
 * what every hub runs; a table in one spelled differently from the other is a
 * hub that 500s on exactly the deployments that run the SQL. The reason's
 * bound is a database fact held to the same constant the route applies.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { MAX_HINT_OUTCOME_REASON_CHARS } from "@crosscheck/schema";

import { hintOutcomes } from "../src/db/schema.ts";
import { BOOTSTRAP_SQL_URL } from "./fixtures/bootstrap-sql.ts";
import { createTestHarness } from "./helpers.ts";

const REASON_CHECK_PATTERN =
  /hint_outcomes_reason_length_check\s+CHECK \(reason IS NULL OR char_length\(reason\) <= (\d+)\)/;

describe("hint_outcomes DDL sync", () => {
  test("the table has drizzle's columns on a real bootstrap", async () => {
    // Arrange
    const harness = await createTestHarness();
    const drizzleColumns = getTableConfig(hintOutcomes)
      .columns.map((column) => column.name)
      .sort();

    // Act
    const columns = await harness.db.execute(
      sql`SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'hint_outcomes' ORDER BY column_name`,
    );

    // Assert
    expect(columns.rows.map((row) => String(row["c"]))).toEqual(drizzleColumns);
  });

  test("the reason's bound is the schema constant, in the SQL and in the database", async () => {
    // Arrange
    const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();
    const harness = await createTestHarness();

    // Act
    const match = REASON_CHECK_PATTERN.exec(bootstrapSql);
    const constraint = await harness.db.execute(
      sql`SELECT conname AS n FROM pg_constraint WHERE conname = 'hint_outcomes_reason_length_check'`,
    );

    // Assert
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(MAX_HINT_OUTCOME_REASON_CHARS);
    expect(constraint.rows).toHaveLength(1);
  });

  test("'the current outcome of a delivery' is an index range, not a scan", async () => {
    // Arrange
    const harness = await createTestHarness();

    // Act
    const rows = await harness.db.execute(
      sql`SELECT indexdef AS d FROM pg_indexes WHERE indexname = 'hint_outcomes_delivery_created_idx'`,
    );

    // Assert
    const definition = String(rows.rows[0]?.["d"] ?? "");
    expect(definition).toContain("delivery_id");
    expect(definition).toContain("created_at DESC");
  });
});
