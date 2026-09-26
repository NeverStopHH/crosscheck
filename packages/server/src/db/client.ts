import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";

import * as schema from "./schema.ts";

export type Db = PgliteDatabase<typeof schema>;

/** An open drizzle transaction over the same schema. */
export type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Query executor accepted by data helpers: the root db or an open transaction. */
export type DbExecutor = Db | DbTransaction;

export interface CreateDbOptions {
  /** Filesystem directory for durable storage; omitted = in-memory (tests, dev). */
  readonly dataDir?: string;
}

const BOOTSTRAP_SQL_URL = new URL("./bootstrap.sql", import.meta.url);

/**
 * PostgreSQL major of the build bundled with the pinned PGlite. A data
 * dir written by any OTHER major must be refused BEFORE PGlite touches it:
 * the WASM build aborts on a foreign-format dir with an unintelligible
 * `RuntimeError: Unreachable code should not be executed` at waitReady
 * instead of an error message. The mismatch is easy to hit — bun AUTO-INSTALLS
 * the newest PGlite (a PostgreSQL 18 build as of 0.5.x) for any script whose
 * import resolves outside this workspace's pinned node_modules, and a hub once
 * started that way leaves a dir the pinned build can never open.
 *
 * The constant is measured, not transcribed:
 *
 * VERIFY: bun -e 'const c=await import("./packages/server/src/db/client.ts");console.log(c.PGLITE_PG_MAJOR, await c.bundledPgMajor())'
 * PRINTS: 17 17
 */
export const PGLITE_PG_MAJOR = "17";

/**
 * THE DATABASE A HUB'S TABLES LIVE IN, named, never left to PGlite's default.
 *
 * PGlite 0.3 — pinned by every release through 0.9 — connected to
 * `template1` by default, so that is where every hub ever created keeps its
 * data. PGlite 0.4 changed its default to `postgres`, which in such a dir
 * exists and is EMPTY: an upgraded hub started on it without an error,
 * bootstrapped fresh tables there, answered every stored key "unknown api
 * key", and wrote from then on into the wrong database, the old data intact
 * but out of sight. Measured on 2026-09-26 with a dir 0.3.16 wrote and 0.4.6
 * opened: same cluster (`system_identifier` unchanged), different database.
 *
 * `template1` is an unusual home for application tables in a server
 * deployment. It is the right one here: it is where the data IS, and one
 * embedded hub owns the whole cluster.
 */
export const HUB_DATABASE = "template1";

/** Live-measured major of the bundled build — the directive above compares it. */
export const bundledPgMajor = async (): Promise<string> => {
  const probe = new PGlite();
  await probe.waitReady;
  const result = await probe.query<{ readonly major: string }>(
    "SELECT split_part(current_setting('server_version'), '.', 1) AS major",
  );
  await probe.close();
  return result.rows[0]?.major ?? "unknown";
};

/**
 * Fail fast, by name, on a data dir another PostgreSQL major wrote. A missing
 * PG_VERSION means a fresh/empty dir — PGlite will initdb it.
 */
const checkDataDirMajor = async (dataDir: string): Promise<void> => {
  const versionFile = Bun.file(join(dataDir, "PG_VERSION"));
  if (!(await versionFile.exists())) {
    return;
  }
  const major = (await versionFile.text()).trim();
  if (major === PGLITE_PG_MAJOR) {
    return;
  }
  throw new Error(
    `data dir "${dataDir}" was written by a PostgreSQL ${major} server, but ` +
      `the pinned @electric-sql/pglite bundles PostgreSQL ${PGLITE_PG_MAJOR}; ` +
      "opening it would abort the WASM runtime. This usually means the dir " +
      "was created through a different PGlite version (bun auto-installs a " +
      "newer one for scripts outside this workspace). Point " +
      "CROSSCHECK_DATA_DIR at a fresh directory, or export/import the data " +
      "through the version that wrote it.",
  );
};

const runBootstrap = async (client: PGlite): Promise<void> => {
  const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();
  await client.exec(bootstrapSql);
};

export const createDb = async (options: CreateDbOptions = {}): Promise<Db> => {
  if (options.dataDir !== undefined) {
    await checkDataDirMajor(options.dataDir);
  }
  // The vector extension is bundled with the pinned PGlite — loading it here
  // is what lets bootstrap.sql's CREATE EXTENSION succeed. A real-Postgres
  // deployment needs pgvector installed instead (DESIGN.md §2).
  const client = options.dataDir
    ? new PGlite(options.dataDir, { database: HUB_DATABASE, extensions: { vector } })
    : new PGlite({ database: HUB_DATABASE, extensions: { vector } });
  await client.waitReady;
  await runBootstrap(client);
  return drizzle(client, { schema });
};