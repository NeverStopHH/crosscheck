/**
 * The raw-fd layer under a hostile fd mode: something else set O_NONBLOCK on
 * the shared open file description (a sibling process can — the classic
 * "node flips stdin nonblocking" pipeline bug class). EAGAIN means "no data
 * yet / no room yet", never end-of-stream: a source that treats it as EOF
 * silently ends a live direction, and a sink that treats it as a hangup
 * silently DROPS bytes — both prime-directive violations. FIFOs give the
 * deterministic setup: a FIFO read end opened O_NONBLOCK returns EAGAIN
 * exactly when a writer is attached and the pipe is empty.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { constants, promises as fsp, read as fsRead } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fdByteSink, fdSource } from "../src/fd-io.ts";

const TEST_TIMEOUT_MS = 10_000;
const SETTLE_MS = 150;
const DRAIN_POLL_MS = 2;

const makeFifo = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "acp-fd-io-"));
  const path = join(dir, "fifo");
  const made = spawnSync("mkfifo", [path]);
  expect(made.status).toBe(0);
  return path;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("EAGAIN is a retry, never an EOF or a hangup", () => {
  test(
    "fdSource on a nonblocking fd keeps the stream alive and yields later data",
    async () => {
      // Arrange: read end O_NONBLOCK, writer attached but idle — the first
      // read hits EAGAIN, not EOF and not data.
      const fifo = await makeFifo();
      const readHandle = await fsp.open(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
      const writeHandle = await fsp.open(fifo, "w");
      const collected: number[] = [];
      let sourceDone = false;
      const run = (async () => {
        for await (const chunk of fdSource(readHandle.fd)) {
          collected.push(...chunk);
        }
        sourceDone = true;
      })();

      // Assert: the stream must NOT have ended while the writer merely idles.
      await sleep(SETTLE_MS);
      expect(sourceDone).toBe(false);

      // Act: now the data arrives, then the genuine EOF.
      await writeHandle.write("payload");
      await writeHandle.close();
      await run;

      // Assert: every byte arrived and the real EOF still ends the stream.
      expect(sourceDone).toBe(true);
      expect(new TextDecoder().decode(new Uint8Array(collected))).toBe("payload");
      await readHandle.close();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "fdByteSink on a nonblocking fd delivers the whole chunk instead of rejecting mid-write",
    async () => {
      // Arrange: nonblocking write end into a pipe far smaller than the
      // chunk — the kernel accepts a pipeful, then answers EAGAIN.
      const fifo = await makeFifo();
      const readHandle = await fsp.open(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
      const writeHandle = await fsp.open(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
      const chunk = new Uint8Array(256 * 1024);
      for (let index = 0; index < chunk.byteLength; index += 1) {
        chunk[index] = index % 251;
      }

      // Act: one sink write, drained concurrently by a slow test-side reader.
      let sinkError: unknown = null;
      const sinkRun = Promise.resolve(
        fdByteSink(writeHandle.fd).write(chunk),
      ).catch((error: unknown) => {
        sinkError = error;
      });
      const drained: Uint8Array[] = [];
      let drainedBytes = 0;
      const drainBuffer = Buffer.allocUnsafe(65_536);
      while (drainedBytes < chunk.byteLength) {
        const bytesRead = await new Promise<number>((resolve) => {
          fsRead(readHandle.fd, drainBuffer, 0, drainBuffer.length, null, (error, bytes) => {
            resolve(error ? -1 : bytes); // -1: the reader's own EAGAIN
          });
        });
        if (bytesRead > 0) {
          drained.push(Uint8Array.from(drainBuffer.subarray(0, bytesRead)));
          drainedBytes += bytesRead;
        }
        await sleep(DRAIN_POLL_MS);
      }
      await sinkRun;

      // Assert: resolved (no EAGAIN "hangup"), every byte delivered in order.
      expect(sinkError).toBeNull();
      expect(drainedBytes).toBe(chunk.byteLength);
      const all = new Uint8Array(drainedBytes);
      let offset = 0;
      for (const part of drained) {
        all.set(part, offset);
        offset += part.byteLength;
      }
      expect(Buffer.from(all).equals(Buffer.from(chunk))).toBe(true);
      await writeHandle.close();
      await readHandle.close();
    },
    TEST_TIMEOUT_MS,
  );
});
