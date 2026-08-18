/**
 * Pull-based raw-fd I/O — the only stream layer in this runtime that
 * actually applies backpressure, measured (2026-08-18, Bun 1.3.13):
 *
 *   - Bun.spawn's FileSink accepted a 64 MiB flood against a sleeping
 *     reader in 320 ms (+334 MB proxy RSS);
 *   - node:child_process readables slurped an unread 64 MiB child stdout
 *     in 21 ms (+145 MB RSS), and Bun.spawn's ReadableStream did the same;
 *   - node child stdin writes DID hold at the kernel pipe (write() false,
 *     'drain' pending against a sleeping reader) — the one high-level path
 *     that works, and the proxy uses it for exactly that one direction.
 *
 * Blocking read()/write() on raw fds have none of that: nothing is read
 * from a pipe until the consumer asks, nothing out-runs a full pipe, and
 * the kernel's pipe buffer is the ONLY buffer. The proxy holds one chunk
 * per direction in flight — test/backpressure.test.ts measures exactly
 * that on the spawned binary.
 *
 * NOTE a parked blocking read occupies a worker thread per idle direction
 * for the life of the session; with the proxy's three directions that is a
 * measured non-issue, revisited if Block 4 multiplies the fd count.
 */
import { close as fsClose, read as fsRead, write as fsWrite } from "node:fs";
import { open as openPromise } from "node:fs/promises";

import type { ByteSink } from "./pump.ts";

export const STDIN_FD = 0;
export const STDOUT_FD = 1;
export const STDERR_FD = 2;

/** One kernel-pipe-sized read at a time — the whole in-flight window. */
export const FD_READ_CHUNK_BYTES = 65_536;

/**
 * Retry delay when an fd unexpectedly reports EAGAIN: something set
 * O_NONBLOCK on the SHARED open file description — a sibling process
 * inheriting our stdio can (the classic "a tool flips stdin nonblocking"
 * pipeline bug class). EAGAIN means "no data yet / no room yet", never
 * end-of-stream: a source treating it as EOF silently ends a live
 * direction (and the session with it), and a sink treating it as a hangup
 * silently DROPS bytes — both prime-directive violations. So both sides
 * retry after this delay; genuine errors still end the stream. Pinned in
 * test/fd-io.test.ts on O_NONBLOCK FIFO ends.
 */
export const FD_EAGAIN_RETRY_DELAY_MS = 5;

const isEagain = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | null)?.code === "EAGAIN";

const delayMs = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Open a path (FIFO ends included — these BLOCK until the peer opens). */
export const openFd = async (path: string, flags: "r" | "w"): Promise<number> => {
  const handle = await openPromise(path, flags);
  return handle.fd;
};

const readFd = (fd: number, buffer: Buffer): Promise<number> =>
  new Promise((resolve, reject) => {
    fsRead(fd, buffer, 0, buffer.length, null, (error, bytesRead) => {
      if (error) reject(error);
      else resolve(bytesRead);
    });
  });

/**
 * Pull-based source: each chunk is read only when the loop asks for the
 * next one, so an unconsumed pipe fills in the KERNEL and stalls its
 * writer — never in this process.
 *
 * ONE buffer, reused across reads — this is what keeps a flood from
 * becoming GC churn the collector lags behind. Safe because of the pump's
 * chunk contract: a chunk is valid only until the sink's write resolves,
 * and the pump neither pulls the next chunk before that nor lets the
 * observer see anything but its own copy. A read error (fd closed under us
 * at teardown) ends the stream like EOF would — except EAGAIN, which is
 * retried: it reports fd MODE, not stream state (header of
 * FD_EAGAIN_RETRY_DELAY_MS).
 */
export async function* fdSource(fd: number): AsyncIterable<Uint8Array> {
  const buffer = Buffer.allocUnsafe(FD_READ_CHUNK_BYTES);
  for (;;) {
    let bytesRead: number;
    try {
      bytesRead = await readFd(fd, buffer);
    } catch (error) {
      if (isEagain(error)) {
        await delayMs(FD_EAGAIN_RETRY_DELAY_MS);
        continue;
      }
      return;
    }
    if (bytesRead === 0) return; // EOF: every writer closed
    yield buffer.subarray(0, bytesRead);
  }
}

/**
 * Blocking-write sink: resolves only when the kernel accepted every byte,
 * partial pipe writes retried from the offset. A full pipe parks the write
 * until the reader drains it — that park IS the backpressure the pump
 * awaits, and the resolution is what frees the source's buffer for reuse.
 */
export const fdByteSink = (fd: number): ByteSink => ({
  write(chunk) {
    return new Promise<void>((resolve, reject) => {
      const writeFrom = (offset: number): void => {
        fsWrite(fd, chunk, offset, chunk.byteLength - offset, null, (error, written) => {
          if (error) {
            if (isEagain(error)) {
              // Full-but-alive pipe on a nonblocking fd: retry from the
              // same offset — rejecting here would DROP the chunk's tail.
              setTimeout(() => writeFrom(offset), FD_EAGAIN_RETRY_DELAY_MS);
              return;
            }
            reject(error);
            return;
          }
          const next = offset + written;
          if (next < chunk.byteLength) {
            writeFrom(next);
            return;
          }
          resolve();
        });
      };
      writeFrom(0);
    });
  },
});

/** Fire-and-forget close; double closes and dead fds are non-events. */
export const closeFd = (fd: number): void => {
  try {
    fsClose(fd, () => {});
  } catch {
    // already closed
  }
};
