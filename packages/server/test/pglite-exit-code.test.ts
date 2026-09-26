/**
 * A process that opens the hub's database must end with ITS OWN exit code.
 *
 * PGlite 0.4 boots its WASM build through Emscripten's Node branch, whose
 * quit handler writes `process.exitCode = 99`. PGlite then restores the value
 * it saved before booting, `process.exitCode = saved` — and on a clean process
 * that value is `undefined`, which Bun IGNORES (Node resets). The 99 stays
 * until `close()`. Measured on 2026-09-26 with PGlite 0.4.6: a script that
 * opened a database and never closed it exited 99 on Bun 1.3.13 (macOS) and
 * 1.4.2 (Linux amd64, as in CI), and `bun test` 1.4.2 exited 99 for a file
 * whose tests all passed — which is how CI's mutation proof first saw it.
 * Upstream: electric-sql/pglite#975 (fixed for Node in 0.4.6) and #1083
 * (fixed for Bun in 0.5.6, a PostgreSQL 18 line this hub does not run yet).
 * `close()` has the opposite fault: it writes 0 over a code the process had
 * set (3 before, 0 after; 0.3.16 kept the 3).
 *
 * Each case runs in a child process, because the exit code is the process's.
 */
import { describe, expect, test } from "bun:test";

const CLIENT_PATH = new URL("../src/db/client.ts", import.meta.url).pathname;
const SERVER_DIR = new URL("..", import.meta.url).pathname;

/** A child boots PGlite with the vector extension and runs the bootstrap. */
const CHILD_TIMEOUT_MS = 30_000;

/**
 * Opens the hub's database, queries it, and never closes it. The open
 * database keeps the process alive for PostgreSQL's idle statistics timer,
 * about 10 s; `process.exit()` without a code ends it at once with the exit
 * code it holds, the one a natural end uses.
 */
const openAndLeaveOpen = (before: string): string =>
  `${before}
   const { createDb } = await import(${JSON.stringify(CLIENT_PATH)});
   const db = await createDb();
   await db.$client.query("SELECT 1");
   process.exit();`;

/** Asks the bundled build for its PostgreSQL major, which closes its database. */
const probeVersion = (before: string): string =>
  `${before}
   const { bundledPgMajor } = await import(${JSON.stringify(CLIENT_PATH)});
   await bundledPgMajor();`;

const exitCodeOf = async (script: string): Promise<number> => {
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", script],
    cwd: SERVER_DIR,
    stdout: "ignore",
    stderr: "ignore",
  });
  return child.exited;
};

describe("a process that opened the hub's database", () => {
  test(
    "exits 0 when nothing failed, even with the database still open",
    async () => {
      expect(await exitCodeOf(openAndLeaveOpen(""))).toBe(0);
    },
    CHILD_TIMEOUT_MS,
  );

  test(
    "keeps an exit code it had set before opening it",
    async () => {
      expect(await exitCodeOf(openAndLeaveOpen("process.exitCode = 3;"))).toBe(3);
    },
    CHILD_TIMEOUT_MS,
  );

  test(
    "keeps its exit code across the version probe, which closes its database",
    async () => {
      expect(await exitCodeOf(probeVersion("process.exitCode = 3;"))).toBe(3);
    },
    CHILD_TIMEOUT_MS,
  );
});
