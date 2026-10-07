/**
 * THE HUB PRUNES ITS RECEIPTS AT BOOT (review-2 round 9, M4). The prune left
 * the SessionStart register route for the hub's own timer, whose first pass
 * comes SESSION_REAP_INTERVAL_MS after boot; a hub restarted after a month off
 * prunes the backlog once at boot instead, off the request path.
 *
 * In a child process: the boot is `startServer`, which is the process's.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { createDb, createServer } from "../src/index.ts";
import type { Db } from "../src/db/client.ts";
import { jsonRequest, TEST_ADMIN_TOKEN } from "./helpers.ts";

const INDEX_PATH = new URL("../src/index.ts", import.meta.url).pathname;
/** Receipts written a long retention ago. */
const BACKLOG = 3;
/** A PGlite boot from a data dir, with slack for a loaded machine. */
const BOOT_TIMEOUT_MS = 30_000;
const BOOT_LINE = "[crosscheck] record receipts:";

const randomPort = (): number => 20_000 + Math.floor(Math.random() * 20_000);

let proc: ReturnType<typeof Bun.spawn> | undefined;
const cleanups: string[] = [];

afterEach(async () => {
  proc?.kill();
  await proc?.exited;
  proc = undefined;
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const close = (db: Db): Promise<void> => (db as unknown as { $client: { close: () => Promise<void> } }).$client.close();

/** A data dir holding one developer and BACKLOG receipts past the retention. */
const dataDirWithBacklog = async (): Promise<string> => {
  const dataDir = await mkdtemp(join(tmpdir(), "receipts-boot-"));
  cleanups.push(dataDir);
  const db = await createDb({ dataDir });
  const app = createServer({ db, adminToken: TEST_ADMIN_TOKEN });
  const response = await app.request("/api/developers", jsonRequest("POST", TEST_ADMIN_TOKEN, { name: "Boot", email: "boot@example.com" }));
  const body = (await response.json()) as { data: { developer: { id: string } } };
  await db.execute(
    sql.raw(`INSERT INTO record_receipts (id, developer_id, result_id, received_at)
      SELECT 'env_' || g, '${body.data.developer.id}', NULL, to_timestamp(0) FROM generate_series(1, ${String(BACKLOG)}) g`),
  );
  await close(db);
  return dataDir;
};

/** Stdout until the line naming `marker` is complete, or what came before the deadline. */
const readLine = async (stream: ReadableStream<Uint8Array>, marker: string): Promise<string> => {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let seen = "";
  try {
    while (Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        Bun.sleep(deadline - Date.now()).then(() => "timeout" as const),
      ]);
      if (next === "timeout" || next.done) {
        break;
      }
      seen += decoder.decode(next.value, { stream: true });
      const at = seen.indexOf(marker);
      if (at >= 0 && seen.indexOf("\n", at) >= 0) {
        return seen.slice(at, seen.indexOf("\n", at));
      }
    }
  } finally {
    reader.releaseLock();
  }
  return seen;
};

describe("a hub booting onto receipts past their retention", () => {
  test(
    "prunes them once at boot, without waiting for its timer",
    async () => {
      // Arrange
      const dataDir = await dataDirWithBacklog();

      // Act
      proc = Bun.spawn({
        cmd: [process.execPath, INDEX_PATH],
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PORT: String(randomPort()), CROSSCHECK_DATA_DIR: dataDir },
      });
      const line = await readLine(proc.stdout as ReadableStream<Uint8Array>, BOOT_LINE);

      // Assert
      expect(line).toBe(`${BOOT_LINE} ${String(BACKLOG)} past their retention pruned at boot`);
    },
    BOOT_TIMEOUT_MS + 10_000,
  );
});
