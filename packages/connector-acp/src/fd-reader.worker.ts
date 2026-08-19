/**
 * The dedicated reader thread behind fd-io.ts createFdReader — one per pipe
 * direction, for the life of that direction.
 *
 * WHY A THREAD: Bun executes every async node:fs call on one shared
 * blocking-I/O pool sized max(2, hardwareConcurrency). A read parked there
 * for an idle direction pins a pool thread until data arrives, and on a
 * <= 2-CPU host the proxy's three directions pinned the WHOLE pool — data or
 * EOF arriving after the park was only delivered when a different direction
 * got an fd event (the 2026-08-19 wedge; fd-io.ts header carries the full
 * story). Here the park is `readSync` on this dedicated thread: the kernel's
 * blocking read is still the readiness mechanism — zero syscalls while idle,
 * instant wake on data or EOF — but the park can pin nothing shared, and
 * completions ride the worker message channel straight onto the parent's
 * event loop, never through the pool.
 *
 * PROTOCOL, strict ping-pong (the pump's one-chunk-in-flight contract):
 *   startup    workerData { fd, path, eagainRetryDelayMs }; exactly one of
 *              fd/path is set. A path is opened HERE with openSync — a FIFO
 *              read end blocks until the peer opens, and that wait must pin
 *              this thread, not a pool thread — then `{t:"open", fd}` goes up.
 *   pull       parent sends { buffer } (ArrayBuffer, transferred) only after
 *              the previous chunk's sink write resolved.
 *   reply      exactly one of `{t:"chunk", buffer, bytesRead}` (buffer
 *              transferred back — the same one ping-pongs forever, so a flood
 *              costs zero steady-state allocation), `{t:"eof"}` or
 *              `{t:"err", code}`; after eof/err the port closes and the
 *              thread ends.
 *
 * EAGAIN is retried after eagainRetryDelayMs, never surfaced: it reports fd
 * MODE (something flipped O_NONBLOCK on a shared open file description), not
 * stream state — the same rule fd-io.ts applies on the write side, pinned by
 * test/fd-io.test.ts. The sleep blocks only this thread.
 */
import { openSync, readSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

interface FdReaderInit {
  readonly fd: number | null;
  readonly path: string | null;
  readonly eagainRetryDelayMs: number;
}

interface PullMessage {
  readonly buffer: ArrayBuffer;
}

const isEagain = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | null)?.code === "EAGAIN";

const errorCode = (error: unknown): string =>
  (error as NodeJS.ErrnoException | null)?.code ?? "EUNKNOWN";

const run = (): void => {
  const port = parentPort;
  if (port === null) {
    throw new Error("fd-reader.worker.ts must run as a worker thread");
  }
  const init = workerData as FdReaderInit;

  let fd: number;
  try {
    fd = init.path === null ? (init.fd ?? -1) : openSync(init.path, "r");
  } catch (error) {
    // An open failure (path vanished under a cleanup race) must reject the
    // parent's `opened`, exactly as the old pool-based open rejected.
    port.postMessage({ t: "err", code: errorCode(error) });
    port.close();
    return;
  }
  port.postMessage({ t: "open", fd });

  port.on("message", (pull: PullMessage) => {
    const view = Buffer.from(pull.buffer);
    for (;;) {
      let bytesRead: number;
      try {
        bytesRead = readSync(fd, view, 0, view.length, null);
      } catch (error) {
        if (isEagain(error)) {
          Bun.sleepSync(init.eagainRetryDelayMs);
          continue;
        }
        // fd closed under us at teardown and the like: ends the stream,
        // exactly like the old pool read's error path.
        port.postMessage({ t: "err", code: errorCode(error) });
        port.close();
        return;
      }
      if (bytesRead === 0) {
        port.postMessage({ t: "eof" }); // every writer closed — the real EOF
        port.close();
        return;
      }
      port.postMessage({ t: "chunk", buffer: pull.buffer, bytesRead }, [pull.buffer]);
      return;
    }
  });
};

run();
