/**
 * The persistent-dir upgrade path, exercised for the only databases the
 * upgrade DDL exists for: dirs created by the PRE-SEARCH-BLOCK release.
 *
 * The whole rest of the suite runs on fresh in-memory databases, so nothing
 * else ever executes bootstrap.sql's ALTER TABLE ... IF NOT EXISTS branch or
 * the normalized_doc backfill against live data. This file builds an
 * old-format dir with the frozen fixture DDL (no vector extension loaded —
 * exactly how the previous release's client opened it) and boots the CURRENT
 * createDb on top.
 *
 * The second test guards the failure that LOOKS like an upgrade crash but is
 * not: a dir written by a different PostgreSQL major (bun auto-installs a
 * newer PGlite — a PG 18 build — for any script resolving outside this
 * workspace's pinned node_modules). The pinned WASM build aborts on such a
 * dir with an unintelligible RuntimeError; createDb must refuse it with a
 * named error instead.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";

import { createDb } from "../src/db/client.ts";

const FIXTURE_DDL_URL = new URL(
  "./fixtures/pre-search-block-bootstrap.sql",
  import.meta.url,
);

/** Generous: this file boots real persistent PGlite instances, ~2s each. */
const UPGRADE_TEST_TIMEOUT_MS = 30_000;

const OLD_CONTEXT_TITLE = "Login 500s on staging";

const tempDirs: string[] = [];

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

const makeTempDir = async (label: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), `crosscheck-${label}-`));
  tempDirs.push(dir);
  return dir;
};

/**
 * A data dir the way the previous release left it: created WITHOUT the vector
 * extension, bootstrapped with the frozen DDL, holding one developer, one
 * session and one work context, closed cleanly.
 */
const makeOldFormatDir = async (): Promise<string> => {
  const dir = await makeTempDir("upgrade");
  const client = new PGlite(dir);
  await client.waitReady;
  await client.exec(await Bun.file(FIXTURE_DDL_URL).text());
  await client.exec(`
    INSERT INTO developers (id, name, email, api_key_hash)
      VALUES ('dev_old', 'Nick', 'nick@example.com', 'hash_old');
    INSERT INTO agent_sessions (id, developer_id, agent_kind, repo, branch,
        base_commit, status, started_at, last_heartbeat_at)
      VALUES ('ses_old', 'dev_old', 'claude-code', 'github.com/acme/api',
        'main', 'a1b2c3d4', 'analyzing', now(), now());
    INSERT INTO work_contexts (id, session_id, title, status, created_at)
      VALUES ('wc_old', 'ses_old', '${OLD_CONTEXT_TITLE}', 'analyzing', now());
  `);
  await client.close();
  return dir;
};

describe("persistent-dir upgrade from the pre-search-block release", () => {
  test(
    "the current createDb boots an old dir and lands the search block",
    async () => {
      // Arrange
      const dataDir = await makeOldFormatDir();

      // Act: the upgrade — CREATE EXTENSION vector, ALTER TABLE ... IF NOT
      // EXISTS for tsv/embedding, and the normalized_doc backfill
      const db = await createDb({ dataDir });

      // Assert: the data survived
      const devs = await db.execute(
        sql`SELECT count(*)::int AS n FROM developers`,
      );
      expect((devs.rows[0] as { n: number }).n).toBe(1);

      // The backfill wrote the minimal honest doc: title + status
      const docs = await db.execute(
        sql`SELECT normalized_doc FROM work_contexts WHERE id = 'wc_old'`,
      );
      expect((docs.rows[0] as { normalized_doc: string }).normalized_doc).toBe(
        `${OLD_CONTEXT_TITLE} analyzing`,
      );

      // The generated tsv column answers FTS against the backfilled doc
      const hits = await db.execute(
        sql`SELECT id FROM work_contexts
            WHERE tsv @@ websearch_to_tsquery('english', 'staging')`,
      );
      expect(hits.rows.map((row) => (row as { id: string }).id)).toEqual([
        "wc_old",
      ]);

      // And the vector extension actually installed into the old catalog.
      // (Like every harness in this suite, the instance is not closed —
      // the process teardown releases it, and afterAll removes the dir.)
      const extensions = await db.execute(
        sql`SELECT extname FROM pg_extension WHERE extname = 'vector'`,
      );
      expect(extensions.rows.length).toBe(1);
    },
    UPGRADE_TEST_TIMEOUT_MS,
  );

  test(
    "a dir written by a different PostgreSQL major is refused, by name",
    async () => {
      // Arrange: the poisoned-dir shape a mixed-version install leaves behind.
      // Only PG_VERSION matters — createDb must refuse BEFORE PGlite touches
      // the dir, because the WASM build's own failure mode is an aborted
      // runtime, not an error.
      const dataDir = await makeTempDir("foreign");
      await writeFile(join(dataDir, "PG_VERSION"), "18\n");

      // Act + Assert
      await expect(createDb({ dataDir })).rejects.toThrow(
        /written by a PostgreSQL 18/,
      );
    },
    UPGRADE_TEST_TIMEOUT_MS,
  );
});
