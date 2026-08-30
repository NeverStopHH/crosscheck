/**
 * What the #17 worktree resolution costs an ACP proxy, MEASURED — and what it
 * must not cost.
 *
 * THE BUDGET QUESTION ON THIS HOST IS QUEUE PRESSURE, NOT WIRE LATENCY. The
 * pump forwards first and hands the observer a COPY, and capture runs on a
 * serialized promise chain entirely off the forward path, so nothing here can
 * add latency to the wire (that half is the prime directive, pinned by
 * test/transparency.test.ts). What a slower dispatch CAN do is keep more bytes
 * in `pendingBytes`: past ACP_CAPTURE_MAX_PENDING_BYTES capture lines are
 * dropped and counted, and forwarding never sees that number. So the pins are
 * (i) the cold/warm dispatch cost, printed, and (ii) a flood of
 * worktree-bearing tool calls through the REAL pump with the REAL engine
 * attached: forwarded bytes hash-equal, and `dropped` stays 0.
 *
 * ACP pays the cold cost more often than Claude does: the session identity IS
 * the session cwd's identity, so the free "cwd sits in a sibling worktree"
 * candidate never applies and every out-of-checkout path takes the bounded
 * walk. The per-session cache is what makes that once per root.
 *
 * Elapsed times are printed so a slow run is a number in the log, not a guess.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ACP_CAPTURE_FLUSH_BUDGET_MS,
  ACP_CAPTURE_MAX_PENDING_BYTES,
} from "../src/constants.ts";
import { createLineObserver } from "../src/observer.ts";
import { pumpBytes } from "../src/pump.ts";
import type { ByteSink } from "../src/pump.ts";

import {
  REMOTE,
  bootCaptureHub,
  createHarness,
  handshake,
  toolCallUpdate,
} from "./fixtures/capture-harness.ts";
import type { CaptureHub, Harness } from "./fixtures/capture-harness.ts";
import { git, makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";

/** Enough frames to matter, far below the 4 MiB pending cap on purpose. */
const FLOOD_FRAMES = 200;

let hub: CaptureHub;
const cleanups: string[] = [];

beforeAll(async () => {
  hub = await bootCaptureHub("acp-caplat");
});

afterAll(async () => {
  hub.server.stop(true);
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

const repoWithWorktree = async (
  label: string,
): Promise<{ main: string; worktree: string }> => {
  const main = await makeRepo(label, { remote: REMOTE });
  await writeFile(
    join(main, ".crosscheck.json"),
    `${JSON.stringify({ hubUrl: hub.hubUrl }, null, 2)}\n`,
    "utf8",
  );
  await git(main, ["add", "."]);
  await git(main, ["commit", "-m", "config"]);
  const worktree = join(await mkdtemp(join(tmpdir(), `cx-acp-caplat-${label}-`)), "feature");
  await git(main, ["worktree", "add", worktree, "HEAD"]);
  cleanups.push(main, join(worktree, ".."));
  return { main, worktree };
};

const harnessAt = async (label: string, repo: string): Promise<Harness> => {
  const home = await makeHome(label);
  cleanups.push(home);
  return createHarness(hub, cleanups, label, { home, repo });
};

const editLine = (sessionId: string, path: string, id: number): string =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: `call_${String(id)}`,
        kind: "edit",
        status: "in_progress",
        locations: [{ path }],
      },
    },
  });

describe("the worktree resolution's cost on the capture chain", () => {
  test("cold first-touch and warm cache, measured through the real engine", async () => {
    // Arrange
    const { main, worktree } = await repoWithWorktree("cold-warm");
    await writeRepoFile(worktree, "src/one.ts", "export const a = 1;\n");
    await writeRepoFile(worktree, "src/two.ts", "export const b = 2;\n");
    const h = await harnessAt("acp-caplat-cw", main);
    const sessionId = "sess_caplat";
    handshake(h, sessionId, main);
    await h.capture.settle();

    // Act: the first touch of the worktree root resolves identity (cold), the
    // second touch of the SAME root reads the session's cache (warm).
    const coldStart = performance.now();
    h.capture.offer(
      "a2c",
      toolCallUpdate(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "call_cold",
        kind: "edit",
        status: "in_progress",
        locations: [{ path: join(worktree, "src/one.ts") }],
      }),
    );
    await h.capture.settle();
    const coldMs = Math.round(performance.now() - coldStart);

    const warmStart = performance.now();
    h.capture.offer(
      "a2c",
      toolCallUpdate(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "call_warm",
        kind: "edit",
        status: "in_progress",
        locations: [{ path: join(worktree, "src/two.ts") }],
      }),
    );
    await h.capture.settle();
    const warmMs = Math.round(performance.now() - warmStart);

    // Assert: both targets landed, and the warm dispatch is no slower than the
    // cold one — the cache is the whole reason the git cost is once per root
    console.log(
      `[acp-capture-latency] cold ${String(coldMs)} ms, warm ${String(warmMs)} ms ` +
        `(flush budget ${String(ACP_CAPTURE_FLUSH_BUDGET_MS)} ms, pending cap ${String(ACP_CAPTURE_MAX_PENDING_BYTES)} bytes)`,
    );
    expect(h.capture.counters().targets).toBe(2);
    expect(warmMs).toBeLessThanOrEqual(coldMs + 50);
  });

  test("a flood of worktree edits forwards byte-identically and drops no capture line", async () => {
    // Arrange: the REAL pump with the REAL capture engine as its observer —
    // the shape the proxy runs — flooded with tool calls that all resolve
    // through the worktree walk.
    const { main, worktree } = await repoWithWorktree("flood");
    await writeRepoFile(worktree, "src/flood.ts", "export const a = 1;\n");
    const h = await harnessAt("acp-caplat-flood", main);
    const sessionId = "sess_flood";
    handshake(h, sessionId, main);
    await h.capture.settle();

    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    for (let index = 0; index < FLOOD_FRAMES; index += 1) {
      chunks.push(
        encoder.encode(`${editLine(sessionId, join(worktree, "src/flood.ts"), index)}\n`),
      );
    }
    const parts: Uint8Array[] = [];
    const sink: ByteSink = {
      write(chunk) {
        parts.push(chunk.slice());
      },
    };
    const observer = createLineObserver();

    // Act
    async function* source(): AsyncIterable<Uint8Array> {
      for (const chunk of chunks) {
        await Promise.resolve();
        yield chunk;
      }
    }
    const start = performance.now();
    await pumpBytes(source(), sink, (copy) => {
      for (const event of observer.push(copy)) {
        h.capture.offer("a2c", event);
      }
    });
    await h.capture.settle();
    const floodMs = Math.round(performance.now() - start);

    // Assert: the forwarded bytes are the input bytes, and no capture line was
    // dropped for queue pressure
    const concat = (values: readonly Uint8Array[]): Uint8Array => {
      const total = values.reduce((sum, part) => sum + part.byteLength, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const part of values) {
        out.set(part, offset);
        offset += part.byteLength;
      }
      return out;
    };
    const sha256 = (bytes: Uint8Array): string =>
      new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const inputHash = sha256(concat(chunks));
    const outputHash = sha256(concat(parts));
    console.log(
      `[acp-capture-latency] ${String(FLOOD_FRAMES)} worktree tool calls in ` +
        `${String(floodMs)} ms, dropped ${String(h.capture.counters().dropped)}`,
    );
    expect(outputHash).toBe(inputHash);
    expect(h.capture.counters().dropped).toBe(0);
    // One target for the file, then the seen-set: the flood costs the wire
    // nothing and the hub nothing after the first.
    expect(h.capture.counters().targets).toBe(1);
  });
});
