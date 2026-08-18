#!/usr/bin/env bun
/**
 * Scripted fake ACP agent — the deterministic peer every proxy E2E test
 * drives (design §4.2 layer 3: "a scripted fake-agent binary"). Offline, no
 * clocks in its output, behavior composed entirely from argv:
 *
 *   --exit-code <n>              exit with n when stdin reaches EOF
 *   --stderr <text>              write one line to stderr at startup
 *   --die-mid-frame              on the first request: write half a frame, exit 3
 *   --kill-self <SIG>            on the first request: raise SIG on itself
 *   --on-signal-marker SIG:file  install a SIG handler: write file, exit 0
 *   --sleep                      announce "ready", then wait for signals only
 *   --dump-stdin <file>          append every raw stdin byte to file
 *   --dump-stdin-hash <file>     at EOF write "<byteCount> <sha256hex>" to file
 *   --flood <chunks>             write that many flood chunks, then exit 0
 *   --slow-read <ms>             sleep between stdin reads (backpressure peer)
 *
 * The default behavior is the §2.4 happy path: initialize → session/new →
 * session/prompt (two updates + result), error responses otherwise.
 */
import { appendFileSync, read as fsRead, writeFileSync } from "node:fs";

import { floodChunk } from "./flood.ts";

/** Exported so tests assert the exact bytes of a mid-frame death. */
export const DIE_MID_FRAME_PARTIAL = '{"jsonrpc":"2.0","id":1,"result":{"half":tru';
export const SLEEP_READY_LINE = "ready\n";

interface AgentOptions {
  readonly exitCode: number;
  readonly stderrBanner: string | undefined;
  readonly dieMidFrame: boolean;
  readonly killSelf: string | undefined;
  readonly signalMarkers: readonly { readonly signal: string; readonly file: string }[];
  readonly sleep: boolean;
  readonly dumpStdinPath: string | undefined;
  readonly dumpStdinHashPath: string | undefined;
  readonly floodChunks: number;
  readonly slowReadMs: number;
}

const parseOptions = (argv: readonly string[]): AgentOptions => {
  let exitCode = 0;
  let stderrBanner: string | undefined;
  let dieMidFrame = false;
  let killSelf: string | undefined;
  const signalMarkers: { signal: string; file: string }[] = [];
  let sleep = false;
  let dumpStdinPath: string | undefined;
  let dumpStdinHashPath: string | undefined;
  let floodChunks = 0;
  let slowReadMs = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = (): string => argv[++i] ?? "";
    if (flag === "--exit-code") exitCode = Number.parseInt(value(), 10);
    else if (flag === "--stderr") stderrBanner = value();
    else if (flag === "--die-mid-frame") dieMidFrame = true;
    else if (flag === "--kill-self") killSelf = value();
    else if (flag === "--on-signal-marker") {
      const [signal, file] = value().split(":");
      if (signal !== undefined && file !== undefined) signalMarkers.push({ signal, file });
    } else if (flag === "--sleep") sleep = true;
    else if (flag === "--dump-stdin") dumpStdinPath = value();
    else if (flag === "--dump-stdin-hash") dumpStdinHashPath = value();
    else if (flag === "--flood") floodChunks = Number.parseInt(value(), 10);
    else if (flag === "--slow-read") slowReadMs = Number.parseInt(value(), 10);
  }
  return {
    exitCode,
    stderrBanner,
    dieMidFrame,
    killSelf,
    signalMarkers,
    sleep,
    dumpStdinPath,
    dumpStdinHashPath,
    floodChunks,
    slowReadMs,
  };
};

const out = Bun.stdout.writer();
const encoder = new TextEncoder();

const writeOut = async (data: string | Uint8Array): Promise<void> => {
  out.write(typeof data === "string" ? encoder.encode(data) : data);
  const flushed = out.flush();
  if (flushed instanceof Promise) await flushed;
};

const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The §2.4 happy-path shapes, deterministic key order, no timestamps. */
const respond = (line: string): readonly string[] => {
  let message: { id?: unknown; method?: unknown };
  try {
    message = JSON.parse(line) as { id?: unknown; method?: unknown };
  } catch {
    return [
      `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`,
    ];
  }
  const id = message.id ?? null;
  if (message.method === "initialize") {
    return [
      `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "fake-agent", version: "1.0.0" },
          agentCapabilities: {},
        },
      })}\n`,
    ];
  }
  if (message.method === "session/new") {
    return [`${JSON.stringify({ jsonrpc: "2.0", id, result: { sessionId: "sess_fake_1" } })}\n`];
  }
  if (message.method === "session/prompt") {
    const update = (text: string): string =>
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess_fake_1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        },
      })}\n`;
    return [
      update("thinking"),
      update("done"),
      `${JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } })}\n`,
    ];
  }
  return [
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } })}\n`,
  ];
};

const main = async (): Promise<void> => {
  const options = parseOptions(process.argv.slice(2));
  if (options.stderrBanner !== undefined) {
    process.stderr.write(`${options.stderrBanner}\n`);
  }
  for (const marker of options.signalMarkers) {
    process.on(marker.signal as NodeJS.Signals, () => {
      writeFileSync(marker.file, "signaled\n");
      process.exit(0);
    });
  }
  if (options.floodChunks > 0) {
    for (let index = 0; index < options.floodChunks; index += 1) {
      await writeOut(floodChunk(index));
    }
    process.exit(0);
  }
  if (options.sleep) {
    await writeOut(SLEEP_READY_LINE);
    // Signals are the only way out; the interval keeps the loop alive.
    setInterval(() => {}, 1_000_000);
    return;
  }

  const hasher = new Bun.CryptoHasher("sha256");
  let stdinBytes = 0;

  // Slow-read/hash modes consume stdin with BLOCKING raw-fd reads: a real
  // slow peer whose unread pipe fills in the kernel and stalls its writer —
  // Bun.stdin.stream() would slurp eagerly and quietly un-slow the test.
  if (options.slowReadMs > 0 || options.dumpStdinHashPath !== undefined) {
    const buffer = Buffer.allocUnsafe(65_536);
    const readStdinRaw = (): Promise<number> =>
      new Promise((resolve, reject) => {
        fsRead(0, buffer, 0, buffer.length, null, (error, bytesRead) => {
          if (error) reject(error);
          else resolve(bytesRead);
        });
      });
    for (;;) {
      let bytesRead: number;
      try {
        bytesRead = await readStdinRaw();
      } catch {
        break;
      }
      if (bytesRead === 0) break;
      if (options.slowReadMs > 0) await sleepMs(options.slowReadMs);
      stdinBytes += bytesRead;
      hasher.update(buffer.subarray(0, bytesRead));
      if (options.dumpStdinPath !== undefined) {
        appendFileSync(options.dumpStdinPath, buffer.subarray(0, bytesRead));
      }
    }
    if (options.dumpStdinHashPath !== undefined) {
      writeFileSync(options.dumpStdinHashPath, `${stdinBytes} ${hasher.digest("hex")}\n`);
    }
    process.exit(options.exitCode);
  }

  let pendingText = "";
  const decoder = new TextDecoder();
  let sawRequest = false;

  for await (const chunk of Bun.stdin.stream()) {
    stdinBytes += chunk.byteLength;
    hasher.update(chunk);
    if (options.dumpStdinPath !== undefined) {
      appendFileSync(options.dumpStdinPath, chunk);
    }
    pendingText += decoder.decode(chunk, { stream: true });
    for (;;) {
      const newline = pendingText.indexOf("\n");
      if (newline === -1) break;
      const line = pendingText.slice(0, newline);
      pendingText = pendingText.slice(newline + 1);
      if (line.trim().length === 0) continue;
      if (!sawRequest) {
        sawRequest = true;
        if (options.killSelf !== undefined) {
          process.kill(process.pid, options.killSelf as NodeJS.Signals);
          await sleepMs(5_000); // SIGKILL lands before this ever matters
        }
        if (options.dieMidFrame) {
          await writeOut(DIE_MID_FRAME_PARTIAL);
          process.exit(3);
        }
      }
      for (const reply of respond(line)) {
        await writeOut(reply);
      }
    }
  }

  process.exit(options.exitCode);
};

if (import.meta.main) {
  void main();
}
