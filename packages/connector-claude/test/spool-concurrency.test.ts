/**
 * The accounting proof, run against real OS processes.
 *
 * The invariant under test: every record handed to the spool ends up in exactly
 * one of three places — on disk awaiting flush, delivered to the hub, or
 * counted in the `.drops` ledger. Never a fourth outcome, never two at once,
 * never silently neither.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdir, rm, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  MAX_SPOOL_BYTES,
  SPOOL_REAP_GRACE_MS,
  flushSpool,
  readDropSummary,
  readSpoolLines,
  reapSpool,
  repoKey,
} from "../src/index.ts";
import {
  ensureDir,
  sessionSlug,
  sessionStatePathForSlug,
  spoolDataPath,
  spoolDir,
} from "../src/config/paths.ts";
import { makeHome } from "./helpers.ts";

const WORKER_PATH = resolve(import.meta.dir, "fixtures", "spool-append-worker.ts");
const HUB_URL = "http://127.0.0.1:9";
const REPO_ID = "github.com/acme/api";
const KEY = repoKey(HUB_URL, REPO_ID);

/** The brief asks for at least twenty of each; these are the floors, not tuning. */
const WORKERS = 20;
const ROUNDS = 21;
const APPENDS_PER_WORKER = 5;
const TOTAL_RECORDS = WORKERS * APPENDS_PER_WORKER;

/** Fat records widen the write window, so a torn line would be visible. */
const PAD_BYTES = 4000;
/** Marks the filler that puts a round near or over the cap. */
const SEED_PREFIX = "seed_";
/** Room for a handful of records, so a "crossing" round lands some and refuses some. */
const CROSSING_HEADROOM_BYTES = 20_000;
const TEST_TIMEOUT_MS = 600_000;

const SHARED_SESSION = "stress-session";

type CapRegime = "below" | "crossing" | "above";

const REGIMES: readonly CapRegime[] = ["below", "crossing", "above"];

interface Outcome {
  readonly id: string;
  readonly persisted: boolean;
  readonly dropped: number;
}

/** No hook hosts these flushes, so nothing bounds them but the batch ceiling. */
const AMPLE_BUDGET_MS = 60_000;

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.map((path) => rm(path, { recursive: true, force: true })));
  homes.length = 0;
});

const newHome = async (label: string): Promise<string> => {
  const path = await makeHome(label);
  homes.push(path);
  return path;
};

const runWorker = async (
  home: string,
  sessionId: string,
  workerId: string,
  endSession: boolean,
): Promise<readonly Outcome[]> => {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      WORKER_PATH,
      home,
      KEY,
      sessionId,
      workerId,
      String(APPENDS_PER_WORKER),
      String(PAD_BYTES),
      endSession ? "end" : "keep",
    ],
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`worker ${workerId} exited ${exitCode}: ${stderr}`);
  }
  return JSON.parse(stdout) as readonly Outcome[];
};

const seedEnvelope = (index: number, padBytes: number): string =>
  JSON.stringify({
    cx: "0.1",
    id: `${SEED_PREFIX}${index}`,
    ts: new Date().toISOString(),
    producer: {
      developerId: "dev_1",
      agentKind: "claude-code",
      sessionId: "cc_seed",
    },
    kind: "target",
    body: {
      workContextId: "wc_1",
      kind: "file",
      value: "src/seed.ts",
      pad: "s".repeat(padBytes),
    },
  });

/** Fills the session's file to the byte budget the round is meant to exercise. */
const seedToRegime = async (
  home: string,
  regime: CapRegime,
): Promise<number> => {
  if (regime === "below") {
    return 0;
  }
  const budget =
    regime === "above"
      ? MAX_SPOOL_BYTES
      : MAX_SPOOL_BYTES - CROSSING_HEADROOM_BYTES;
  await ensureDir(spoolDir(home, KEY));
  const lines: string[] = [];
  let bytes = 0;
  for (let index = 0; bytes < budget; index += 1) {
    const line = seedEnvelope(index, PAD_BYTES);
    lines.push(line);
    bytes += Buffer.byteLength(line, "utf8") + 1;
  }
  await writeFile(
    spoolDataPath(home, KEY, sessionSlug(SHARED_SESSION)),
    `${lines.join("\n")}\n`,
    "utf8",
  );
  return lines.length;
};

interface DiskView {
  readonly targetIds: readonly string[];
  readonly torn: number;
}

/** Target ids on disk, and how many complete lines are not JSON at all. */
const readDisk = async (home: string): Promise<DiskView> => {
  const lines = await readSpoolLines(home, KEY);
  const targetIds: string[] = [];
  let torn = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { id?: unknown };
      if (typeof parsed.id !== "string") {
        torn += 1;
      } else if (!parsed.id.startsWith(SEED_PREFIX)) {
        targetIds.push(parsed.id);
      }
    } catch {
      torn += 1;
    }
  }
  return { targetIds, torn };
};

/**
 * Backdates the data files of sessions whose state file is already gone, so
 * `reap` gets past its quiescence grace and actually deletes files while other
 * workers are still appending.
 *
 * Without this the grace suppresses every unlink in a test that finishes in
 * milliseconds, and the reap-vs-append accounting proof stops proving anything.
 * Only files whose worker has already deleted its state are touched, and that
 * worker does that AFTER its last append — exactly the state in which the grace
 * has nothing left to protect.
 */
const backdateFinishedSessions = async (home: string): Promise<number> => {
  const idle = new Date(Date.now() - SPOOL_REAP_GRACE_MS * 2);
  let backdated = 0;
  let names: readonly string[];
  try {
    names = await readdir(spoolDir(home, KEY));
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) {
      continue;
    }
    const slug = name.slice(0, -".jsonl".length);
    if (await Bun.file(sessionStatePathForSlug(home, slug)).exists()) {
      continue;
    }
    await utimes(join(spoolDir(home, KEY), name), idle, idle);
    backdated += 1;
  }
  return backdated;
};

const acceptingHub = (received: string[]) =>
  Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = (await request.json()) as {
        records: readonly { id: string }[];
      };
      received.push(...body.records.map((record) => record.id));
      return Response.json({
        ok: true,
        data: {
          accepted: body.records.length,
          duplicates: 0,
          ignored: 0,
          rejected: 0,
        },
      });
    },
  });

describe("spool under real concurrent processes", () => {
  test(
    "every record is on disk, delivered, or counted — across every cap regime",
    async () => {
      const report: string[] = [];
      for (let round = 0; round < ROUNDS; round += 1) {
        // Arrange
        const regime = REGIMES[round % REGIMES.length] as CapRegime;
        const home = await newHome(`spool-stress-${round}`);
        const seeded = await seedToRegime(home, regime);

        // Act: twenty OS processes appending to one session's file at once
        const outcomes = (
          await Promise.all(
            Array.from({ length: WORKERS }, (_unused, worker) =>
              runWorker(home, SHARED_SESSION, `r${round}w${worker}`, false),
            ),
          )
        ).flat();

        // Assert
        const disk = await readDisk(home);
        const drops = await readDropSummary(home, KEY);
        const persistedIds = outcomes
          .filter((outcome) => outcome.persisted)
          .map((outcome) => outcome.id);
        const refusedIds = outcomes
          .filter((outcome) => !outcome.persisted)
          .map((outcome) => outcome.id);

        report.push(
          `round ${String(round).padStart(2)} ${regime.padEnd(8)} ` +
            `seed=${String(seeded).padStart(3)} handed=${TOTAL_RECORDS} ` +
            `onDisk=${String(disk.targetIds.length).padStart(3)} ` +
            `dropped=${String(drops.records).padStart(3)} ` +
            `entries=${String(drops.entries).padStart(3)} ` +
            `torn=${disk.torn} malformed=${drops.malformed}`,
        );

        expect(outcomes).toHaveLength(TOTAL_RECORDS);
        // No torn line, and no unreadable ledger entry, anywhere.
        expect(disk.torn).toBe(0);
        expect(drops.malformed).toBe(0);
        // No duplicates.
        expect(new Set(disk.targetIds).size).toBe(disk.targetIds.length);
        // The set on disk is exactly the set reported persisted.
        expect([...disk.targetIds].sort()).toEqual([...persistedIds].sort());
        // Nothing refused is also on disk.
        expect(disk.targetIds.filter((id) => refusedIds.includes(id))).toEqual([]);
        // On disk ∪ counted = exactly what was handed in.
        expect(disk.targetIds.length + drops.records).toBe(TOTAL_RECORDS);
        expect(drops.records).toBe(refusedIds.length);
      }
      console.log(`\n${report.join("\n")}\n`);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "flush, append and reap running together still account for every record",
    async () => {
      const report: string[] = [];
      const CONCURRENT_ROUNDS = 5;
      for (let round = 0; round < CONCURRENT_ROUNDS; round += 1) {
        // Arrange: a hub that accepts everything and remembers what it saw
        const home = await newHome(`spool-mixed-${round}`);
        const received: string[] = [];
        const server = acceptingHub(received);
        const ctx = {
          hubUrl: `http://127.0.0.1:${server.port}`,
          apiKey: "key",
          timeoutMs: 5000,
          home,
          repoKey: KEY,
          now: () => new Date(),
        };

        // Act: each worker is its own session, so reap has real files to
        // consider while flushes and appends are still in flight
        const appending = Promise.all(
          Array.from({ length: WORKERS }, (_unused, worker) =>
            runWorker(home, `mixed-${round}-${worker}`, `m${round}w${worker}`, true),
          ),
        );
        let appendsDone = false;
        void appending.then(() => {
          appendsDone = true;
        });
        let reaped = { delivered: 0, expired: 0, dropped: 0 };
        while (!appendsDone) {
          await flushSpool(ctx, { sessionId: "cc_live", developerId: "dev_1" }, AMPLE_BUDGET_MS);
          await backdateFinishedSessions(home);
          const result = await reapSpool(home, KEY, new Date());
          reaped = {
            delivered: reaped.delivered + result.delivered,
            expired: reaped.expired + result.expired,
            dropped: reaped.dropped + result.dropped,
          };
        }
        const outcomes = (await appending).flat();
        for (let drain = 0; drain < WORKERS + 1; drain += 1) {
          await flushSpool(ctx, { sessionId: "cc_live", developerId: "dev_1" }, AMPLE_BUDGET_MS);
        }
        await backdateFinishedSessions(home);
        const result = await reapSpool(home, KEY, new Date());
        reaped = {
          delivered: reaped.delivered + result.delivered,
          expired: reaped.expired + result.expired,
          dropped: reaped.dropped + result.dropped,
        };

        // Assert
        const disk = await readDisk(home);
        const drops = await readDropSummary(home, KEY);
        const accounted = [...received, ...disk.targetIds];
        report.push(
          `round ${round} handed=${TOTAL_RECORDS} ` +
            `delivered=${String(received.length).padStart(3)} ` +
            `onDisk=${String(disk.targetIds.length).padStart(3)} ` +
            `dropped=${drops.records} torn=${disk.torn} ` +
            `filesReaped=${reaped.delivered} expired=${reaped.expired}`,
        );
        // The reap path must actually have run, or this proves nothing.
        expect(reaped.delivered).toBeGreaterThan(0);
        report.push(
          `        reap windows exercised: ${reaped.delivered} file deletions`,
        );

        expect(outcomes).toHaveLength(TOTAL_RECORDS);
        expect(disk.torn).toBe(0);
        expect(drops.malformed).toBe(0);
        // Delivered ∪ on-disk holds no record twice.
        expect(new Set(accounted).size).toBe(accounted.length);
        // Delivered ∪ on-disk ∪ counted = exactly what was handed in.
        expect(accounted.length + drops.records).toBe(TOTAL_RECORDS);
        expect(drops.records).toBe(0);
        server.stop(true);
      }
      console.log(`\n${report.join("\n")}\n`);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a live session's file is never reaped while its writers are running",
    async () => {
      // Arrange: workers keep their session state file for their whole run
      const home = await newHome("spool-reap-live");
      const dataPath = spoolDataPath(home, KEY, sessionSlug(SHARED_SESSION));

      // Act: reap as hard as possible while twenty processes append
      const appending = Promise.all(
        Array.from({ length: WORKERS }, (_unused, worker) =>
          runWorker(home, SHARED_SESSION, `live-w${worker}`, false),
        ),
      );
      let appendsDone = false;
      void appending.then(() => {
        appendsDone = true;
      });
      let reapCalls = 0;
      while (!appendsDone) {
        // Backdated on purpose, so the quiescence grace cannot be what saves
        // the file: the ONLY thing standing between it and an unlink is the
        // session state its writers still hold.
        if (await Bun.file(dataPath).exists()) {
          const idle = new Date(Date.now() - SPOOL_REAP_GRACE_MS * 2);
          await utimes(dataPath, idle, idle);
        }
        await reapSpool(home, KEY, new Date());
        reapCalls += 1;
      }
      const outcomes = (await appending).flat();

      // Assert
      const disk = await readDisk(home);
      const drops = await readDropSummary(home, KEY);
      console.log(
        `\nreap-vs-live: reapCalls=${reapCalls} handed=${TOTAL_RECORDS} ` +
          `onDisk=${disk.targetIds.length} dropped=${drops.records}\n`,
      );
      expect(outcomes).toHaveLength(TOTAL_RECORDS);
      expect(await Bun.file(dataPath).exists()).toBe(true);
      expect(disk.targetIds).toHaveLength(TOTAL_RECORDS);
      expect(drops.records).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});