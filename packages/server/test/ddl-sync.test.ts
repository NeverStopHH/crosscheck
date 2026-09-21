import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  MAX_CI_TEST_ID_CHARS,
  MAX_CLAIM_BODY_LENGTH,
  MAX_PIN_CHECK_CHARS,
  MAX_PIN_SURFACE_CHARS,
  MAX_QUESTION_BODY_LENGTH,
} from "@crosscheck/schema";

import { createTestHarness } from "./helpers.ts";

const BOOTSTRAP_SQL_URL = new URL("../src/db/bootstrap.sql", import.meta.url);
const CLAIMS_BODY_CHECK_PATTERN =
  /claims_body_length_check CHECK \(char_length\(body\) <= (\d+)\)/;
const QUESTIONS_BODY_CHECK_PATTERN =
  /questions_body_length_check\s+CHECK \(char_length\(body\) <= (\d+)\)/;
const PINS_SURFACE_CHECK_PATTERN =
  /pins_surface_length_check CHECK \(char_length\(surface\) <= (\d+)\)/;
const CI_TEST_ID_CHECK_PATTERN =
  /ci_test_results_test_id_length_check\s+CHECK \(char_length\(test_id\) <= (\d+)\)/;
const PINS_CHECK_RECIPE_PATTERN =
  /pins_check_length_check\s+CHECK \(check_recipe IS NULL OR char_length\(check_recipe\) <= (\d+)\)/;

/**
 * The one guarded `DO $$ … $$;` block that mentions a given constraint.
 *
 * bootstrap.sql holds several, and it runs top to bottom on every hub start;
 * picking one by its own name is the only extraction that stays correct as
 * blocks are appended below it.
 */
const guardedBlockNamed = (sql: string, constraintName: string): string => {
  const blocks = sql.match(/DO \$\$[\s\S]*?END\s*\n\$\$;/g) ?? [];
  const matching = blocks.filter((block) => block.includes(constraintName));
  if (matching.length !== 1) {
    throw new Error(
      `expected exactly 1 guarded block naming ${constraintName}, found ${String(matching.length)}`,
    );
  }
  return matching[0] ?? "";
};

describe("bootstrap.sql DDL sync", () => {
  test("claims body CHECK matches MAX_CLAIM_BODY_LENGTH", async () => {
    // Arrange
    const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();

    // Act
    const match = bootstrapSql.match(CLAIMS_BODY_CHECK_PATTERN);

    // Assert
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(MAX_CLAIM_BODY_LENGTH);
  });

  test("questions body CHECK matches MAX_QUESTION_BODY_LENGTH", async () => {
    // Arrange: bootstrap.sql is the DDL a real-Postgres hub runs, and drizzle
    // is the migration authority — a cap that drifts between them lets one
    // deployment accept a body the other refuses.
    const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();

    // Act
    const match = bootstrapSql.match(QUESTIONS_BODY_CHECK_PATTERN);

    // Assert
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(MAX_QUESTION_BODY_LENGTH);
  });

  test("pins CHECKs match the pin caps in @crosscheck/schema", async () => {
    // Arrange: the pin registry is written by TWO DDL authorities — this file
    // on a real-Postgres hub and drizzle's schema.ts everywhere else — so a
    // cap that drifts between them lets one deployment store a surface label
    // the other refuses, and the refusal surfaces as a 500 on a person's
    // `crosscheck pin`.
    const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();

    // Act
    const surface = bootstrapSql.match(PINS_SURFACE_CHECK_PATTERN);
    const recipe = bootstrapSql.match(PINS_CHECK_RECIPE_PATTERN);

    // Assert
    expect(surface).not.toBeNull();
    expect(Number(surface?.[1])).toBe(MAX_PIN_SURFACE_CHARS);
    expect(recipe).not.toBeNull();
    expect(Number(recipe?.[1])).toBe(MAX_PIN_CHECK_CHARS);
  });

  test("ci_test_results test_id CHECK matches MAX_CI_TEST_ID_CHARS", async () => {
    // Arrange: the wire bound and the column bound are two authorities over
    // one value. A test id longer than the column accepts would be refused by
    // the database AFTER the route said yes, so the run would land with its
    // list one row shorter and nothing would say which row went missing —
    // a silently shortened list, which is the absence this spec refuses.
    const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();

    // Act
    const match = bootstrapSql.match(CI_TEST_ID_CHECK_PATTERN);

    // Assert
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(MAX_CI_TEST_ID_CHARS);
  });

  test("the two CI tables exist in both authorities, with their indexes", async () => {
    // drizzle is the migration authority and bootstrap.sql is what a real
    // Postgres hub actually runs; a table in one and not the other is a hub
    // that accepts a write on one deployment and 42P01s on the other.
    const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();
    for (const name of [
      "CREATE TABLE IF NOT EXISTS ci_runs",
      "CREATE TABLE IF NOT EXISTS ci_test_results",
      "ci_runs_repo_commit_idx",
      "ci_runs_lane_started_idx",
      "ci_runs_rerun_of_idx",
      "ci_test_results_repo_test_idx",
    ]) {
      expect(bootstrapSql).toContain(name);
    }

    // And the cascade, which retention depends on: an orphan result row would
    // assert a failure belonging to a run nobody can look up.
    expect(bootstrapSql).toContain("REFERENCES ci_runs(id) ON DELETE CASCADE");
  });

  test("a restart does not drop and revalidate the body-length constraint", async () => {
    // Arrange: bootstrap.sql runs in full on EVERY hub start (db/client.ts
    // reads and execs the whole file), and the body-length widener was an
    // unconditional DROP CONSTRAINT IF EXISTS followed by ADD CONSTRAINT. ADD
    // takes ACCESS EXCLUSIVE and revalidates every row, so on a hub with a
    // large claims table every restart pays a full-table exclusive lock to
    // re-prove a constraint that already holds — and between the two
    // statements there is a window, widening with the table, in which a
    // concurrent writer faces no body bound at all.
    //
    // A RE-ADDED CONSTRAINT GETS A NEW OID, so an unchanged oid across a
    // second run is exactly the evidence that the guard held.
    // The harness already ran the whole file once (createDb). Re-running just
    // the widener is what a restart repeats and is the only statement under
    // test; the file as a whole cannot go through db.execute, which prepares
    // a single command.
    const harness = await createTestHarness();
    const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();
    // THE BLOCK IS FOUND BY NAME, not by position. This read
    // `slice(indexOf("DO $$"))` — everything from the first guarded block to
    // the end of the file — which was correct only while the widener happened
    // to be the LAST thing in bootstrap.sql. Spec 05 appended two tables and a
    // guard of its own below it, and the slice then carried three statements
    // into a `db.execute` that prepares exactly one. A test that breaks when
    // unrelated SQL is appended was not testing what it said.
    const widener = guardedBlockNamed(bootstrapSql, "claims_body_length_check");
    const oidOfCheck = async (): Promise<string> => {
      const result = (await harness.db.execute(
        sql`SELECT oid::text AS oid FROM pg_constraint WHERE conname = 'claims_body_length_check'`,
      )) as unknown as { readonly rows: readonly { readonly oid: string }[] };
      return result.rows[0]?.oid ?? "";
    };
    const before = await oidOfCheck();

    // Act: the same statement, a second time, exactly as a restart runs it.
    expect(widener).toContain("claims_body_length_check");
    await harness.db.execute(sql.raw(widener));
    const after = await oidOfCheck();

    // Assert: the constraint is there, and it is the SAME one.
    expect(before).not.toBe("");
    expect(after).toBe(before);

    // AND THE OID CHECK HAS TEETH, proved here rather than assumed: the
    // unguarded pair this replaced does move it. Without this the assertion
    // above would also pass against a constraint nothing ever touches.
    await harness.db.execute(
      sql`ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_body_length_check`,
    );
    await harness.db.execute(
      sql`ALTER TABLE claims ADD CONSTRAINT claims_body_length_check CHECK (char_length(body) <= 10000)`,
    );
    expect(await oidOfCheck()).not.toBe(before);
  });

  test("work_context_targets.created_at is added for the #19 pointer age", async () => {
    // Arrange: the drizzle column is nullable, so bootstrap must add it with
    // the same ADD COLUMN IF NOT EXISTS evolution idiom or a fresh DB and an
    // upgraded one disagree on the schema.
    const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();

    // Assert
    expect(bootstrapSql).toContain(
      "ALTER TABLE work_context_targets ADD COLUMN IF NOT EXISTS created_at timestamptz;",
    );
  });
});
