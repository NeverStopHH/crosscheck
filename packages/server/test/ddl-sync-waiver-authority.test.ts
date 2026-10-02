/**
 * DDL sync for 04a D-PK-1 (Nick, 2026-10-02): the hub's own closure of a
 * waiver is a third authority, `system`, and both DDL sources — drizzle's
 * schema.ts and bootstrap.sql — hold it to one shape: a revoke, for the one
 * reason, naming the revoked credential and no person. An existing hub gets
 * the new CHECK once; a restart leaves it alone.
 *
 * Its own file because ddl-sync.test.ts is past the 800-line bound; the
 * helpers both read bootstrap.sql through are in fixtures/bootstrap-sql.ts.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import {
  AUTHORIZING_CREDENTIAL_REVOKED,
  SYSTEM_WAIVER_AUTHORITY,
  WAIVER_AUTHORITIES,
} from "@crosscheck/schema";

import { fenceWaivers, pins } from "../src/db/schema.ts";
import { BOOTSTRAP_SQL_URL, guardedBlockNamed } from "./fixtures/bootstrap-sql.ts";
import { seedPasskey } from "./fixtures/passkeys.ts";
import { createTestDeveloper, createTestHarness } from "./helpers.ts";

describe("bootstrap.sql DDL sync — the hub's closure authority (04a D-PK-1)", () => {
  test("the hub's own closure is a third authority valid only on a revoke, in both DDL sources (04a D-PK-1)", async () => {
    // Arrange — a closure the hub writes when the passkey that authorised a
    // grant is revoked. It must never open a fence, never pass for a person's
    // ceremony, and never be written for any other reason.
    const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();
    const drizzleCheck = getTableConfig(fenceWaivers).checks.find(
      (entry) => entry.name === "fence_waivers_authority_check",
    );

    // Act
    const guarded = guardedBlockNamed(bootstrapSql, "fence_waivers_authority_check");
    const drizzleSql = drizzleCheck === undefined ? "" : new PgDialect().sqlToQuery(drizzleCheck.value).sql;

    // Assert
    expect(WAIVER_AUTHORITIES).toContain(SYSTEM_WAIVER_AUTHORITY);
    for (const text of [guarded, drizzleSql]) {
      expect(text).toContain(`'${SYSTEM_WAIVER_AUTHORITY}'`);
      expect(text).toContain("'revoke'");
      expect(text).toContain(`'${AUTHORIZING_CREDENTIAL_REVOKED}'`);
    }
    expect(guarded).toContain("DROP CONSTRAINT IF EXISTS fence_waivers_authority_check");
    expect(bootstrapSql).toContain("ALTER TABLE fence_waivers ALTER COLUMN granted_by DROP NOT NULL;");
  });

  test("a hub with the two-authority CHECK gets the new one once, and a restart leaves it alone", async () => {
    // Arrange — a hub bootstrapped before D-PK-1 carries the old constraint
    const harness = await createTestHarness();
    const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();
    const block = guardedBlockNamed(bootstrapSql, "fence_waivers_authority_check");
    const read = async (): Promise<{ readonly oid: string; readonly def: string }> => {
      const result = (await harness.db.execute(
        sql`SELECT oid::text AS oid, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'fence_waivers_authority_check'`,
      )) as unknown as { readonly rows: readonly { readonly oid: string; readonly def: string }[] };
      return result.rows[0] ?? { oid: "", def: "" };
    };
    await harness.db.execute(sql`ALTER TABLE fence_waivers DROP CONSTRAINT fence_waivers_authority_check`);
    await harness.db.execute(
      sql`ALTER TABLE fence_waivers ADD CONSTRAINT fence_waivers_authority_check CHECK (authority = 'terminal' OR (authority = 'passkey' AND credential_id IS NOT NULL))`,
    );

    // Act
    await harness.db.execute(sql.raw(block));
    const upgraded = await read();
    await harness.db.execute(sql.raw(block));
    const restarted = await read();
    const nullable = await harness.db.execute(
      sql`SELECT is_nullable AS n FROM information_schema.columns WHERE table_name = 'fence_waivers' AND column_name = 'granted_by'`,
    );

    // Assert
    expect(upgraded.def).toContain(SYSTEM_WAIVER_AUTHORITY);
    expect(restarted.oid).toBe(upgraded.oid);
    expect(String(nullable.rows[0]?.["n"])).toBe("YES");
  });

  test("the database refuses a hub closure that is not a revoke for a revoked credential (04a D-PK-1)", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-ddl-system@example.com");
    const { credentialId } = await seedPasskey(harness.db, nick.developerId);
    const at = new Date("2026-10-02T12:00:00.000Z");
    await harness.db.insert(pins).values({
      id: "pin_ddl_system",
      repo: "github.com/acme/api",
      surface: "the refresh path keeps working",
      verifiedBy: nick.developerId,
      verifiedAtCommit: "a1b2c3d",
      verifiedAt: at,
      checkRecipe: "bun test",
      captureMode: "human",
      createdAt: at,
    });
    const base = {
      repo: "github.com/acme/api",
      pinId: "pin_ddl_system",
      pinVersion: 1,
      captureMode: "human" as const,
      createdAt: at,
      requestId: null,
    };
    const grant = { ...base, id: "fw_grant", kind: "grant" as const, grantedBy: nick.developerId, reason: "ship it", expiresAt: new Date(at.getTime() + 3_600_000), supersedes: null, authority: "passkey" as const, credentialId };
    const closure = { ...base, kind: "revoke" as const, grantedBy: null, reason: AUTHORIZING_CREDENTIAL_REVOKED, expiresAt: null, supersedes: "fw_grant", authority: SYSTEM_WAIVER_AUTHORITY, credentialId };
    const insert = async (row: typeof fenceWaivers.$inferInsert): Promise<void> => {
      await harness.db.insert(fenceWaivers).values(row);
    };
    await insert(grant);

    // Act & Assert: a hub closure that grants, gives another reason, names no
    // credential, or a person's row with nobody as its author — each refused
    await expect(insert({ ...grant, id: "fw_sys_grant", authority: SYSTEM_WAIVER_AUTHORITY })).rejects.toThrow();
    await expect(insert({ ...closure, id: "fw_sys_reason", reason: "felt like it" })).rejects.toThrow();
    await expect(insert({ ...closure, id: "fw_sys_nocred", credentialId: null })).rejects.toThrow();
    await expect(insert({ ...closure, id: "fw_person_nobody", authority: "passkey" })).rejects.toThrow();
    await insert({ ...closure, id: "fw_sys_ok" });
    expect(await harness.db.select().from(fenceWaivers)).toHaveLength(2);
  });
});
