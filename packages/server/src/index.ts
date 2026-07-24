import type { Hono } from "hono";

import { createApp } from "./app.ts";
import { DEFAULT_PORT } from "./constants.ts";
import { createDb } from "./db/client.ts";
import type { Db } from "./db/client.ts";
import type { AppEnv, Clock } from "./types.ts";

export { createApp } from "./app.ts";
export { createDb } from "./db/client.ts";
export type { Db } from "./db/client.ts";
export type { AppDeps, AppEnv, AuthedDeveloper, Clock } from "./types.ts";
export {
  EVENTS_DEFAULT_LIMIT,
  EVENTS_MAX_LIMIT,
  EVENT_KINDS,
  POLL_INTERVAL_MS,
  PRESENCE_TTL_SECONDS,
  SSE_KEEPALIVE_INTERVAL_MS,
} from "./constants.ts";

export interface CreateServerOptions {
  readonly db: Db;
  readonly now?: Clock;
  readonly adminToken?: string | null;
}

export const createServer = (options: CreateServerOptions): Hono<AppEnv> =>
  createApp({
    db: options.db,
    now: options.now ?? (() => new Date()),
    adminToken: options.adminToken ?? null,
  });

const MIN_PORT = 1;
const MAX_PORT = 65535;

const parsePort = (raw: string | undefined): number => {
  if (raw === undefined) {
    return DEFAULT_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
    throw new Error(
      `invalid PORT "${raw}": expected an integer between ${MIN_PORT} and ${MAX_PORT}`,
    );
  }
  return parsed;
};

const startServer = async (): Promise<void> => {
  const dataDir = process.env["CROSSCHECK_DATA_DIR"];
  const db = await createDb(dataDir === undefined ? {} : { dataDir });
  const app = createServer({
    db,
    adminToken: process.env["ADMIN_TOKEN"] ?? null,
  });
  const port = parsePort(process.env["PORT"]);
  Bun.serve({ port, fetch: app.fetch });
  console.log(`crosscheck server listening on :${port}`);
};

if (import.meta.main) {
  await startServer();
}