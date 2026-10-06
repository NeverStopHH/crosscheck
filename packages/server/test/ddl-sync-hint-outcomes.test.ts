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

import { hintDeliveries, hintOutcomes, noiseReassertions, pilotEnrolments, teamSettings } from "../src/db/schema.ts";
import { BOOTSTRAP_SQL_URL } from "./fixtures/bootstrap-sql.ts";
import { labelNoise } from "./fixtures/hint-outcome-crowd.ts";
import { KEN_CONTEXT, createOutcomeWorld, recordOutcome } from "./fixtures/hint-outcome-world.ts";
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

  test("review P5: when the hub received a delivery is a hint_deliveries column in both authorities", async () => {
    // Arrange
    const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();
    const harness = await createTestHarness();

    // Act
    const drizzle = getTableConfig(hintDeliveries).columns.map((column) => column.name);
    const columns = await harness.db.execute(
      sql`SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'hint_deliveries' AND column_name = 'ingested_at'`,
    );

    // Assert — a fresh hub from the CREATE, an existing one from the ALTER
    expect(drizzle).toContain("ingested_at");
    expect(columns.rows).toHaveLength(1);
    expect(bootstrapSql).toContain("  ingested_at timestamptz\n);");
    expect(bootstrapSql).toContain("ALTER TABLE hint_deliveries ADD COLUMN IF NOT EXISTS ingested_at timestamptz;");
  });

  test("review H-B: the person's re-asserted noise is a table with drizzle's columns on a real bootstrap", async () => {
    // Arrange
    const harness = await createTestHarness();
    const drizzleColumns = getTableConfig(noiseReassertions)
      .columns.map((column) => column.name)
      .sort();

    // Act
    const columns = await harness.db.execute(
      sql`SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'noise_reassertions' ORDER BY column_name`,
    );

    // Assert
    expect(columns.rows.map((row) => String(row["c"]))).toEqual(drizzleColumns);
  });

  test("review M3: the enrolment history is a table with drizzle's columns on a real bootstrap", async () => {
    // Arrange
    const harness = await createTestHarness();
    const drizzleColumns = getTableConfig(pilotEnrolments)
      .columns.map((column) => column.name)
      .sort();

    // Act
    const columns = await harness.db.execute(
      sql`SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'pilot_enrolments' ORDER BY column_name`,
    );

    // Assert
    expect(columns.rows.map((row) => String(row["c"]))).toEqual(drizzleColumns);
  });

  test("review LOW: at most one open interval per repo is a database fact, and a zero-length one beside it is not a clash", async () => {
    // Arrange — one interval closed at the very instant the next opens, then a second open one
    const harness = await createTestHarness();
    const at = "2026-07-24T09:00:00Z";
    await harness.db.execute(sql`INSERT INTO pilot_enrolments (id, repo, started_at, ended_at)
      VALUES ('pe_closed', 'github.com/acme/api', ${at}, ${at}), ('pe_open', 'github.com/acme/api', ${at}, NULL)`);

    // Act
    const second = (async () =>
      await harness.db.execute(sql`INSERT INTO pilot_enrolments (id, repo, started_at, ended_at)
        VALUES ('pe_second', 'github.com/acme/api', '2026-07-25T09:00:00Z', NULL)`))();

    // Assert
    await expect(second).rejects.toThrow();
  });

  test("review M3: an upgraded hub keeps the enrolment it already had as its first interval", async () => {
    // Arrange — the shape before the history: one repo enrolled, one that left, one never enrolled
    const harness = await createTestHarness();
    for (const statement of [
      sql`DROP TABLE pilot_enrolments`,
      sql`INSERT INTO team_settings (repo, pin_policy, suspect_attribution, pilot_enrolled, pilot_outcomes_since, updated_at)
          VALUES ('github.com/acme/api', 'anyone', 'sessions', true, '2026-07-24T09:00:00Z', '2026-07-24T09:00:00Z'),
                 ('github.com/acme/old', 'anyone', 'sessions', false, '2026-07-01T09:00:00Z', '2026-07-20T09:00:00Z'),
                 ('github.com/acme/web', 'anyone', 'sessions', false, NULL, '2026-07-24T09:00:00Z')`,
    ]) {
      await harness.db.execute(statement);
    }
    const client = (harness.db as unknown as { $client: { exec: (text: string) => Promise<unknown> } }).$client;

    // Act — twice: the backfill must not double an interval
    await client.exec(await Bun.file(BOOTSTRAP_SQL_URL).text());
    await client.exec(await Bun.file(BOOTSTRAP_SQL_URL).text());

    // Assert — review M-3: a repo that left ends at its last PROVEN enrolled instant; with no
    // word recorded there is none after the start, never its last settings write (that is
    // when it left at the latest, not when it was last in the pilot)
    const intervals = await harness.db.execute(
      sql`SELECT repo AS r, started_at::text AS s, ended_at::text AS e, reconstructed AS x FROM pilot_enrolments ORDER BY repo`,
    );
    expect(intervals.rows).toEqual([
      { r: "github.com/acme/api", s: "2026-07-24 09:00:00+00", e: null, x: true },
      { r: "github.com/acme/old", s: "2026-07-01 09:00:00+00", e: "2026-07-01 09:00:00+00", x: true },
    ]);
  });

  test("review M-3 (probe F): the backfill starts at the earliest proven instant and ends a left repo at its newest word", async () => {
    // Arrange — enrolled at 09:00; an outcome at 10:00 and a noise label at 11:00 — then the
    // pre-history shape: the first-recordable instant restamped a day later, the repo left, and
    // its last settings write weeks after that
    const world = await createOutcomeWorld();
    world.harness.clock.advanceSeconds(3600);
    await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    world.harness.clock.advanceSeconds(3600);
    await labelNoise(world, world.nick, world.delivered.mikeContext);
    for (const statement of [
      sql`DROP TABLE pilot_enrolments`,
      sql`UPDATE team_settings SET pilot_enrolled = false,
            pilot_outcomes_since = '2026-07-25T09:00:00Z', updated_at = '2026-08-20T09:00:00Z'`,
    ]) {
      await world.harness.db.execute(statement);
    }
    const client = (world.harness.db as unknown as { $client: { exec: (text: string) => Promise<unknown> } }).$client;

    // Act
    await client.exec(await Bun.file(BOOTSTRAP_SQL_URL).text());
    await client.exec(await Bun.file(BOOTSTRAP_SQL_URL).text());

    // Assert — from the first outcome (not the restamped instant) to the newest label (not the last write)
    const intervals = await world.harness.db.execute(
      sql`SELECT started_at::text AS s, ended_at::text AS e, reconstructed AS x FROM pilot_enrolments`,
    );
    expect(intervals.rows).toEqual([{ s: "2026-07-24 10:00:00+00", e: "2026-07-24 11:00:00+00", x: true }]);
  });

  test("review M-3: a label before the first outcome starts the reconstructed interval, and an outcome after it ends it", async () => {
    // Arrange — the mirror order: a noise label at 10:00, an outcome at 11:00
    const world = await createOutcomeWorld();
    world.harness.clock.advanceSeconds(3600);
    await labelNoise(world, world.nick, world.delivered.mikeContext);
    world.harness.clock.advanceSeconds(3600);
    await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    for (const statement of [
      sql`DROP TABLE pilot_enrolments`,
      sql`UPDATE team_settings SET pilot_enrolled = false,
            pilot_outcomes_since = '2026-07-25T09:00:00Z', updated_at = '2026-08-20T09:00:00Z'`,
    ]) {
      await world.harness.db.execute(statement);
    }
    const client = (world.harness.db as unknown as { $client: { exec: (text: string) => Promise<unknown> } }).$client;

    // Act
    await client.exec(await Bun.file(BOOTSTRAP_SQL_URL).text());

    // Assert
    const intervals = await world.harness.db.execute(
      sql`SELECT started_at::text AS s, ended_at::text AS e FROM pilot_enrolments`,
    );
    expect(intervals.rows).toEqual([{ s: "2026-07-24 10:00:00+00", e: "2026-07-24 11:00:00+00" }]);
  });

  test("when outcomes became recordable is a team_settings column in both authorities", async () => {
    // Arrange
    const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();
    const harness = await createTestHarness();

    // Act
    const drizzle = getTableConfig(teamSettings).columns.map((column) => column.name);
    const columns = await harness.db.execute(
      sql`SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'team_settings' AND column_name = 'pilot_outcomes_since'`,
    );

    // Assert — a fresh hub from the CREATE, an existing one from the ALTER
    expect(drizzle).toContain("pilot_outcomes_since");
    expect(columns.rows).toHaveLength(1);
    expect(bootstrapSql).toContain("  pilot_outcomes_since timestamptz,");
    expect(bootstrapSql).toContain("ALTER TABLE team_settings ADD COLUMN IF NOT EXISTS pilot_outcomes_since timestamptz");
  });

  test("an upgraded hub stamps outcomes-since for a repo already enrolled, and for no other", async () => {
    // Arrange — the shape before 07 §13.9: no column; one enrolled repo, one not
    const harness = await createTestHarness();
    for (const statement of [
      sql`ALTER TABLE team_settings DROP COLUMN pilot_outcomes_since`,
      sql`INSERT INTO team_settings (repo, pin_policy, suspect_attribution, pilot_enrolled, updated_at)
          VALUES ('github.com/acme/api', 'anyone', 'sessions', true, now()),
                 ('github.com/acme/web', 'anyone', 'sessions', false, now())`,
    ]) {
      await harness.db.execute(statement);
    }
    const client = (harness.db as unknown as { $client: { exec: (text: string) => Promise<unknown> } }).$client;

    // Act
    await client.exec(await Bun.file(BOOTSTRAP_SQL_URL).text());

    // Assert
    const since = await harness.db.execute(
      sql`SELECT repo AS r, pilot_outcomes_since IS NOT NULL AS s FROM team_settings ORDER BY repo`,
    );
    expect(since.rows).toEqual([
      { r: "github.com/acme/api", s: true },
      { r: "github.com/acme/web", s: false },
    ]);
  });

  test("the 90-day prune is an index range across every repo, not a scan (D-O6)", async () => {
    // Arrange — the reaper deletes by age on every pass; without this index
    // the prune reads the whole table each time, as 07 §11.6 says of its siblings
    const harness = await createTestHarness();

    // Act
    const rows = await harness.db.execute(
      sql`SELECT indexdef AS d FROM pg_indexes WHERE indexname = 'hint_outcomes_created_idx'`,
    );

    // Assert
    expect(String(rows.rows[0]?.["d"] ?? "")).toContain("(created_at)");
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
