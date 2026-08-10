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

const runBootstrap = async (client: PGlite): Promise<void> => {
  const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();
  await client.exec(bootstrapSql);
};

export const createDb = async (options: CreateDbOptions = {}): Promise<Db> => {
  // The vector extension is bundled with the pinned PGlite 0.3.x — loading it
  // here is what lets bootstrap.sql's CREATE EXTENSION succeed. A real-Postgres
  // deployment needs pgvector installed instead (DESIGN.md §2).
  const client = options.dataDir
    ? new PGlite(options.dataDir, { extensions: { vector } })
    : new PGlite({ extensions: { vector } });
  await client.waitReady;
  await runBootstrap(client);
  return drizzle(client, { schema });
};