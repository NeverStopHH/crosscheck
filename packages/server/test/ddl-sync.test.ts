import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  COMMIT_SHA_PATTERN,
  MAX_CLAIM_BODY_LENGTH,
  MAX_INTENT_AMEND_REASON_CHARS,
  MAX_INTENT_SUMMARY_CHARS,
  MAX_PIN_CHECK_CHARS,
  MAX_PIN_SURFACE_CHARS,
  MAX_QUESTION_BODY_LENGTH,
  NO_COMMIT_SHA,
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
/**
 * One `DO $$ … END $$;` block of bootstrap.sql, picked by something inside it.
 *
 * bootstrap.sql now carries MORE THAN ONE guarded block, and the two tests
 * that replay one of them must not replay the other by accident:
 * `db.execute` prepares a SINGLE command, so a slice holding two statements
 * fails for a reason that has nothing to do with what is under test. Named
 * rather than sliced by index for the same reason — the next guarded block
 * appended to that file must not silently re-point either test.
 */
const guardedBlockContaining = (
  bootstrapSql: string,
  needle: string,
): string => {
  const blocks = bootstrapSql.match(/DO \$\$\n[\s\S]*?\nEND\n\$\$;/g) ?? [];
  return blocks.find((block) => block.includes(needle)) ?? "";
};

const INTENT_SUMMARY_CHECK_PATTERN =
  /work_context_intents_summary_length_check CHECK \(char_length\(summary\) <= (\d+)\)/;
const INTENT_REASON_CHECK_PATTERN =
  /work_context_intents_reason_length_check\s+CHECK \(reason IS NULL OR char_length\(reason\) <= (\d+)\)/;

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
    const widener = guardedBlockContaining(
      bootstrapSql,
      "claims_body_length_check",
    );
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

  test("session_events carries the PARTIAL unique index, not a plain one", async () => {
    // Arrange: the harness ran bootstrap.sql in full (createDb), so this asks
    // the database rather than the file — the drizzle schema and this SQL are
    // two DDL authorities, and a hub whose index is plain instead of partial
    // accepts a second event at a position the session already handed out.
    // PARTIAL matters in the other direction too: unsequenced rows are
    // legitimately many per session, and a total unique index would reject
    // every one after the first.
    const harness = await createTestHarness();

    // Act
    const result = (await harness.db.execute(
      sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'session_events_position_idx'`,
    )) as unknown as {
      readonly rows: readonly { readonly indexdef: string }[];
    };

    // Assert
    const definition = result.rows[0]?.indexdef ?? "";
    expect(definition).toContain("CREATE UNIQUE INDEX");
    expect(definition).toContain("session_id");
    expect(definition).toContain("seq_epoch");
    expect(definition).toContain("seq_n");
    expect(definition).toContain("WHERE (seq_epoch IS NOT NULL)");
  });

  test("claims.stale_at is retired and its drop cannot re-fire", async () => {
    // Arrange: `stale_at` had five hits and no writer — a column every reader
    // saw as a permanent null while `get_diagnosis` shipped it as a claim's
    // currency. Retiring it rather than redefining it is the one-authority
    // answer (02 §4): a timestamp beside a state invites the next reader to
    // compute `now() - stale_at` and re-invent the clock definition.
    //
    // THE DROP IS GUARDED, and that is not decoration. bootstrap.sql runs in
    // FULL on every hub start (db/client.ts execs the whole file), and
    // `ALTER TABLE ... DROP COLUMN IF EXISTS` takes ACCESS EXCLUSIVE whether
    // or not the column is there — the same defect the body-length widener
    // above exists to prevent, on a different statement.
    //
    // CCB-2, the grep half: after this commit the only surviving hit is the
    // FROZEN pre-search-block fixture, which is a snapshot of an older
    // database and would become a different fixture if edited.
    //
    // The pattern dodges its own literal on purpose — this directive lives in
    // a file the grep walks, and `stale[A]t` matches the identifier without
    // matching the line that names it (verify-claims.ts's own header warns
    // that an illustration written in the directive's syntax IS a directive).
    // `stale_at timestamptz` is the COLUMN, so prose about the retirement —
    // bootstrap.sql's guarded drop — is not a hit. Scoped to `src` plus the
    // fixture directory: the claim is that no MODULE declares or reads the
    // column, and this test file necessarily names it to assert that.
    //
    // VERIFY: grep -rlE 'stale[A]t|stale_at timestamptz' packages/*/src packages/server/test/fixtures
    // PRINTS: packages/server/test/fixtures/pre-search-block-bootstrap.sql
    const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();

    // Assert: gone from the CREATE TABLE, and dropped only under a guard.
    expect(bootstrapSql).not.toContain("  stale_at timestamptz,");
    const drop = guardedBlockContaining(bootstrapSql, "stale_at");
    expect(drop).toContain("IF EXISTS (");
    expect(drop).toContain("ALTER TABLE claims DROP COLUMN stale_at;");
    // And the guard has teeth: no top-level ALTER may name the column, which
    // is what an unguarded retirement would look like.
    expect(bootstrapSql).not.toMatch(/^ALTER TABLE claims DROP COLUMN/m);
  });

  test("dropping stale_at twice leaves the claims table alone", async () => {
    // Arrange: a restart replays the guarded block against a database that
    // already lost the column. It must be a no-op, not an error and not a
    // second ALTER.
    const harness = await createTestHarness();
    const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();
    const drop = guardedBlockContaining(bootstrapSql, "stale_at");
    const hasStaleAt = async (): Promise<boolean> => {
      const result = (await harness.db.execute(
        sql`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'claims' AND column_name = 'stale_at'`,
      )) as unknown as { readonly rows: readonly { readonly n: number }[] };
      return (result.rows[0]?.n ?? 0) > 0;
    };

    // Act: the harness already ran the file once; this is the restart.
    expect(drop).not.toBe("");
    await harness.db.execute(sql.raw(drop));

    // Assert
    expect(await hasStaleAt()).toBe(false);
  });

  test("the claim commit-binding columns are added and their CHECK is guarded", async () => {
    // Arrange: the drizzle schema declares both columns and the CHECK, so
    // bootstrap.sql — the DDL a real-Postgres hub runs — must add exactly the
    // same two, with the same NOT NULL default, and add the constraint under
    // the ADD-CONSTRAINT guard rather than on every start.
    const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();

    // Assert
    expect(bootstrapSql).toContain(
      "ALTER TABLE claims ADD COLUMN IF NOT EXISTS observed_at_commit text;",
    );
    expect(bootstrapSql).toContain(
      "ALTER TABLE claims ADD COLUMN IF NOT EXISTS commit_binding text NOT NULL DEFAULT 'none';",
    );
    const guard = guardedBlockContaining(
      bootstrapSql,
      "ADD CONSTRAINT claims_commit_binding_check",
    );
    expect(guard).toContain("IF NOT EXISTS (");
    expect(guard).toContain(
      "CHECK ((observed_at_commit IS NULL) = (commit_binding = 'none'));",
    );
    expect(bootstrapSql).not.toMatch(/^ALTER TABLE claims ADD CONSTRAINT/m);
  });

  test("the backfill's base-commit predicate matches isBindableCommit", async () => {
    // Arrange: the migration cannot call TypeScript, so the "is this a commit
    // we can bind to" rule exists twice — once in @crosscheck/schema and once
    // as SQL in bootstrap.sql. Two copies of a rule drift; this is what stops
    // them drifting SILENTLY, since a widened pattern that reached only one
    // side would leave a hub binding claims to strings git never resolves.
    const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();

    // Assert
    expect(bootstrapSql).toContain(
      `s.base_commit ~* '${COMMIT_SHA_PATTERN.source}'`,
    );
    expect(bootstrapSql).toContain(`s.base_commit <> '${NO_COMMIT_SHA}'`);
    expect(COMMIT_SHA_PATTERN.flags).toContain("i");
  });

  test("claim_revalidations exists in both DDL authorities", async () => {
    // Arrange: bootstrap.sql is the DDL a real-Postgres hub runs and drizzle
    // is the migration authority everywhere else. A table in one and not the
    // other means the downgrade-only UPSERT has nowhere to land on exactly
    // one deployment — and the failure surfaces as a 500 on a revalidation.
    const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();

    // Assert
    expect(bootstrapSql).toContain("CREATE TABLE IF NOT EXISTS claim_revalidations (");
    for (const column of [
      "claim_id text PRIMARY KEY REFERENCES claims(id)",
      "result text NOT NULL",
      "basis text NOT NULL",
      "ref_commit text NOT NULL",
      "touching_commits jsonb NOT NULL DEFAULT '[]'::jsonb",
      "touching_total integer",
      "revalidated_at timestamptz NOT NULL",
      "reported_by text NOT NULL REFERENCES developers(id)",
    ]) {
      expect(bootstrapSql).toContain(column);
    }
  });

  test("claim_surfaces exists in both DDL authorities", async () => {
    // Arrange
    const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();

    // Assert: repo is DENORMALISED on purpose — pin_files' reason, one table
    // over — so the index that answers "which rows in this repo watch this
    // path" must exist in both authorities too.
    expect(bootstrapSql).toContain("CREATE TABLE IF NOT EXISTS claim_surfaces (");
    expect(bootstrapSql).toContain("PRIMARY KEY (claim_id, path)");
    expect(bootstrapSql).toContain(
      "CREATE INDEX IF NOT EXISTS claim_surfaces_repo_path_idx",
    );
  });


  test("the intent ledger's CHECKs match the intent caps in @crosscheck/schema", async () => {
    // Arrange: the ledger is written by TWO DDL authorities — this SQL on a
    // real-Postgres hub and drizzle's schema.ts everywhere else — so a cap
    // that drifts between them lets one deployment store a summary the other
    // refuses, and the refusal surfaces as a 500 on somebody's `set_intent`.
    const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();

    // Act
    const summary = bootstrapSql.match(INTENT_SUMMARY_CHECK_PATTERN);
    const reason = bootstrapSql.match(INTENT_REASON_CHECK_PATTERN);

    // Assert
    expect(summary).not.toBeNull();
    expect(Number(summary?.[1])).toBe(MAX_INTENT_SUMMARY_CHARS);
    expect(reason).not.toBeNull();
    expect(Number(reason?.[1])).toBe(MAX_INTENT_AMEND_REASON_CHARS);
  });

  test("the ledger is append-only in the DDL, not only in the service", async () => {
    // Arrange: `services/intent-ledger.ts` exposes no UPDATE and no DELETE
    // path, and that is a statement about ONE file. The database is what makes
    // it a statement about the table: an amendment is a NEW ROW, so the pair
    // that carries a version has to be unique, and a second row claiming a
    // version an amendment already holds must be refused rather than merged.
    const harness = await createTestHarness();

    // Act
    const result = (await harness.db.execute(
      sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'work_context_intents_context_version_idx'`,
    )) as unknown as {
      readonly rows: readonly { readonly indexdef: string }[];
    };

    // Assert
    const definition = result.rows[0]?.indexdef ?? "";
    expect(definition).toContain("CREATE UNIQUE INDEX");
    expect(definition).toContain("work_context_id");
    expect(definition).toContain("version");
  });

  test("a ledger row carries everything an OrderedEvent needs", async () => {
    // Arrange: a row that stored only (seq_epoch, seq) cannot be turned back
    // into the shape `causalComparisonOf` is asked about — the bracket and the
    // lane are what its fifth and sixth conditions read, and without them
    // every intent compares as an unbracketed point of unknown lane, which is
    // the upper-bound-promoted-to-happens-before defect in a new place.
    const harness = await createTestHarness();

    // Act
    const result = (await harness.db.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'work_context_intents'`,
    )) as unknown as {
      readonly rows: readonly { readonly column_name: string }[];
    };

    // Assert
    const columns = new Set(result.rows.map((row) => row.column_name));
    for (const column of [
      "seq_epoch",
      "seq",
      "seq_after",
      "seq_kind",
      "seq_reason",
      "amends_version",
      "author_session_id",
      "version",
      "wire",
    ]) {
      expect(columns).toContain(column);
    }
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
