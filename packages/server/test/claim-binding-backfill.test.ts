/**
 * THE BACKFILL, AND THE TWO WAYS IT COULD BE WORSE THAN NOTHING.
 *
 * Every claim that exists today was written with no commit at all, and D2's
 * default is to bind them to their author session's base commit. There is no
 * migrations directory in this repo: `db/bootstrap.sql` runs in FULL on every
 * hub start (db/client.ts execs the whole file), so a bare
 * `UPDATE claims SET observed_at_commit = …` is a full-table write on every
 * restart — and it would also walk over a STRONGER binding, replacing an
 * emitter's own reported commit with the session's moving base.
 *
 * `xmin` is the evidence: Postgres stamps every row with the transaction that
 * last wrote it, so an unchanged `xmin` is proof that no UPDATE touched the
 * row — the same trick the body-length widener's oid assertion uses one
 * catalog over.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { createTestHarness } from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const BOOTSTRAP_SQL_URL = new URL("../src/db/bootstrap.sql", import.meta.url);

const backfillBlock = async (): Promise<string> => {
  const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();
  const blocks = bootstrapSql.match(/DO \$\$\n[\s\S]*?\nEND\n\$\$;/g) ?? [];
  return blocks.find((block) => block.includes("observed_at_commit = s.base_commit")) ?? "";
};

interface ClaimRow {
  readonly observed_at_commit: string | null;
  readonly commit_binding: string;
  readonly xmin: string;
}

const readClaim = async (
  harness: TestHarness,
  id: string,
): Promise<ClaimRow | undefined> => {
  const result = (await harness.db.execute(
    sql`SELECT observed_at_commit, commit_binding, xmin::text AS xmin FROM claims WHERE id = ${id}`,
  )) as unknown as { readonly rows: readonly ClaimRow[] };
  return result.rows[0];
};

/** Two developers, two sessions — one with a real sha, one with a label. */
const seedRows = async (harness: TestHarness): Promise<void> => {
  await harness.db.execute(
    sql`INSERT INTO developers (id, name, email, api_key_hash, created_at)
        VALUES ('dev_1', 'Nick', 'nick@example.com', 'hash_1', now())`,
  );
  await harness.db.execute(
    sql`INSERT INTO agent_sessions
          (id, developer_id, agent_kind, repo, branch, base_commit, status, started_at, last_heartbeat_at)
        VALUES
          ('ses_sha', 'dev_1', 'claude-code', 'github.com/acme/api', 'main', 'a1b2c3d4', 'analyzing', now(), now()),
          ('ses_label', 'dev_1', 'claude-code', 'github.com/acme/api', 'main', 'conference', 'analyzing', now(), now()),
          ('ses_zero', 'dev_1', 'claude-code', 'github.com/acme/api', 'main', '0000000', 'analyzing', now(), now())`,
  );
  await harness.db.execute(
    sql`INSERT INTO work_contexts (id, session_id, title, status, created_at)
        VALUES ('wc_1', 'ses_sha', 'Login 500s', 'analyzing', now())`,
  );
};

const insertClaim = async (
  harness: TestHarness,
  id: string,
  sessionId: string,
  observedAtCommit: string | null,
  commitBinding: string,
): Promise<void> => {
  await harness.db.execute(
    sql`INSERT INTO claims
          (id, work_context_id, author_session_id, kind, body, status, confidence,
           capture_mode, provenance, evidence_refs, created_at,
           observed_at_commit, commit_binding)
        VALUES (${id}, 'wc_1', ${sessionId}, 'observation', ${id}, 'proposed', 0.8,
                'agent', 'declared', '[]'::jsonb, now(), ${observedAtCommit}, ${commitBinding})`,
  );
};

/** The state an upgrading hub is in: columns present, migration not yet run. */
const asUpgradingHub = async (harness: TestHarness): Promise<void> => {
  await harness.db.execute(
    sql`ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_commit_binding_check`,
  );
};

describe("claim binding backfill", () => {
  test("pre-1.0 claims are bound to their session's base commit", async () => {
    // Arrange
    const harness = await createTestHarness();
    await seedRows(harness);
    await asUpgradingHub(harness);
    await insertClaim(harness, "clm_old", "ses_sha", null, "none");
    await insertClaim(harness, "clm_label", "ses_label", null, "none");
    await insertClaim(harness, "clm_zero", "ses_zero", null, "none");

    // Act
    const block = await backfillBlock();
    expect(block).not.toBe("");
    await harness.db.execute(sql.raw(block));

    // Assert: a real sha binds; a label and the NO_COMMIT_SHA placeholder do
    // not — they stay bound to nothing rather than reaching git as an object
    // name.
    expect(await readClaim(harness, "clm_old")).toMatchObject({
      observed_at_commit: "a1b2c3d4",
      commit_binding: "session_base",
    });
    expect(await readClaim(harness, "clm_label")).toMatchObject({
      observed_at_commit: null,
      commit_binding: "none",
    });
    expect(await readClaim(harness, "clm_zero")).toMatchObject({
      observed_at_commit: null,
      commit_binding: "none",
    });
  });

  test("the backfill never walks over a reported binding", async () => {
    // Arrange: an emitter's own HEAD is a STRONGER statement than the
    // session's base commit, which moves on every re-registration.
    const harness = await createTestHarness();
    await seedRows(harness);
    await asUpgradingHub(harness);
    await insertClaim(harness, "clm_reported", "ses_sha", "deadbee", "reported");
    const before = await readClaim(harness, "clm_reported");

    // Act
    const block = await backfillBlock();
    expect(block).not.toBe("");
    await harness.db.execute(sql.raw(block));

    // Assert: same commit, same binding, and the row was never written at all.
    const after = await readClaim(harness, "clm_reported");
    expect(after?.observed_at_commit).toBe("deadbee");
    expect(after?.commit_binding).toBe("reported");
    expect(after?.xmin).toBe(before?.xmin ?? "");
  });

  test("a restart after the migration writes nothing", async () => {
    // Arrange: the harness already ran bootstrap.sql in full, so the CHECK
    // constraint exists — which IS the marker saying this migration completed.
    // A claim legitimately stamped 'none' by ingest (a conference session)
    // must not be re-examined on every hub start for the rest of time.
    const harness = await createTestHarness();
    await seedRows(harness);
    await insertClaim(harness, "clm_live_none", "ses_label", null, "none");
    const before = await readClaim(harness, "clm_live_none");

    // Act: exactly what a restart replays.
    const block = await backfillBlock();
    expect(block).not.toBe("");
    await harness.db.execute(sql.raw(block));

    // Assert
    expect(await readClaim(harness, "clm_live_none")).toMatchObject({
      commit_binding: "none",
      xmin: before?.xmin ?? "",
    });
  });

  test("xmin moves when a row really is rewritten", async () => {
    // Arrange: without this the two assertions above would also pass against
    // a column nothing in Postgres ever stamps.
    const harness = await createTestHarness();
    await seedRows(harness);
    await insertClaim(harness, "clm_probe", "ses_sha", null, "none");
    const before = await readClaim(harness, "clm_probe");

    // Act
    await harness.db.execute(
      sql`UPDATE claims SET body = 'rewritten' WHERE id = 'clm_probe'`,
    );

    // Assert
    expect((await readClaim(harness, "clm_probe"))?.xmin).not.toBe(
      before?.xmin ?? "",
    );
  });
});
