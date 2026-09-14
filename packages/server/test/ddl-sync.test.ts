import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
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
const PINS_CHECK_RECIPE_PATTERN =
  /pins_check_length_check\s+CHECK \(check_recipe IS NULL OR char_length\(check_recipe\) <= (\d+)\)/;

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
    const widener = bootstrapSql.slice(bootstrapSql.indexOf("DO $$"));
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
