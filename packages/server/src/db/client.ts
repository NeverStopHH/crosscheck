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

/**
 * Runs a PGlite boot or close without letting it change the process's exit
 * code.
 *
 * PGlite 0.4 boots through Emscripten's Node branch, whose quit handler
 * writes `process.exitCode = 99`. PGlite then restores the value it saved
 * before booting, and on a clean process that is `undefined`, which Bun
 * ignores (Node resets). So a process that had opened a database ended 99,
 * failures or not, until it closed it: CI's `bun test` failed with every test
 * green. `close()` in turn writes 0, over whatever the process had set.
 * Measured on 2026-09-26 with PGlite 0.4.6 on Bun 1.3.13 (macOS) and 1.4.2
 * (Linux amd64); 0.3.16 did neither. Upstream: electric-sql/pglite#975 and
 * #1083, fixed for Bun in 0.5.6, a PostgreSQL 18 line.
 *
 * An unset code is put back as 0, the one Bun can store: the process then
 * ends as it would unset, and an uncaught error or a failed test still ends
 * it 1.
 */
const keepingExitCode = async <T>(step: () => Promise<T>): Promise<T> => {
  const exitCodeBefore = process.exitCode;
  try {
    return await step();
  } finally {
    process.exitCode = exitCodeBefore ?? 0;
  }
};

/** Live-measured major of the bundled build — the directive above compares it. */
export const bundledPgMajor = async (): Promise<string> =>
  keepingExitCode(async () => {
    const probe = new PGlite();
    await probe.waitReady;
    const result = await probe.query<{ readonly major: string }>(
      "SELECT split_part(current_setting('server_version'), '.', 1) AS major",
    );
    await probe.close();
    return result.rows[0]?.major ?? "unknown";
  });

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

/**
 * How an in-memory database (tests, dev) starts, beyond PGlite's defaults.
 * A hub with a data dir starts with the defaults. Measured on 2026-09-26 with
 * PGlite 0.4.6:
 *
 * - shared_buffers: with PostgreSQL's default of 160 MB an open in-memory
 *   database costs 229 MB of memory, with 16 MB it costs 60 MB. The suite
 *   opens one per test.
 * - log_startup_progress_interval: a copy of a running cluster starts with
 *   recovery, and PostgreSQL then re-arms its 10-second startup progress
 *   timer for good, so a process that had opened one never ended (still
 *   re-arming after 40 s; with the timer off it ended at 10.6 s). The timer
 *   only paces progress log lines.
 */
const IN_MEMORY_START_PARAMS = [
  ...PGlite.defaultStartParams,
  "-c", "shared_buffers=16MB",
  "-c", "log_startup_progress_interval=0",
];

/**
 * A fresh cluster, initdb'd once per process, that every in-memory database
 * starts as a copy of. PGlite 0.4 runs initdb in extra WASM instances whose
 * memory it never gives back: about 280 MB per fresh cluster (510 MB per
 * database against 229 MB for a copy, measured 2026-09-26), which ran the
 * suite's single process out of memory. PGlite 0.3 ran initdb inside the
 * database's own instance.
 */
let freshCluster: Promise<Blob> | undefined;

const freshClusterCopy = (): Promise<Blob> => {
  freshCluster ??= (async () => {
    const seed = new PGlite();
    await seed.waitReady;
    const cluster = await seed.dumpDataDir("none");
    await seed.close();
    return cluster;
  })();
  return freshCluster;
};

export const createDb = async (options: CreateDbOptions = {}): Promise<Db> => {
  if (options.dataDir !== undefined) {
    await checkDataDirMajor(options.dataDir);
  }
  // The vector extension is bundled with the pinned PGlite — loading it here
  // is what lets bootstrap.sql's CREATE EXTENSION succeed. A real-Postgres
  // deployment needs pgvector installed instead (DESIGN.md §2).
  const client = await keepingExitCode(async () => {
    const booting = options.dataDir
      ? new PGlite(options.dataDir, { database: HUB_DATABASE, extensions: { vector } })
      : new PGlite({
          database: HUB_DATABASE,
          extensions: { vector },
          loadDataDir: await freshClusterCopy(),
          startParams: IN_MEMORY_START_PARAMS,
        });
    await booting.waitReady;
    return booting;
  });
  await runBootstrap(client);
  return drizzle(client, { schema });
};