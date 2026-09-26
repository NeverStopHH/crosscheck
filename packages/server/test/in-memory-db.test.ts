/**
 * In-memory hub databases — one per test across the suite — must stay cheap.
 *
 * PGlite 0.4 runs initdb for every fresh cluster in extra WASM instances whose
 * memory it never gives back. Measured on 2026-09-26 (PGlite 0.4.6, Bun
 * 1.3.13, macOS, ten databases held open, RSS growth per database):
 *
 *   PGlite 0.3.16, own initdb each                              43 MB
 *   PGlite 0.4.6,  own initdb each                             510 MB
 *   0.4.6, a copy of one cluster initdb'd once per process     229 MB
 *   0.4.6, that copy with shared_buffers at 16 MB               60 MB
 *
 * At 510 MB the suite's single process ran out of memory late in the run
 * (`RangeError: Out of memory` inside PGlite), and CI's Linux runner was
 * cancelled at the same point. A hub opening its data dir costs the same on
 * both versions (435 vs 438 MB); only fresh clusters are expensive.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { createDb } from "../src/db/client.ts";

const CLIENT_PATH = new URL("../src/db/client.ts", import.meta.url).pathname;
const SERVER_DIR = new URL("..", import.meta.url).pathname;

/**
 * Databases measured after the warm-up one. Ten, because the warm-up's
 * leftovers are collected during the run and lower the average by a fixed
 * amount: at five, a copy with PostgreSQL's default buffers measured 99 MB.
 */
const MEASURED_DATABASES = 10;

/**
 * Between what this measurement gives for the fix and for a copy with
 * PostgreSQL's default buffers: 27 and 183 MB on macOS (Bun 1.3.13), 65 and
 * 205 MB on Linux amd64 (Bun 1.4.2). Without the copy: 376 and 336 MB.
 */
const MAX_MB_PER_DATABASE = 125;

const CHILD_TIMEOUT_MS = 60_000;

/**
 * RSS growth per open in-memory database, in a child process so the suite's
 * own heap does not blur it. The first database pays for compiling PGlite
 * and anything built once per process, so it is opened before measuring,
 * and what it leaves for the collector is collected before and after.
 */
const measureMbPerDatabase = async (): Promise<number> => {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "-e",
      `const { createDb } = await import(${JSON.stringify(CLIENT_PATH)});
       const kept = [await createDb()];
       const rssMb = () => { Bun.gc(true); return process.memoryUsage().rss / 1e6; };
       const before = rssMb();
       for (let i = 0; i < ${String(MEASURED_DATABASES)}; i++) kept.push(await createDb());
       console.log((rssMb() - before) / ${String(MEASURED_DATABASES)});
       process.exit();`,
    ],
    cwd: SERVER_DIR,
    stdout: "pipe",
    stderr: "ignore",
  });
  const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(exitCode).toBe(0);
  return Number(output.trim());
};

describe("an in-memory hub database", () => {
  test(
    `costs under ${String(MAX_MB_PER_DATABASE)} MB of memory while open`,
    async () => {
      expect(await measureMbPerDatabase()).toBeLessThan(MAX_MB_PER_DATABASE);
    },
    CHILD_TIMEOUT_MS,
  );

  test("shares nothing with another one opened in the same process", async () => {
    const first = await createDb();
    const second = await createDb();
    await first.execute(sql.raw("CREATE TABLE only_in_first (x int)"));
    await first.execute(sql.raw("INSERT INTO only_in_first VALUES (1)"));

    const seen = await second.execute<{ readonly relation: string | null }>(
      sql.raw("SELECT to_regclass('only_in_first')::text AS relation"),
    );

    expect(seen.rows[0]?.relation).toBeNull();
  });
});
