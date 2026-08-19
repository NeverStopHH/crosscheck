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
  /** Test seam only — services/search.ts SearchDeps says why. Omit in production. */
  readonly embedDeadlineMs?: number;
  /**
   * HMAC secret for /ui session cookies. Omitted = a fresh random secret per
   * process: nothing secret at rest, and a restart logs every browser out
   * (ui/session.ts documents the rotation story). Set CROSSCHECK_UI_SECRET
   * to keep sessions across restarts.
   */
  readonly uiSessionSecret?: string;
}

/**
 * Omitted → fresh random secret per process. Provided → must have substance:
 * `CROSSCHECK_UI_SECRET=` (empty) is not nullish, so without this guard it
 * would flow through `??` and sign every session cookie with "" — a signing
 * secret misconfiguration must fail fast at startup, not silently weaken auth.
 */
const resolveUiSessionSecret = (secret: string | undefined): string => {
  if (secret === undefined) {
    return generateApiKey();
  }
  if (secret.trim().length === 0) {
    throw new Error(
      "uiSessionSecret (CROSSCHECK_UI_SECRET) must be non-empty: it is the " +
        "HMAC key signing /ui session cookies. Unset it entirely for a " +
        "random per-process secret.",
    );
  }
  return secret;
};

export const createServer = (options: CreateServerOptions): Hono<AppEnv> =>
  createApp({
    db: options.db,
    now: options.now ?? (() => new Date()),
    adminToken: options.adminToken ?? null,
    embedder: options.embedder ?? null,
    ...(options.embedDeadlineMs === undefined
      ? {}
      : { embedDeadlineMs: options.embedDeadlineMs }),
    uiSessionSecret: resolveUiSessionSecret(options.uiSessionSecret),
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

/** Localhost answers fast either way; an unanswered probe is read as free. */
const PORT_PROBE_TIMEOUT_MS = 500;

/**
 * "Address already in use" is the commonest first-run error, and Bun.serve on
 * macOS cannot report it against a FOREIGN listener: it binds over one with
 * reuse semantics, prints the healthy banner, and the kernel splits traffic
 * between two servers — intermittent 401s instead of a sentence. (Two BUN
 * listeners do collide loudly; the foreign case is the silent one.) So the
 * port is probed by CONNECTING first: anything answering on localhost means
 * taken, said here, before a database is booted for nothing. The probe is
 * best-effort — an unanswered connect (timeout) proceeds, and the tiny
 * check-to-bind race is accepted.
 */
const assertPortFree = async (port: number): Promise<void> => {
  const taken = await Promise.race([
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: { data: () => {} },
    }).then(
      (socket) => {
        socket.end();
        return true;
      },
      () => false,
    ),
    new Promise<boolean>((resolveProbe) => {
      setTimeout(() => resolveProbe(false), PORT_PROBE_TIMEOUT_MS);
    }),
  ]);
  if (taken) {
    throw new Error(
      `port ${port} is already in use — something is listening there ` +
        "(another crosscheck hub, or a different server). Stop it, or set " +
        "PORT to a free one.",
    );
  }
};

/**
 * Boot the hub from process env, exactly as `bun run packages/server/src/index.ts`
 * always has. Exported so the `crosscheck serve` CLI command (DESIGN.md §2's
 * `npx crosscheck-hub serve`) is this same code path rather than a second copy.
 */
export const startServer = async (): Promise<void> => {
  // Port checks come FIRST: a taken port must refuse before PGlite writes a
  // single byte, not after a full database boot.
  const port = parsePort(process.env["PORT"]);
  await assertPortFree(port);
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
  Bun.serve({ port, fetch: app.fetch });
  const searchMode =
    embedder === null ? "exact+fts (keyless)" : `exact+fts+vector (${embedder.model})`;
  console.log(`crosscheck server listening on :${port} · search: ${searchMode}`);
};

if (import.meta.main) {
  await startServer();
}