/**
 * HUMAN PROVENANCE IN BOTH DDL AUTHORITIES (human provenance §4).
 *
 * drizzle's `schema.ts` is what every service writes by and `bootstrap.sql` is
 * what every hub runs. The draft store and the confirmation record are new
 * tables; the records that count gain `provenance` and `confirmation_id`, and
 * a row from before 0.11 reads `unknown_legacy` — never upgraded to human.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";

import {
  developerMutes,
  hintOutcomes,
  humanConfirmationItems,
  humanConfirmations,
  humanDrafts,
  noiseReassertions,
  pilotMarks,
  pins,
  privacyChanges,
} from "../src/db/schema.ts";
import { BOOTSTRAP_SQL_URL } from "./fixtures/bootstrap-sql.ts";
import { createTestDeveloper, createTestHarness } from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const AT = new Date("2026-10-08T12:00:00.000Z");

const columnsOf = async (harness: TestHarness, table: string): Promise<readonly string[]> => {
  const rows = await harness.db.execute(
    sql`SELECT column_name AS c FROM information_schema.columns WHERE table_name = ${table} ORDER BY column_name`,
  );
  return rows.rows.map((row) => String(row["c"]));
};

/** `db.execute` answers a thenable, not a Promise; `rejects` needs the Promise. */
const attempt = async (query: PromiseLike<unknown>): Promise<unknown> => await query;

const drizzleColumns = (table: PgTable): readonly string[] =>
  getTableConfig(table)
    .columns.map((column) => column.name)
    .sort();

const NEW_TABLES: readonly (readonly [string, PgTable])[] = [
  ["human_drafts", humanDrafts],
  ["human_confirmations", humanConfirmations],
  ["human_confirmation_items", humanConfirmationItems],
  ["privacy_changes", privacyChanges],
];

const COUNTING_TABLES: readonly (readonly [string, PgTable])[] = [
  ["pilot_marks", pilotMarks],
  ["noise_reassertions", noiseReassertions],
  ["hint_outcomes", hintOutcomes],
  ["pins", pins],
  ["developer_mutes", developerMutes],
];

describe("human provenance DDL sync", () => {
  test("each new table has drizzle's columns on a real bootstrap", async () => {
    // Arrange
    const harness = await createTestHarness();

    // Act
    const found = await Promise.all(NEW_TABLES.map(async ([name]) => columnsOf(harness, name)));

    // Assert
    expect(found).toEqual(NEW_TABLES.map(([, table]) => drizzleColumns(table)));
  });

  test("each record that counts carries provenance and confirmation_id in both authorities", async () => {
    // Arrange
    const harness = await createTestHarness();

    // Act
    const found = await Promise.all(COUNTING_TABLES.map(async ([name]) => columnsOf(harness, name)));

    // Assert
    for (const [index, [, table]] of COUNTING_TABLES.entries()) {
      expect(found[index]).toEqual(drizzleColumns(table));
      expect(found[index]).toContain("provenance");
      expect(found[index]).toContain("confirmation_id");
    }
  });

  test("drizzle gives provenance no default, so a writer that forgets it does not compile", () => {
    // Assert — the database default only labels rows written before 0.11
    for (const [, table] of COUNTING_TABLES) {
      const column = getTableConfig(table).columns.find((each) => each.name === "provenance");
      expect(column?.hasDefault).toBe(false);
      expect(column?.notNull).toBe(true);
    }
  });

  test("a row from before 0.11 reads unknown_legacy after the upgrade, and a second start changes nothing", async () => {
    // Arrange: a hub whose pilot_marks predates the column, holding one label
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-ddl-prov@example.com");
    const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();
    const upgrade = (bootstrapSql.match(/^ALTER TABLE pilot_marks ADD COLUMN IF NOT EXISTS (provenance|confirmation_id)[^\n]*$/gm) ?? []).join("\n");
    await harness.db.execute(sql`ALTER TABLE pilot_marks DROP COLUMN provenance CASCADE`);
    await harness.db.execute(sql`ALTER TABLE pilot_marks DROP COLUMN confirmation_id CASCADE`);
    await harness.db.execute(sql`INSERT INTO pilot_marks (id, repo, ref_kind, ref_id, mark, marked_by, capture_mode, created_at)
      VALUES ('pm_old', 'github.com/acme/api', 'hint_delivery', 'hd_old', 'helpful', ${nick.developerId}, 'human', ${AT.toISOString()}::timestamptz)`);

    // Act — each statement on its own: db.execute prepares a single command
    const statements = upgrade.split("\n");
    for (const statement of [...statements, ...statements]) {
      await harness.db.execute(sql.raw(statement));
    }
    const rows = await harness.db.execute(sql`SELECT provenance, confirmation_id FROM pilot_marks WHERE id = 'pm_old'`);

    // Assert
    expect(upgrade.split("\n")).toHaveLength(2);
    expect(rows.rows).toEqual([{ provenance: "unknown_legacy", confirmation_id: null }]);
  });

  test("the database refuses a draft class, or a human row with no confirmation, in a record that counts", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-ddl-check@example.com");
    const insert = (provenance: string, confirmation: string | null) =>
      attempt(harness.db.execute(sql`INSERT INTO pilot_marks (id, repo, ref_kind, ref_id, mark, marked_by, capture_mode, created_at, provenance, confirmation_id)
        VALUES (${`pm_${provenance}_${String(confirmation)}`}, 'github.com/acme/api', 'hint_delivery', ${`hd_${provenance}`}, 'helpful',
          ${nick.developerId}, 'human', ${AT.toISOString()}::timestamptz, ${provenance}, ${confirmation})`));

    // Act & Assert
    await expect(insert("agent_asserted", null)).rejects.toThrow();
    await expect(insert("interactive_terminal_asserted", null)).rejects.toThrow();
    await expect(insert("human_passkey_confirmed", null)).rejects.toThrow();
    await expect(insert("unknown_legacy", "hc_made_up")).rejects.toThrow();
    await insert("unknown_legacy", null);
  });

  test("a legacy label and a confirmed one on the same delivery do not collide", async () => {
    // Arrange: the one-label-per-person key now includes the provenance
    const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();

    // Assert
    expect(bootstrapSql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS pilot_marks_ref_marker_provenance_idx\n  ON pilot_marks (ref_kind, ref_id, marked_by, provenance);",
    );
    expect(bootstrapSql).toContain("DROP INDEX IF EXISTS pilot_marks_ref_marker_idx;");
    expect(bootstrapSql).not.toContain("CREATE UNIQUE INDEX IF NOT EXISTS pilot_marks_ref_marker_idx");
  });

  test("a draft carries only a draft class, and its subject's versions are unique", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-ddl-draft@example.com");
    const insert = (id: string, provenance: string, version: number) =>
      attempt(harness.db.execute(sql`INSERT INTO human_drafts (id, developer_id, repo, kind, subject_key, version, payload, provenance, created_at)
        VALUES (${id}, ${nick.developerId}, 'github.com/acme/api', 'outcome', 'outcome:s:r', ${version}, '{}'::jsonb, ${provenance}, ${AT.toISOString()}::timestamptz)`));

    // Act & Assert
    await insert("dr_1", "agent_asserted", 1);
    await expect(insert("dr_2", "agent_asserted", 1)).rejects.toThrow();
    await expect(insert("dr_3", "human_passkey_confirmed", 2)).rejects.toThrow();
    await expect(insert("dr_4", "unknown_legacy", 2)).rejects.toThrow();
    await insert("dr_5", "interactive_terminal_asserted", 2);
  });

  test("a confirmation names a credential that exists", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-ddl-conf@example.com");

    // Act & Assert
    await expect(
      attempt(harness.db.execute(sql`INSERT INTO human_confirmations (id, developer_id, credential_id, rp_id, digest, pending_fingerprint, item_count, formed_at, confirmed_at)
        VALUES ('hc_1', ${nick.developerId}, 'cred_never_enrolled', 'localhost', 'd', 'f', 0, ${AT.toISOString()}::timestamptz, ${AT.toISOString()}::timestamptz)`)),
    ).rejects.toThrow();
  });

  test("a legacy break reads unknown_legacy, and a break with no provenance is refused", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-ddl-break@example.com");
    const pin = (id: string, broke: string | null) =>
      attempt(harness.db.execute(sql`INSERT INTO pins (id, repo, surface, verified_by, verified_at_commit, verified_at, check_recipe, capture_mode, created_at, broke_at, broke_provenance)
        VALUES (${id}, 'github.com/acme/api', 'the refresh path', ${nick.developerId}, 'a1b2c3d', ${AT.toISOString()}::timestamptz, 'bun test', 'human',
          ${AT.toISOString()}::timestamptz, ${AT.toISOString()}::timestamptz, ${broke})`));

    // Act & Assert
    await expect(pin("pin_nobody_broke", null)).rejects.toThrow();
    await expect(pin("pin_agent_broke", "agent_asserted")).rejects.toThrow();
    await pin("pin_legacy_broke", "unknown_legacy");
    const rows = await harness.db.execute(sql`SELECT provenance FROM pins WHERE id = 'pin_legacy_broke'`);
    expect(rows.rows).toEqual([{ provenance: "unknown_legacy" }]);
  });
});
