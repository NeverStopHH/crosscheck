/**
 * What a SECOND holder may and may not do to the first one's claim on the flush
 * lock.
 *
 * The lock exists to keep two flushes from sending the same batch twice and to
 * keep a reap out while a flush is running. Every test here is about the one
 * question that guarantee turns on: when is a lock on disk allowed to be taken
 * away from whoever wrote it?
 *
 * Two answers are wrong in opposite directions, and both have shipped:
 *   - taking it from a holder that is still INSIDE the critical section puts two
 *     holders in it at once, and the thief's release then deletes the lock
 *     outright, so every later arrival walks in unopposed;
 *   - never taking it at all leaves a crashed holder's claim on disk for good
 *     and flush never runs again.
 * The tests below pin both edges. "Crashed" includes the holder that has exited
 * and is still listed in the process table waiting to be reaped, which reads as
 * alive to anything that only asks whether the pid exists, and which is what a
 * hook dying under a parent that outlives it leaves behind.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  MAX_SPOOL_AGE_DAYS,
  MS_PER_DAY,
  SPOOL_LOCK_RETRIES,
  SPOOL_LOCK_STALE_MS,
  appendRecords,
  flushSpool,
  reapSpool,
  repoKey,
} from "../src/index.ts";
import {
  ensureDir,
  readTextOrNull,
  sessionSlug,
  spoolDataPath,
  spoolDir,
  spoolFlushLockPath,
} from "../src/config/paths.ts";
import { makeHome, spawnZombie } from "./helpers.ts";

const HUB_URL = "http://127.0.0.1:9";
const REPO_ID = "github.com/acme/api";
const KEY = repoKey(HUB_URL, REPO_ID);
const SESSION = "lock-session";
const SLUG = sessionSlug(SESSION);

const NOTHING_REAPED = { delivered: 0, expired: 0, dropped: 0 };
/** One record, expired and reapable — what a thief that got in would destroy. */
const ONE_EXPIRED_FILE = { delivered: 0, expired: 1, dropped: 1 };

const homes: string[] = [];
const children: number[] = [];

afterEach(async () => {
  for (const pid of children) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone, which is the state the test wanted anyway.
    }
  }
  children.length = 0;
  await Promise.all(homes.map((path) => rm(path, { recursive: true, force: true })));
  homes.length = 0;
});

const home = async (): Promise<string> => {
  const path = await makeHome("spool-lock");
  homes.push(path);
  return path;
};

const envelope = (index: number): Record<string, unknown> => ({
  cx: "0.1",
  id: `env_${index}`,
  ts: new Date().toISOString(),
  producer: {
    developerId: "unknown",
    agentKind: "claude-code",
    sessionId: "cc_old",
  },
  kind: "target",
  body: { workContextId: "wc_1", kind: "file", value: `src/file-${index}.ts` },
});

const hubContext = (path: string, hubUrl: string) => ({
  hubUrl,
  apiKey: "key",
  timeoutMs: 30_000,
  home: path,
  repoKey: KEY,
  now: () => new Date(),
});

/** Ages a file by the REAL clock, which is the only clock its mtime speaks. */
const backdate = async (path: string, byMs: number): Promise<void> => {
  const when = new Date(Date.now() - byMs);
  await utimes(path, when, when);
};

/** A dead session's file, old enough that `reap` wants to expire it. */
const plantExpiredSpool = async (path: string): Promise<void> => {
  await appendRecords(path, KEY, SESSION, [envelope(1)], new Date());
  await backdate(
    spoolDataPath(path, KEY, SLUG),
    (MAX_SPOOL_AGE_DAYS + 1) * MS_PER_DAY,
  );
};

const writeLock = async (path: string, token: string): Promise<void> => {
  await ensureDir(spoolDir(path, KEY));
  await writeFile(spoolFlushLockPath(path, KEY), token, "utf8");
};

/**
 * A clock running well ahead of the filesystem — what every test in this suite
 * injects, and what `reap` needs in order to consider a file expired at all.
 * Whether the LOCK may be retired must not follow from it.
 */
const clockWellAhead = (): Date =>
  new Date(Date.now() + (MAX_SPOOL_AGE_DAYS + 2) * MS_PER_DAY);

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

const deferred = (): Deferred => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

/** Accepts the batch, but not until the test says so — the flush waits inside the lock. */
const gatedHub = (arrived: () => void, release: Promise<void>) =>
  Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = (await request.json()) as { records: readonly unknown[] };
      arrived();
      await release;
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

/** A real process that outlives the assertion, so its pid is genuinely running. */
const liveProcess = (): number => {
  const proc = Bun.spawn({
    cmd: ["sleep", "30"],
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  children.push(proc.pid);
  return proc.pid;
};

/**
 * A pid that is provably gone: spawned, waited for, and reaped by this process,
 * so it is not left as a zombie that the process table still answers for.
 */
const deadPid = async (): Promise<number> => {
  const proc = Bun.spawn({
    cmd: ["true"],
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  const pid = proc.pid;
  await proc.exited;
  return pid;
};

describe("flush lock — a live holder keeps its claim", () => {
  test("a reap does not rob a flush that is still inside the lock", async () => {
    // Arrange: a dead session's expired file, and a flush parked mid-request
    // with the lock in its hand. The lock's mtime is then aged past the stale
    // deadline — which is all that a flush running longer than
    // SPOOL_LOCK_STALE_MS leaves on disk.
    const path = await home();
    await plantExpiredSpool(path);
    const arrived = deferred();
    const release = deferred();
    const server = gatedHub(arrived.resolve, release.promise);
    const flushing = flushSpool(
      hubContext(path, `http://127.0.0.1:${server.port}`),
      { sessionId: "cc_live", developerId: "dev_1" },
      60_000,
    );
    await arrived.promise;
    await backdate(spoolFlushLockPath(path, KEY), SPOOL_LOCK_STALE_MS * 10);

    // Act
    const reaped = await reapSpool(path, KEY, new Date());
    const survived = await Bun.file(spoolDataPath(path, KEY, SLUG)).exists();

    // Assert: the reap was locked out, and the file the flush was delivering is
    // still there. Reaping it would have deleted records mid-delivery.
    release.resolve();
    await flushing;
    server.stop(true);
    expect(reaped).toEqual(NOTHING_REAPED);
    expect(survived).toBe(true);
  });

  test("a lock held by another RUNNING process is not stolen, however old it looks", async () => {
    // Arrange: the claim of a process that is still running, aged far past the
    // stale deadline. Age is what makes a claim look abandoned; it is not what
    // makes it abandoned.
    const path = await home();
    await plantExpiredSpool(path);
    await writeLock(path, `${liveProcess()}:held\n`);
    await backdate(spoolFlushLockPath(path, KEY), SPOOL_LOCK_STALE_MS * 10);

    // Act
    const reaped = await reapSpool(path, KEY, clockWellAhead());

    // Assert
    expect(reaped).toEqual(NOTHING_REAPED);
    expect(await Bun.file(spoolDataPath(path, KEY, SLUG)).exists()).toBe(true);
  });

  test("an injected clock cannot retire a lock the filesystem says is fresh", async () => {
    // Arrange: a lock written a moment ago, and a caller whose clock is days
    // ahead. The mtime it is compared against is the filesystem's, so both sides
    // of that subtraction have to come from the same clock.
    const path = await home();
    await plantExpiredSpool(path);
    await writeLock(path, `${process.pid}:held\n`);

    // Act
    const reaped = await reapSpool(path, KEY, clockWellAhead());

    // Assert: nothing reaped, and the lock is still the one that was written.
    expect(reaped).toEqual(NOTHING_REAPED);
    expect(await readTextOrNull(spoolFlushLockPath(path, KEY))).toBe(
      `${process.pid}:held\n`,
    );
  });

  test("a fresh lock is not stolen even when its holder is already gone", async () => {
    // Arrange: nothing is holding this claim, but it was made moments ago — the
    // window in which a holder is between creating its lock and writing its
    // token, and in which deleting it put two writers in the section at once.
    const path = await home();
    await plantExpiredSpool(path);
    await writeLock(path, `${await deadPid()}:gone\n`);

    // Act
    const reaped = await reapSpool(path, KEY, clockWellAhead());

    // Assert
    expect(reaped).toEqual(NOTHING_REAPED);
    expect(await Bun.file(spoolDataPath(path, KEY, SLUG)).exists()).toBe(true);
  });
});

/**
 * What the liveness test is allowed to cost.
 *
 * Asking the OS whether a holder is a zombie costs a `ps` process on macOS.
 * Every hook takes this lock, so paying that on each acquisition would spend a
 * process on every hook forever to serve a case that occurs approximately
 * never. The probe therefore sits behind the age gate and behind the cheap
 * `kill(pid, 0)`, and an uncontended acquire — which is every normal one — must
 * never reach it.
 */
describe("flush lock — what the liveness test costs", () => {
  const HOT_PATH_FIXTURE = resolve(import.meta.dir, "fixtures", "lock-hot-path.ts");
  const HOT_PATH_CYCLES = 2000;

  test("an uncontended acquire spawns no process at all", async () => {
    // Arrange: a `ps` that records every invocation and answers nothing, first
    // on PATH. Whatever the lock resolves `ps` to, it resolves to this one.
    const path = await home();
    const shimDir = join(path, "shim-bin");
    const psLog = join(path, "ps-invocations.log");
    await mkdir(shimDir, { recursive: true });
    await writeFile(
      join(shimDir, "ps"),
      `#!/bin/sh\necho "$@" >> ${psLog}\nexit 1\n`,
      { encoding: "utf8", mode: 0o755 },
    );

    // Act
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        HOT_PATH_FIXTURE,
        spoolFlushLockPath(path, KEY),
        String(HOT_PATH_CYCLES),
      ],
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, PATH: `${shimDir}:${process.env["PATH"] ?? ""}` },
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);

    // Assert: every cycle took the lock, and none of them asked the OS anything
    // that costs a process.
    expect(exitCode).toBe(0);
    const measured = JSON.parse(stdout) as {
      cycles: number;
      acquired: number;
      meanUs: number;
    };
    expect(measured.acquired).toBe(HOT_PATH_CYCLES);
    expect(await Bun.file(psLog).exists()).toBe(false);
    // Printed, not asserted: a wall-clock threshold here would fail on a loaded
    // runner for reasons that have nothing to do with the lock.
    console.log(
      `HOT_PATH_MEAN_US=${measured.meanUs.toFixed(1)} PS_SPAWNS=${
        (await Bun.file(psLog).exists()) ? "some" : "0"
      }`,
    );
  });

  test("a stale lock held by a live pid spends ONE probe, not one per retry", async () => {
    // Arrange: the state that does reach the probe — a claim old enough to look
    // abandoned, behind a holder that is genuinely running. An acquisition
    // makes SPOOL_LOCK_RETRIES + 1 attempts against it, and a probe per attempt
    // would put that many processes on a hook for as long as the lock stays
    // wedged. This is also what proves the shim above can be reached at all: on
    // macOS the same mechanism that counts nothing there counts one here.
    const path = await home();
    const shimDir = join(path, "shim-bin");
    const psLog = join(path, "ps-invocations.log");
    await mkdir(shimDir, { recursive: true });
    await writeFile(
      join(shimDir, "ps"),
      `#!/bin/sh\necho "$@" >> ${psLog}\nexit 1\n`,
      { encoding: "utf8", mode: 0o755 },
    );
    await writeLock(path, `${liveProcess()}:held\n`);
    await backdate(spoolFlushLockPath(path, KEY), SPOOL_LOCK_STALE_MS * 10);

    // Act
    const proc = Bun.spawn({
      cmd: [process.execPath, HOT_PATH_FIXTURE, spoolFlushLockPath(path, KEY), "1"],
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, PATH: `${shimDir}:${process.env["PATH"] ?? ""}` },
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);

    // Assert: the lock stayed with its holder, and the OS was asked once.
    expect(exitCode).toBe(0);
    expect((JSON.parse(stdout) as { acquired: number }).acquired).toBe(0);
    const psCalls = (await Bun.file(psLog).exists())
      ? (await Bun.file(psLog).text()).trimEnd().split("\n").length
      : 0;
    // Linux reads the state out of /proc and spawns nothing at all; only the
    // platforms without /proc pay a process for the same answer.
    expect(psCalls).toBe(process.platform === "linux" ? 0 : 1);
    console.log(`COLD_PATH_PS_CALLS=${psCalls} ATTEMPTS=${SPOOL_LOCK_RETRIES + 1}`);
  });
});

describe("flush lock — an abandoned claim is still retired", () => {
  test("a lock left behind by a dead process is taken over", async () => {
    // Arrange: the signature of a SIGKILLed holder — its token on disk, its
    // process gone, and no release. This is the case the staleness rule exists
    // for, and it must survive any narrowing of that rule.
    const path = await home();
    await plantExpiredSpool(path);
    await writeLock(path, `${await deadPid()}:gone\n`);
    await backdate(spoolFlushLockPath(path, KEY), SPOOL_LOCK_STALE_MS * 10);

    // Act
    const reaped = await reapSpool(path, KEY, clockWellAhead());

    // Assert: the reap got in and did its work.
    expect(reaped).toEqual(ONE_EXPIRED_FILE);
    expect(await Bun.file(spoolDataPath(path, KEY, SLUG)).exists()).toBe(false);
  });

  test("a lock left behind by a ZOMBIE holder is taken over", async () => {
    // Arrange: a holder that crashed under a parent that has not reaped it.
    // `process.kill(pid, 0)` succeeds for that entry, so asking only whether the
    // pid EXISTS answers alive and the claim is never retired — a wedge that
    // needs no pid reuse, only a crash whose parent lingers.
    const path = await home();
    await plantExpiredSpool(path);
    const zombie = await spawnZombie();
    await writeLock(path, `${zombie.pid}:crashed\n`);
    await backdate(spoolFlushLockPath(path, KEY), SPOOL_LOCK_STALE_MS * 10);

    // Act
    const reaped = await reapSpool(path, KEY, clockWellAhead());
    zombie.release();

    // Assert: the reap got in, exactly as it does for any other dead holder.
    expect(reaped).toEqual(ONE_EXPIRED_FILE);
    expect(await Bun.file(spoolDataPath(path, KEY, SLUG)).exists()).toBe(false);
  });

  test("a lock whose token names no readable pid is taken over once it is stale", async () => {
    // Arrange: a truncated or corrupt lock file. Nothing can be proved about a
    // holder from it, so the age rule is all there is — refusing forever would
    // wedge flush for the life of the repo.
    const path = await home();
    await plantExpiredSpool(path);
    await writeLock(path, "not-a-token\n");
    await backdate(spoolFlushLockPath(path, KEY), SPOOL_LOCK_STALE_MS * 10);

    // Act
    const reaped = await reapSpool(path, KEY, clockWellAhead());

    // Assert
    expect(reaped).toEqual(ONE_EXPIRED_FILE);
  });

  test("a zombie holder's claim is not taken while it is still FRESH", async () => {
    // Arrange: the same dead-but-listed holder, on a lock made a moment ago.
    // Retiring a zombie must not widen the steal condition: the create gap —
    // where a holder has its file but not yet its token — stays protected by
    // age alone, and nothing about the holder may override that.
    const path = await home();
    await plantExpiredSpool(path);
    const zombie = await spawnZombie();
    await writeLock(path, `${zombie.pid}:crashed\n`);

    // Act
    const reaped = await reapSpool(path, KEY, clockWellAhead());
    zombie.release();

    // Assert
    expect(reaped).toEqual(NOTHING_REAPED);
    expect(await Bun.file(spoolDataPath(path, KEY, SLUG)).exists()).toBe(true);
  });

  test("an empty lock file is taken over once it is stale", async () => {
    // Arrange: `createLock` opens with `wx` and writes the token as a second
    // step, so a holder killed between the two leaves exactly this. Fresh, it is
    // protected by the test above; stale, it is nobody's claim.
    const path = await home();
    await plantExpiredSpool(path);
    await writeLock(path, "");
    await backdate(spoolFlushLockPath(path, KEY), SPOOL_LOCK_STALE_MS * 10);

    // Act
    const reaped = await reapSpool(path, KEY, clockWellAhead());

    // Assert
    expect(reaped).toEqual(ONE_EXPIRED_FILE);
  });
});
