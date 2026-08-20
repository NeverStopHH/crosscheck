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
 * WHERE A READ PARKS — the part this layer got wrong once. HISTORICAL
 * (fixed 2026-08-19): reads used async node:fs.read, which Bun runs on one
 * shared blocking-I/O pool sized max(2, hardwareConcurrency), and the old
 * header called an idle direction's parked read a "measured non-issue" —
 * measured on a 16-core Mac, where that pool has 16 threads. On a <= 2-CPU
 * Linux host the proxy's three parked directions pinned the WHOLE pool:
 * data or EOF arriving after a read parked was delivered only when a
 * DIFFERENT direction got an fd event, and every async-fs task queued
 * behind the parked reads (forward-path writes, log appends, FIFO opens)
 * starved with it — the proxy wedged with its log frozen at "spawned", and
 * a zero-byte stdin EOF was never seen at all. Reads (and the FIFO read-end
 * opens, which block the same way) now park on a DEDICATED worker thread
 * per direction (fd-reader.worker.ts): same kernel blocking read, same
 * backpressure, but the park can pin nothing shared and completions ride
 * the worker message channel onto the event loop, never through the pool.
 * Pinned at any core count by test/pool-starvation.test.ts, at the 2-CPU
 * boundary by test/cpu-starved-e2e.test.ts (ci.yml `cpu-starved` lane), and
 * mutation-check.ts re-introduces the pool-parked read and requires the pin
 * to go red. The pool no longer carries any of this layer's reads:
 *
 * VERIFY: grep -cE "read as fsRea[d]" packages/connector-acp/src/fd-io.ts
 * PRINTS: 0
 *
 * …and the blocking read lives in exactly one place, the reader thread:
 *
 * VERIFY: grep -rlE "readSyn[c]\(" packages/connector-acp/src | sort
 * PRINTS: packages/connector-acp/src/fd-reader.worker.ts
 *
 * The write side stays on the shared pool ON PURPOSE: a parked write is
 * genuine backpressure from a stalled client, it progresses the moment the
 * client drains, and at most two run at once (stdout + stderr) — the pool's
 * floor. Only a park that can last FOREVER while holding a shared thread —
 * an idle read — was the defect.
 */
import { close as fsClose, open as fsOpen, write as fsWrite } from "node:fs";
import { Worker } from "node:worker_threads";

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
 * test/fd-io.test.ts on O_NONBLOCK FIFO ends. (The read-side retry runs
 * inside fd-reader.worker.ts, where the sleep blocks only that thread.)
 */
export const FD_EAGAIN_RETRY_DELAY_MS = 5;

const FD_READER_WORKER_URL = new URL("./fd-reader.worker.ts", import.meta.url);

const isEagain = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | null)?.code === "EAGAIN";

/**
 * Open a path (FIFO ends included — these BLOCK until the peer opens). The
 * CALLBACK form of node:fs.open on purpose, never fs/promises: this layer
 * owns fds by NUMBER (closeFd closes them), and fs/promises would wrap the
 * fd in a FileHandle nobody keeps — a second owner whose GC reap closes the
 * fd underneath the live stream built on it, and which Bun 1.4.0 turned
 * from a deprecation warning into a thrown error (bun test v1.4.0 went red
 * in backpressure.test.ts exactly this way; ≤ 1.3.x only warned, which is
 * why local suites stayed green). Same shared-pool blocking open either
 * way — only the wrapper object is gone.
 */
export const openFd = (path: string, flags: "r" | "w"): Promise<number> =>
  new Promise((resolve, reject) => {
    fsOpen(path, flags, (error, fd) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(fd);
    });
  });

/** What the reader targets: an fd we already hold, or a path its thread opens. */
export type FdReaderTarget =
  | { readonly kind: "fd"; readonly fd: number }
  | { readonly kind: "path"; readonly path: string };

/** One pipe direction, read on its own dedicated thread (header says why). */
export interface FdReader {
  /**
   * Resolves with the direction's fd — immediately for "fd", once the
   * reader thread's blocking open returns for "path". Rejects if the open
   * fails or the reader dies first.
   */
  readonly opened: Promise<number>;
  /** The pull-based chunk stream; single use. Same contract fdSource keeps. */
  chunks(): AsyncIterable<Uint8Array>;
  /**
   * Idempotent reap: unref + terminate the reader thread. A thread parked
   * in a blocking syscall cannot be preempted — unref guarantees it can
   * never hold the process open, and process exit reaps it.
   */
  dispose(): void;
}

interface ReaderOpenMessage {
  readonly t: "open";
  readonly fd: number;
}
interface ReaderChunkMessage {
  readonly t: "chunk";
  readonly buffer: ArrayBuffer;
  readonly bytesRead: number;
}
interface ReaderEndMessage {
  readonly t: "eof" | "err";
  readonly code?: string;
}
type ReaderMessage = ReaderOpenMessage | ReaderChunkMessage | ReaderEndMessage;

/** A pull's outcome: a chunk, or null for "this stream is over" (eof/err/reap). */
type ReaderReply = ReaderChunkMessage | null;

export const createFdReader = (target: FdReaderTarget): FdReader => {
  const worker = new Worker(FD_READER_WORKER_URL, {
    workerData: {
      fd: target.kind === "fd" ? target.fd : null,
      path: target.kind === "path" ? target.path : null,
      eagainRetryDelayMs: FD_EAGAIN_RETRY_DELAY_MS,
    },
  });

  let disposed = false;
  /** Once true, no reply will ever arrive; every pull resolves null. */
  let ended = false;
  // Settling an already-settled promise is a no-op, so the fd form resolves
  // up front and every later reject (reader end, dispose) is inert on it.
  const openSettlers = Promise.withResolvers<number>();
  const opened = openSettlers.promise;
  if (target.kind === "fd") openSettlers.resolve(target.fd);
  // A caller that never awaits `opened` (fdSource does not) must not turn a
  // reader-end rejection into an unhandled-rejection crash; consumers that
  // DO await still see the rejection — handlers are independent.
  void opened.catch(() => undefined);
  let replyWaiter: ((reply: ReaderReply) => void) | null = null;

  const settleEnd = (reason: string): void => {
    if (ended) return;
    ended = true;
    openSettlers.reject(new Error(reason));
    if (replyWaiter !== null) {
      const waiter = replyWaiter;
      replyWaiter = null;
      waiter(null);
    }
  };

  worker.on("message", (message: ReaderMessage) => {
    if (message.t === "open") {
      openSettlers.resolve(message.fd);
      return;
    }
    if (message.t === "chunk") {
      if (replyWaiter !== null) {
        const waiter = replyWaiter;
        replyWaiter = null;
        waiter(message);
      }
      // A chunk with no waiter: the stream was abandoned (dispose raced a
      // completing read). The unproxied world drops in-flight bytes on a
      // dead reader the same way; nothing to do.
      return;
    }
    settleEnd(
      `fd reader ended (${message.t}${message.code === undefined ? "" : ` ${message.code}`})`,
    );
  });
  worker.on("error", (error: unknown) => {
    settleEnd(
      `fd reader worker failed (${error instanceof Error ? error.message : String(error)})`,
    );
  });
  worker.on("exit", () => {
    settleEnd("fd reader worker exited");
  });

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    settleEnd("fd reader disposed");
    worker.unref();
    void worker.terminate();
  };

  async function* chunkStream(): AsyncIterable<Uint8Array> {
    try {
      let buffer = new ArrayBuffer(FD_READ_CHUNK_BYTES);
      for (;;) {
        const reply = await new Promise<ReaderReply>((resolve) => {
          if (ended) {
            resolve(null);
            return;
          }
          replyWaiter = resolve;
          try {
            worker.postMessage({ buffer }, [buffer]);
          } catch {
            // Worker already gone: nothing will reply.
            replyWaiter = null;
            resolve(null);
          }
        });
        if (reply === null) return; // EOF, read error, or reaped — stream over
        // ONE buffer, ping-ponged by transfer: the reader may touch it again
        // only after the next pull hands it back, and the pump pulls only
        // after the sink's write resolved — the chunk contract, kept by
        // construction.
        yield new Uint8Array(reply.buffer, 0, reply.bytesRead);
        buffer = reply.buffer;
      }
    } finally {
      dispose();
    }
  }

  return { opened, chunks: chunkStream, dispose };
};

/**
 * Pull-based source over an fd we already hold: each chunk is read only when
 * the loop asks for the next one, so an unconsumed pipe fills in the KERNEL
 * and stalls its writer — never in this process. The read parks on a
 * dedicated thread (createFdReader); EAGAIN is retried there, because it
 * reports fd MODE, not stream state (header of FD_EAGAIN_RETRY_DELAY_MS). A
 * read error (fd closed under us at teardown) ends the stream like EOF.
 */
export async function* fdSource(fd: number): AsyncIterable<Uint8Array> {
  yield* createFdReader({ kind: "fd", fd }).chunks();
}

/**
 * Blocking-write sink: resolves only when the kernel accepted every byte,
 * partial pipe writes retried from the offset. A full pipe parks the write
 * until the reader drains it — that park IS the backpressure the pump
 * awaits, and the resolution is what frees the source's buffer for reuse.
 * Runs on the shared pool on purpose (header: a parked write is genuine
 * client backpressure and always progresses; only idle-read parks starved).
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
