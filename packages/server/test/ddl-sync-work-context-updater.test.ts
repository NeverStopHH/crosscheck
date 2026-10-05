/**
 * DDL sync for `work_contexts.updated_by_session_id` (review of H3, finding
 * 3): the producer of a context's latest update, read by coverage's path
 * scope. Both DDL sources hold it, nullable and referencing the session, and
 * an EXISTING hub gets it by ALTER — a column only in the CREATE never
 * reaches a hub that already has the table.
 *
 * Its own file because ddl-sync.test.ts is past the 800-line bound.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import { workContexts } from "../src/db/schema.ts";
import { BOOTSTRAP_SQL_URL } from "./fixtures/bootstrap-sql.ts";
import { createTestHarness } from "./helpers.ts";

const ALTER =
  "ALTER TABLE work_contexts ADD COLUMN IF NOT EXISTS updated_by_session_id text REFERENCES agent_sessions(id);";

describe("bootstrap.sql DDL sync — the session behind a work context's latest update", () => {
  test("the column is in both DDL sources, nullable, referencing the session", async () => {
    // Arrange
    const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();
    const config = getTableConfig(workContexts);
    // Act
    const column = config.columns.find((entry) => entry.name === "updated_by_session_id");
    const references = config.foreignKeys.flatMap((key) =>
      key.reference().columns.map((entry) => entry.name),
    );
    // Assert
    expect(bootstrapSql).toContain(ALTER);
    expect(column?.notNull).toBe(false);
    expect(references).toContain("updated_by_session_id");
  });

  test("the column really exists after a bootstrap, and a restart's second ALTER leaves it alone", async () => {
    // Arrange: the harness already ran the whole file once (createDb).
    const harness = await createTestHarness();
    const nullable = async (): Promise<readonly string[]> => {
      const rows = await harness.db.execute(
        sql`SELECT is_nullable AS n FROM information_schema.columns WHERE table_name = 'work_contexts' AND column_name = 'updated_by_session_id'`,
      );
      return rows.rows.map((row) => String(row.n));
    };
    const afterBootstrap = await nullable();
    // Act: the statement a restart repeats; the file as a whole cannot go
    // through db.execute, which prepares a single command.
    await harness.db.execute(sql.raw(ALTER));
    // Assert
    expect(afterBootstrap).toEqual(["YES"]);
    expect(await nullable()).toEqual(["YES"]);
  });
});
