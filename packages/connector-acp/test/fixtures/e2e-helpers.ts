/**
 * Shared plumbing for the subprocess E2E tests: spawn the REAL crosscheck bin
 * (in `packages/cli` since Block 8 ended design §1.2's named debt; tests
 * reach it by path, not by a manifest edge, so no dependency cycle exists),
 * drive a scripted client conversation over its stdio, and hash what came
 * back.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BIN_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "cli",
  "src",
  "bin",
  "crosscheck.ts",
);

export const FAKE_AGENT_PATH = join(import.meta.dir, "fake-agent.ts");

const NEWLINE = 0x0a;
const encoder = new TextEncoder();

export const makeTempHome = (): Promise<string> =>
  mkdtemp(join(tmpdir(), "crosscheck-acp-"));

export type PipedProc = ReturnType<typeof spawnProxy>;

export const spawnProxy = (
  home: string,
  proxyFlags: readonly string[],
  agentArgs: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
) =>
  Bun.spawn({
    cmd: [
      process.execPath,
      BIN_PATH,
      "acp",
      ...proxyFlags,
      "--",
      process.execPath,
      FAKE_AGENT_PATH,
      ...agentArgs,
    ],
    env: { ...process.env, CROSSCHECK_HOME: home, ...extraEnv },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

/** The unproxied control run the byte-identity proof compares against. */
export const spawnDirectAgent = (agentArgs: readonly string[]) =>
  Bun.spawn({
    cmd: [process.execPath, FAKE_AGENT_PATH, ...agentArgs],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

export const writeToSink = async (
  sink: { write(chunk: Uint8Array): unknown; flush(): unknown },
  data: string | Uint8Array,
): Promise<void> => {
  const wrote = sink.write(typeof data === "string" ? encoder.encode(data) : data);
  if (wrote instanceof Promise) await wrote;
  const flushed = sink.flush();
  if (flushed instanceof Promise) await flushed;
};

export const concatBytes = (parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

export const sha256Hex = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export interface DriveStep {
  /** Raw bytes the scripted client sends, newline included. */
  readonly send: string;
  /** Cumulative newline-terminated line count to wait for before the next send. */
  readonly untilLines: number;
}

/**
 * The §2.4 happy-path client script: initialize → session/new →
 * session/prompt. The fake agent answers 1 + 1 + 3 lines.
 */
export const HAPPY_STEPS: readonly DriveStep[] = [
  {
    send: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}\n',
    untilLines: 1,
  },
  {
    send: '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp/acp-e2e","mcpServers":[]}}\n',
    untilLines: 2,
  },
  {
    send: '{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"sess_fake_1","prompt":[{"type":"text","text":"hello"}]}}\n',
    untilLines: 5,
  },
];

/**
 * Drives the scripted conversation, then closes stdin and drains to EOF.
 * Returns every stdout byte received, in order.
 */
export const collectDrive = async (
  proc: PipedProc,
  steps: readonly DriveStep[],
): Promise<Uint8Array> => {
  const reader = proc.stdout.getReader();
  const received: Uint8Array[] = [];
  let newlines = 0;
  const readUntil = async (target: number): Promise<void> => {
    while (newlines < target) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error(`stdout ended at ${newlines}/${target} expected lines`);
      }
      received.push(value);
      for (const byte of value) {
        if (byte === NEWLINE) newlines += 1;
      }
    }
  };
  for (const step of steps) {
    await writeToSink(proc.stdin, step.send);
    await readUntil(step.untilLines);
  }
  proc.stdin.end();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received.push(value);
  }
  return concatBytes(received);
};

/**
 * KB resident-set size of a live process. procfs first — container images
 * (the ci.yml `cpu-starved` lane runs this suite in oven/bun, which ships
 * no `ps`) and any other Linux have it for free — with `ps` as the macOS
 * path. VmRSS is already in KB.
 */
export const rssKb = async (pid: number): Promise<number | null> => {
  try {
    const status = await Bun.file(`/proc/${pid}/status`).text();
    const vmRss = status.split("\n").find((line) => line.startsWith("VmRSS:"));
    if (vmRss !== undefined) {
      const value = Number.parseInt(vmRss.replace(/[^0-9]/g, ""), 10);
      if (Number.isFinite(value)) return value;
    }
  } catch {
    // no procfs (macOS): fall through to ps
  }
  const proc = Bun.spawn({
    cmd: ["ps", "-o", "rss=", "-p", String(pid)],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  const value = Number.parseInt(text.trim(), 10);
  return Number.isFinite(value) ? value : null;
};

const RSS_SAMPLE_INTERVAL_MS = 50;

export interface RssWatch {
  stop(): Promise<{ readonly baselineKb: number; readonly peakKb: number }>;
}

/** Samples a pid's RSS until stopped; first successful sample is the baseline. */
export const watchRss = (pid: number): RssWatch => {
  let running = true;
  let baseline: number | null = null;
  let peak = 0;
  const loop = (async () => {
    while (running) {
      const sample = await rssKb(pid);
      if (sample !== null) {
        baseline ??= sample;
        if (sample > peak) peak = sample;
      }
      await new Promise((resolve) => setTimeout(resolve, RSS_SAMPLE_INTERVAL_MS));
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return { baselineKb: baseline ?? 0, peakKb: peak };
    },
  };
};
