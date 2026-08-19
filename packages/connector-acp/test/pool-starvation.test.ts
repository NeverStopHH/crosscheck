/**
 * The unit-level pin of the 2-CPU wedge (2026-08-19), portable to ANY core
 * count. The shipped defect: fdSource parked one blocking `node:fs.read` per
 * idle direction on Bun's shared blocking-I/O pool, whose size is
 * max(2, hardwareConcurrency). On a <= 2-CPU Linux host the proxy's three
 * idle directions pinned the WHOLE pool, so data or EOF arriving after the
 * reads parked — and every queued async-fs task behind them (forward-path
 * writes, log appends) — was delivered only when a DIFFERENT direction got an
 * fd event. Zero-byte stdin EOF was never seen; the proxy hung at "spawned".
 *
 * The pin does not need a 2-CPU box: it saturates the pool the same way the
 * proxy did — max(2, hardwareConcurrency) idle parked directions — and then
 * demands that a live direction and an unrelated async-fs op still complete.
 * With the worker-backed reader (fd-reader.worker.ts) the idle directions
 * hold NO pool thread, so both complete in milliseconds; with the pool-parked
 * design both starve forever. Deterministic on every machine, both ways —
 * this file is also the mutation guard for the wake-safety mechanism
 * (mutation-check.ts re-introduces the pool-parked read and requires this
 * file to go red).
 *
 * Writer processes are `exec`-shaped (`exec 3> fifo; exec sleep …`) so the
 * holder pid IS the fd owner and kill() really closes the write end — a
 * `sh -c '…; sleep …'` holder leaks the fd into a child that survives the
 * kill, and cleanup then never EOFs the parked readers.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { openSync } from "node:fs";
import { appendFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fdSource } from "../src/fd-io.ts";

/** Bun's blocking-I/O pool never shrinks below two threads (measured 1.3.13). */
const BUN_POOL_FLOOR = 2;
/** Pool size on this machine — the number of idle directions that saturate it. */
const POOL_MAX = Math.max(BUN_POOL_FLOOR, navigator.hardwareConcurrency);
/**
 * Time the pool tasks have to be enqueued before the live probe starts. The
 * defect saturates the pool synchronously with each first read call, so this
 * is settling slack, not a race window.
 */
const PARK_SETTLE_MS = 300;
/** Far above healthy delivery (milliseconds); a starved pool misses it forever. */
const LIVE_DEADLINE_MS = 4_000;
const TEST_TIMEOUT_MS = 30_000;

/** A sentinel that names the defect right in the failure diff. */
const STARVED = "STARVED: the shared blocking-I/O pool never served this" as const;

const holders: ReturnType<typeof Bun.spawn>[] = [];
const drains: Promise<unknown>[] = [];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const mkfifo = (path: string): void => {
  const made = Bun.spawnSync({ cmd: ["mkfifo", path] });
  expect(made.exitCode).toBe(0);
};

/** Spawn a single-process fd holder; `action` runs between open and park. */
const spawnHolder = (path: string, action: string): void => {
  holders.push(
    Bun.spawn({
      cmd: ["/bin/sh", "-c", `exec 3> "$1"; ${action} exec sleep 600`, "sh", path],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }),
  );
};

/**
 * One idle proxy direction: a fifo whose writer holds the fd open silently,
 * with fdSource parked on the read end. The openSync rendezvous is
 * deterministic: it returns only once the holder has the write end open.
 */
const parkIdleDirection = (dir: string, index: number): void => {
  const path = join(dir, `idle-${index}`);
  mkfifo(path);
  spawnHolder(path, "");
  const fd = openSync(path, "r");
  drains.push(
    (async () => {
      for await (const chunk of fdSource(fd)) void chunk; // idle: parks on first read
    })(),
  );
};

const raceDeadline = <T>(work: Promise<T>) =>
  Promise.race([work, sleep(LIVE_DEADLINE_MS).then(() => STARVED)]);

afterEach(async () => {
  // EOF every parked reader (exec-shaped holders: kill == close the fd), then
  // let the drains finish so no parked generator leaks into the next test.
  for (const holder of holders) holder.kill();
  holders.length = 0;
  await Promise.all(drains);
  drains.length = 0;
});

describe("idle directions must not starve the shared blocking-I/O pool", () => {
  test(
    "data arriving after the idle directions parked is still delivered, and the pool still serves unrelated async fs",
    async () => {
      // Arrange: saturate the pool the way the proxy's idle directions did.
      const dir = await mkdtemp(join(tmpdir(), "acp-pool-starve-"));
      for (let index = 0; index < POOL_MAX; index += 1) parkIdleDirection(dir, index);
      await sleep(PARK_SETTLE_MS);

      // Act 1: a LIVE direction — its writer sends bytes only after the read
      // side is already parked, the exact late-arrival the wedge dropped.
      const livePath = join(dir, "live");
      mkfifo(livePath);
      spawnHolder(livePath, "sleep 0.2; printf WAKE >&3;");
      const liveFd = openSync(livePath, "r");
      const firstChunk = raceDeadline(
        (async (): Promise<string> => {
          for await (const chunk of fdSource(liveFd)) {
            return new TextDecoder().decode(chunk);
          }
          return "<ended without data>";
        })(),
      );

      // Act 2: an unrelated async-fs op — the wedge starved log appends the
      // same way, which is why the proxy log stopped at "spawned".
      const appendDone = raceDeadline(
        appendFile(join(dir, "unrelated.txt"), "one line\n").then(() => "appended"),
      );

      // Assert
      expect(await firstChunk).toBe("WAKE");
      expect(await appendDone).toBe("appended");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "zero-byte EOF arriving after the idle directions parked still ends the stream",
    async () => {
      // Arrange
      const dir = await mkdtemp(join(tmpdir(), "acp-pool-starve-eof-"));
      for (let index = 0; index < POOL_MAX; index += 1) parkIdleDirection(dir, index);
      await sleep(PARK_SETTLE_MS);

      // Act: the gate's stdin-eof shape — the peer closes WITHOUT ever
      // writing, after the read parked. The holder's `exec 3>&-` drops the
      // only write end; the parked read must see bytesRead=0 and end.
      const eofPath = join(dir, "eof");
      mkfifo(eofPath);
      spawnHolder(eofPath, "sleep 0.2; exec 3>&-;");
      const eofFd = openSync(eofPath, "r");
      const streamEnd = raceDeadline(
        (async (): Promise<string> => {
          for await (const chunk of fdSource(eofFd)) void chunk;
          return "eof-seen";
        })(),
      );

      // Assert
      expect(await streamEnd).toBe("eof-seen");
    },
    TEST_TIMEOUT_MS,
  );
});
