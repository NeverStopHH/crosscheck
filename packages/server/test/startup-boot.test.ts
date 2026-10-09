/**
 * A BOOTED HUB RUNS ITS START-UP UPGRADE PASSES (review round 4, L5: A8/A9).
 * Every pass had tests of its own, but nothing checked that `startServer`
 * runs them: the review's mutation probe deleted the boot's call to the doc
 * upgrade, and to the link cleanup, and every test stayed green.
 *
 * So this boots the real entry point as a child process — a random port,
 * a temp data dir seeded the way an older hub left it, no embedder — and
 * reads both passes' log lines and their effect on the data dir.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";

import { createDb } from "../src/db/client.ts";
import type { Db } from "../src/db/client.ts";

const SERVER_ENTRY = resolve(import.meta.dir, "..", "src", "index.ts");
/** Cold PGlite boot of a data dir plus both passes, with slack for a loaded machine. */
const BOOT_TIMEOUT_MS = 30_000;
/** A SIGTERM that takes longer than this is a hang, not a shutdown. */
const SHUTDOWN_TIMEOUT_MS = 5_000;
const CLEANUP_LINE = "[crosscheck] draft link cleanup:";
/** The pass's closing line — its start line comes first and says only what is waiting. */
const DOC_UPGRADE_LINE = "[crosscheck] doc upgrade: 1 work context doc(s) rebuilt without drafts";

/** Ephemeral-range port, random so parallel runs cannot collide (never the hub's 7100). */
const randomPort = (): number => 20_000 + Math.floor(Math.random() * 20_000);

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const closeDb = (db: Db): Promise<void> => (db as unknown as { $client: PGlite }).$client.close();

/** Two developers; Nick's pre-round context folds his draft into its doc; the old gate linked the draft into Robin's tree. */
const seedOlderHub = async (dataDir: string): Promise<void> => {
  const db = await createDb({ dataDir });
  await db.execute(sql`INSERT INTO developers (id, name, email, api_key_hash) VALUES ('dev_n','Nick','n@example.com','h1'), ('dev_r','Robin','r@example.com','h2')`);
  await db.execute(sql`
    INSERT INTO agent_sessions (id, developer_id, agent_kind, repo, branch, base_commit, status, started_at, last_heartbeat_at)
    VALUES ('ses_n','dev_n','claude','r','b','c','analyzing',now(),now()), ('ses_r','dev_r','claude','r','b','c','analyzing',now(),now())`);
  await db.execute(sql`
    INSERT INTO work_contexts (id, session_id, title, status, normalized_doc, doc_version, created_at)
    VALUES ('wc_n','ses_n','Nick','analyzing', E'Nick\nanalyzing\nhypothesis: zebrafrobnicator guess', 0, now()),
           ('wc_r','ses_r','Robin','analyzing', E'Robin\nanalyzing', 1, now())`);
  await db.execute(sql`
    INSERT INTO claims (id, work_context_id, author_session_id, kind, body, status, confidence, capture_mode, provenance, created_at)
    VALUES ('clm_n_draft','wc_n','ses_n','hypothesis','zebrafrobnicator guess','proposed',0.4,'auto','derived',now()),
           ('clm_r','wc_r','ses_r','observation','Robin vouched','proposed',0.9,'agent','declared',now())`);
  await db.execute(sql`
    INSERT INTO claim_edges (id, from_claim_id, to_claim_id, kind, author_session_id, note, created_at)
    VALUES ('edge_old_gate','clm_n_draft','clm_r','relates_to','ses_n','auto: similarity',now())`);
  await closeDb(db);
};

/** The hub's own env, minus anything that could pick a real embedder. */
const keylessEnv = (port: number, dataDir: string): Record<string, string | undefined> => {
  const { OPENAI_API_KEY: _openai, CROSSCHECK_OLLAMA_URL: _ollama, ...rest } = process.env;
  return { ...rest, PORT: String(port), CROSSCHECK_DATA_DIR: dataDir, CROSSCHECK_EMBEDDER: "none" };
};

/** Stdout until every marker has appeared, or the deadline. */
const readUntilAll = async (stream: ReadableStream<Uint8Array>, markers: readonly string[]): Promise<string> => {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let seen = "";
  try {
    while (Date.now() < deadline && !markers.every((marker) => seen.includes(marker))) {
      const next = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolveRace) => setTimeout(() => resolveRace("timeout"), deadline - Date.now())),
      ]);
      if (next === "timeout" || next.done) {
        break;
      }
      seen += decoder.decode(next.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return seen;
};

describe("startServer", () => {
  test(
    "a booted hub runs the link cleanup and the doc upgrade over what an older hub left",
    async () => {
      // Arrange
      const dataDir = await mkdtemp(join(tmpdir(), "crosscheck-boot-"));
      tempDirs.push(dataDir);
      await seedOlderHub(dataDir);

      // Act: boot the real entry point, wait for both passes, stop it
      const child = Bun.spawn({
        cmd: [process.execPath, SERVER_ENTRY],
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: keylessEnv(randomPort(), dataDir),
      });
      const stdout = await readUntilAll(child.stdout, [CLEANUP_LINE, DOC_UPGRADE_LINE]);
      child.kill("SIGTERM");
      const exit = await Promise.race([
        child.exited,
        new Promise<"hung">((resolveRace) => setTimeout(() => resolveRace("hung"), SHUTDOWN_TIMEOUT_MS)),
      ]);
      if (exit === "hung") {
        child.kill("SIGKILL");
        await child.exited;
      }
      const db = await createDb({ dataDir });
      const archived = await db.execute(sql`SELECT id FROM claim_edges_removed`);
      const doc = await db.execute(sql`SELECT doc_version, normalized_doc FROM work_contexts WHERE id = 'wc_n'`);
      await closeDb(db);

      // Assert: both passes ran, and said so
      expect(stdout).toContain(CLEANUP_LINE);
      expect(stdout).toContain("(pass dlc_");
      expect(stdout).toContain(DOC_UPGRADE_LINE);
      expect(archived.rows).toEqual([{ id: "edge_old_gate" }]);
      expect(doc.rows[0]).toMatchObject({ doc_version: 1 });
      expect((doc.rows[0] as { normalized_doc: string }).normalized_doc).not.toContain("zebrafrobnicator");
    },
    BOOT_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS * 3,
  );

  test(
    "a booted hub withholds an opted-out index before it listens, then rebuilds it and fills the words in the background (M10, M11)",
    async () => {
      // Arrange — Robin opted out on an older release (her doc still holds
      // her branch), and no row has its hint-floor words yet
      const dataDir = await mkdtemp(join(tmpdir(), "crosscheck-boot-"));
      tempDirs.push(dataDir);
      await seedOlderHub(dataDir);
      const seeded = await createDb({ dataDir });
      await seeded.execute(sql`UPDATE developers SET presence_opt_out = true WHERE id = 'dev_r'`);
      await seeded.execute(sql`UPDATE agent_sessions SET branch = 'feat/robin-lisbon' WHERE id = 'ses_r'`);
      await seeded.execute(sql`UPDATE work_contexts SET title = 'feat/robin-lisbon', normalized_doc = E'feat/robin-lisbon\nanalyzing' WHERE id = 'wc_r'`);
      await seeded.execute(sql`UPDATE claims SET words_tsv = NULL`);
      await seeded.execute(sql`UPDATE work_contexts SET words_tsv = NULL`);
      await closeDb(seeded);
      const withheld = "[crosscheck] search index: location titles withheld for 1 opted-out developer(s)";
      const listening = "crosscheck server listening on";
      const rebuilt = "[crosscheck] location index: rebuilt for 1 opted-out developer(s)";
      const words = "[crosscheck] words index: 2 claim(s) and";

      // Act
      const child = Bun.spawn({
        cmd: [process.execPath, SERVER_ENTRY],
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: keylessEnv(randomPort(), dataDir),
      });
      const stdout = await readUntilAll(child.stdout, [withheld, listening, rebuilt, words]);
      child.kill("SIGTERM");
      const exit = await Promise.race([
        child.exited,
        new Promise<"hung">((resolveRace) => setTimeout(() => resolveRace("hung"), SHUTDOWN_TIMEOUT_MS)),
      ]);
      if (exit === "hung") {
        child.kill("SIGKILL");
        await child.exited;
      }
      const db = await createDb({ dataDir });
      const doc = await db.execute<{ doc: string }>(sql`SELECT normalized_doc AS doc FROM work_contexts WHERE id = 'wc_r'`);
      const empty = await db.execute<{ n: number }>(
        sql`SELECT (SELECT count(*) FROM claims WHERE words_tsv IS NULL) + (SELECT count(*) FROM work_contexts WHERE words_tsv IS NULL) AS n`,
      );
      await closeDb(db);

      // Assert — withheld before the hub listened; rebuilt and filled after
      expect(stdout.indexOf(withheld)).toBeGreaterThanOrEqual(0);
      expect(stdout.indexOf(withheld)).toBeLessThan(stdout.indexOf(listening));
      expect(stdout.indexOf(listening)).toBeLessThan(stdout.indexOf(rebuilt));
      expect(stdout).toContain(words);
      expect(doc.rows[0]?.doc).not.toContain("lisbon");
      expect(doc.rows[0]?.doc).not.toBe("");
      expect(Number(empty.rows[0]?.n)).toBe(0);
    },
    BOOT_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS * 3,
  );
});
