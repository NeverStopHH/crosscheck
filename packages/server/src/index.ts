import type { Hono } from "hono";

import { createApp } from "./app.ts";
import { generateApiKey } from "./auth/keys.ts";
import { DEFAULT_PORT } from "./constants.ts";
import { createDb } from "./db/client.ts";
import { createEmbedderFromEnv } from "./services/embedder.ts";
import type { Db } from "./db/client.ts";
import type { Embedder } from "./services/embedder.ts";
import type { AppEnv, Clock } from "./types.ts";

export { createApp } from "./app.ts";
export { createDb } from "./db/client.ts";
export type { Db } from "./db/client.ts";
export { createEmbedderFromEnv } from "./services/embedder.ts";
export type { Embedder } from "./services/embedder.ts";
export {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_MIN_TOKEN_CHARS,
} from "./services/search.ts";
export type { AppDeps, AppEnv, AuthedDeveloper, Clock } from "./types.ts";
export {
  EVENTS_DEFAULT_LIMIT,
  EVENTS_MAX_LIMIT,
  EVENT_KINDS,
  MAX_INGEST_BATCH,
  POLL_INTERVAL_MS,
  PRESENCE_TTL_SECONDS,
  SSE_KEEPALIVE_INTERVAL_MS,
} from "./constants.ts";

export interface CreateServerOptions {
  readonly db: Db;
  readonly now?: Clock;
  readonly adminToken?: string | null;
  /** Omitted/null = keyless: the vector tier is silently absent (DESIGN.md §6). */
  readonly embedder?: Embedder | null;
  /**
   * HMAC secret for /ui session cookies. Omitted = a fresh random secret per
   * process: nothing secret at rest, and a restart logs every browser out
   * (ui/session.ts documents the rotation story). Set CROSSCHECK_UI_SECRET
   * to keep sessions across restarts.
   */
  readonly uiSessionSecret?: string;
}

export const createServer = (options: CreateServerOptions): Hono<AppEnv> =>
  createApp({
    db: options.db,
    now: options.now ?? (() => new Date()),
    adminToken: options.adminToken ?? null,
    embedder: options.embedder ?? null,
    uiSessionSecret: options.uiSessionSecret ?? generateApiKey(),
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
  // Throws on explicit misconfiguration (e.g. openai chosen, no key) — a hub
  // that silently dropped its vector tier would be DESIGN.md §10 "silent death".
  const embedder = createEmbedderFromEnv(process.env);
  const uiSessionSecret = process.env["CROSSCHECK_UI_SECRET"];
  const app = createServer({
    db,
    adminToken: process.env["ADMIN_TOKEN"] ?? null,
    embedder,
    ...(uiSessionSecret === undefined ? {} : { uiSessionSecret }),
  });
  const port = parsePort(process.env["PORT"]);
  Bun.serve({ port, fetch: app.fetch });
  const searchMode =
    embedder === null ? "exact+fts (keyless)" : `exact+fts+vector (${embedder.model})`;
  console.log(`crosscheck server listening on :${port} · search: ${searchMode}`);
};

if (import.meta.main) {
  await startServer();
}