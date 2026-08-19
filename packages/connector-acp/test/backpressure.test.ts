/**
 * Backpressure, measured (§4.2 layer 1): a flood on either direction with a
 * slow peer must NOT buffer unboundedly inside the proxy. The proof is a
 * peak-RSS bound on the real spawned proxy while ~64 MiB stream through it,
 * PLUS byte-integrity of everything that arrived — a proxy that stays small
 * by dropping bytes would pass the memory half and fail the hash half.
 *
 * THE HARNESS IS RAW-FD ON PURPOSE. A slow peer built on the runtime's
 * high-level pipe streams is not slow at all: they slurp the pipe eagerly
 * into the peer's own memory (fd-io.ts header carries the measurements),
 * which silently removes the very stall this test exists to create. So the
 * proxy's client-facing stdio is wired through FIFOs the test reads and
 * writes with blocking raw-fd I/O and deliberate delays, and the fake
 * agent's slow-read mode does the same on its stdin — every stall is a real
 * kernel-buffer stall, end to end.
 *
 * The bound: unbounded buffering of a 64 MiB flood inflates RSS by ≥ the
 * flood size; a chunk-at-a-time pump holds one chunk plus pipe buffers.
 * 48 MiB of headroom separates the two regimes with margin for GC laziness.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { closeFd, fdByteSink, fdSource, openFd } from "../src/fd-io.ts";
import { floodChunk, floodExpectation } from "./fixtures/flood.ts";
import { BIN_PATH, FAKE_AGENT_PATH, makeTempHome, watchRss } from "./fixtures/e2e-helpers.ts";

const FLOOD_CHUNKS = 1024; // × ~64 KiB ≈ 64 MiB
const RSS_DELTA_BOUND_KB = 48 * 1024;
const READER_DELAY_MS = 2;
/** Sleep every N chunks on the reading side — slow, not glacial. */
const READER_DELAY_EVERY_CHUNKS = 4;
const BACKPRESSURE_TIMEOUT_MS = 120_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const mkfifo = (...paths: readonly string[]): void => {
  const made = Bun.spawnSync({ cmd: ["mkfifo", ...paths] });
  if (made.exitCode !== 0) throw new Error("mkfifo failed");
};

/**
 * Spawns the REAL proxy with its client-facing stdin/stdout rewired onto
 * FIFOs (`exec` keeps the spawned pid = the proxy, so RSS sampling and
 * exit codes see the proxy itself).
 */
const spawnProxyOnFifos = (
  home: string,
  agentArgs: readonly string[],
  fifos: { readonly stdinFifo?: string; readonly stdoutFifo?: string },
) => {
  const redirects =
    (fifos.stdinFifo === undefined ? "" : ` < '${fifos.stdinFifo}'`) +
    (fifos.stdoutFifo === undefined ? "" : ` > '${fifos.stdoutFifo}'`);
  return Bun.spawn({
    cmd: [
      "/bin/sh",
      "-c",
      `exec "$0" "$@"${redirects}`,
      process.execPath,
      BIN_PATH,
      "acp",
      "--",
      process.execPath,
      FAKE_AGENT_PATH,
      ...agentArgs,
    ],
    env: { ...process.env, CROSSCHECK_HOME: home },
    stdin: fifos.stdinFifo === undefined ? "pipe" : "ignore",
    stdout: fifos.stdoutFifo === undefined ? "pipe" : "ignore",
    stderr: "pipe",
  });
};

describe("§4.2: floods with a slow peer stay bounded and byte-perfect", () => {
  test(
    "agent→client: agent floods, client reads slowly — proxy memory stays flat",
    async () => {
      // Arrange
      const expected = floodExpectation(FLOOD_CHUNKS);
      const home = await makeTempHome();
      const outFifo = join(home, "client-out.fifo");
      mkfifo(outFifo);
      const proxy = spawnProxyOnFifos(home, ["--flood", String(FLOOD_CHUNKS)], {
        stdoutFifo: outFifo,
      });
      proxy.stdin?.end(); // stdin is "pipe" here; the ?. narrows the union type

      // Act: a deliberately slow raw-fd client — every unread byte stays in
      // the KERNEL pipe and stalls the writer above it. The RSS watch
      // starts AFTER the first chunk arrived: by then `sh` has exec'd into
      // the proxy and the runtime is warm, so baseline→peak measures what
      // the FLOOD adds — the unbounded-buffering signal — not the
      // interpreter's own footprint.
      const readFd = await openFd(outFifo, "r");
      const hasher = new Bun.CryptoHasher("sha256");
      let received = 0;
      let chunks = 0;
      let watch: ReturnType<typeof watchRss> | null = null;
      for await (const chunk of fdSource(readFd)) {
        hasher.update(chunk);
        received += chunk.byteLength;
        chunks += 1;
        watch ??= watchRss(proxy.pid);
        if (chunks % READER_DELAY_EVERY_CHUNKS === 0) await sleep(READER_DELAY_MS);
      }
      if (watch === null) throw new Error("flood produced no chunks");
      closeFd(readFd);
      const rss = await watch.stop();
      await proxy.exited;

      // Assert: every byte arrived, in order, and memory stayed bounded.
      expect(received).toBe(expected.bytes);
      expect(hasher.digest("hex")).toBe(expected.sha256);
      // A bound over zero samples proves nothing — measurement death is loud.
      expect(rss.samples).toBeGreaterThan(0);
      const deltaKb = rss.peakKb - rss.baselineKb;
      console.log(
        `a2c flood: ${received} bytes, proxy RSS baseline ${rss.baselineKb} KB, peak ${rss.peakKb} KB, delta ${deltaKb} KB (bound ${RSS_DELTA_BOUND_KB} KB, ${rss.samples} samples)`,
      );
      expect(deltaKb).toBeLessThan(RSS_DELTA_BOUND_KB);
    },
    BACKPRESSURE_TIMEOUT_MS,
  );

  test(
    "client→agent: client floods, agent reads slowly — proxy memory stays flat",
    async () => {
      // Arrange: the agent slow-reads its stdin with raw-fd reads and
      // hashes what it got.
      const expected = floodExpectation(FLOOD_CHUNKS);
      const home = await makeTempHome();
      const inFifo = join(home, "client-in.fifo");
      mkfifo(inFifo);
      const hashFile = join(home, "stdin-hash.txt");
      const proxy = spawnProxyOnFifos(
        home,
        ["--slow-read", String(READER_DELAY_MS), "--dump-stdin-hash", hashFile],
        { stdinFifo: inFifo },
      );

      // Act: flood through the FIFO with awaited raw-fd writes, then hang
      // up. The RSS watch starts after the first accepted write — same
      // post-exec baseline reasoning as the a2c test above.
      const writeFd = await openFd(inFifo, "w");
      const sink = fdByteSink(writeFd);
      let watch: ReturnType<typeof watchRss> | null = null;
      for (let index = 0; index < FLOOD_CHUNKS; index += 1) {
        await sink.write(floodChunk(index));
        watch ??= watchRss(proxy.pid);
      }
      if (watch === null) throw new Error("flood produced no chunks");
      closeFd(writeFd);
      const exit = await proxy.exited;
      const rss = await watch.stop();

      // Assert
      expect(exit).toBe(0);
      expect((await readFile(hashFile, "utf8")).trim()).toBe(
        `${expected.bytes} ${expected.sha256}`,
      );
      // A bound over zero samples proves nothing — measurement death is loud.
      expect(rss.samples).toBeGreaterThan(0);
      const deltaKb = rss.peakKb - rss.baselineKb;
      console.log(
        `c2a flood: ${expected.bytes} bytes, proxy RSS baseline ${rss.baselineKb} KB, peak ${rss.peakKb} KB, delta ${deltaKb} KB (bound ${RSS_DELTA_BOUND_KB} KB, ${rss.samples} samples)`,
      );
      expect(deltaKb).toBeLessThan(RSS_DELTA_BOUND_KB);
    },
    BACKPRESSURE_TIMEOUT_MS,
  );
});
