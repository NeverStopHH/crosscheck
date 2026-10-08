/**
 * The in-process hub every release-gate case reports to: the REAL server over
 * PGlite on a random 127.0.0.1 port (never 7100, never a tailnet name), behind
 * a pass-through that keeps every request and answer in memory.
 *
 * WHY THE LOG. Two assertions need what crossed the wire rather than what a
 * table kept: the `.env` check (no captured content may leave a machine, in
 * any request body) and "a teammate's report named Nick's base commit" (the
 * hub keeps no row per landed_evidence record). Bodies stay in this process;
 * the Authorization header is reduced to the developer it names, never kept.
 *
 * THE CLOCK. `createServer({ now })` is the hub's own seam; `clock.setOffsetMs`
 * moves the hub's time and nothing else. The connector's clock is
 * `new Date()` (hooks/runner.ts) and has no seam, so only cases whose meaning
 * depends on HUB time use it (N3's "merged days before").
 */
import { sql } from "drizzle-orm";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

export const ADMIN_TOKEN = "release-gate-admin-token";

export interface WireEntry {
  readonly method: string;
  /** Pathname plus query. */
  readonly path: string;
  /** The developer the bearer key belongs to, or null for admin / unknown. */
  readonly developer: string | null;
  readonly requestBody: string;
  readonly status: number;
  readonly responseBody: string;
}

export interface HubClock {
  readonly now: () => Date;
  readonly setOffsetMs: (offsetMs: number) => void;
}

export interface HubDeveloper {
  readonly name: string;
  readonly email: string;
  readonly developerId: string;
  readonly apiKey: string;
}

export interface TestHub {
  readonly url: string;
  readonly db: Db;
  readonly clock: HubClock;
  readonly wire: readonly WireEntry[];
  readonly createDeveloper: (name: string, email: string) => Promise<HubDeveloper>;
  /** GET as a developer; throws on a non-2xx with the status in the message. */
  readonly getAs: <T>(developer: HubDeveloper, path: string) => Promise<T>;
  readonly close: () => Promise<void>;
}

const makeClock = (): HubClock => {
  const state = { offsetMs: 0 };
  return {
    now: () => new Date(Date.now() + state.offsetMs),
    setOffsetMs: (offsetMs) => {
      state.offsetMs = offsetMs;
    },
  };
};

const BEARER = /^Bearer\s+(.+)$/;

export const startHub = async (): Promise<TestHub> => {
  const db = await createDb();
  const clock = makeClock();
  const app = createServer({ db, adminToken: ADMIN_TOKEN, now: clock.now });
  const wire: WireEntry[] = [];
  const keyOwner = new Map<string, string>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const requestBody = request.method === "GET" ? "" : await request.clone().text();
      const response = await app.fetch(request);
      const responseBody = await response.clone().text();
      const key = BEARER.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
      const url = new URL(request.url);
      wire.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        developer: keyOwner.get(key) ?? null,
        requestBody,
        status: response.status,
        responseBody,
      });
      return response;
    },
  });
  const url = `http://127.0.0.1:${String(server.port)}`;

  // ONE account per person per hub: the same team works in every case's repo.
  const accounts = new Map<string, HubDeveloper>();
  const createDeveloper = async (name: string, email: string): Promise<HubDeveloper> => {
    const known = accounts.get(email);
    if (known !== undefined) {
      return known;
    }
    const response = await fetch(`${url}/api/developers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, email }),
    });
    if (!response.ok) {
      throw new Error(`createDeveloper ${name} failed: ${String(response.status)}`);
    }
    const body = (await response.json()) as { data: { developer: { id: string }; apiKey: string } };
    keyOwner.set(body.data.apiKey, name);
    const account = { name, email, developerId: body.data.developer.id, apiKey: body.data.apiKey };
    accounts.set(email, account);
    return account;
  };

  const getAs = async <T>(developer: HubDeveloper, path: string): Promise<T> => {
    const response = await fetch(`${url}${path}`, { headers: { Authorization: `Bearer ${developer.apiKey}` } });
    if (!response.ok) {
      throw new Error(`GET ${path} as ${developer.name} failed: ${String(response.status)}`);
    }
    return ((await response.json()) as { data: T }).data;
  };

  const close = async (): Promise<void> => {
    await server.stop(true);
    // Release the PGlite WASM instance (two-developers.e2e.test.ts says why).
    await (db as unknown as { $client: { close: () => Promise<void> } }).$client.close().catch(() => undefined);
  };

  return { url, db, clock, wire, createDeveloper, getAs, close };
};

/** Every row of every public table as one string — what the hub holds, for a content scan. */
export const dumpDatabase = async (db: Db): Promise<string> => {
  const tables = await db.execute(
    sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
  );
  const parts: string[] = [];
  for (const row of tables.rows) {
    const name = String(row["table_name"]);
    const rows = await db.execute(sql.raw(`select * from "${name.replaceAll('"', '""')}"`));
    // int8 columns arrive as bigint, which JSON.stringify refuses.
    parts.push(`${name}: ${JSON.stringify(rows.rows, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))}`);
  }
  return parts.join("\n");
};
