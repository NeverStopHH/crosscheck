/**
 * A LONG-LIVED ENTRY RESTARTED WITHOUT A HOST'S RUNTIME VARIABLES STILL STOPS
 * WHEN ITS HOST STOPS IT (connector-core config/clean-restart.ts).
 *
 * Under `BUN_OPTIONS` an entry starts itself again, and the host only knows
 * the first pid. These run the MCP server and the ACP proxy as real
 * processes, as init and the editor start them, with `BUN_OPTIONS=--smol`
 * (harmless, but a bun startup variable), and require:
 * - each forwarded signal sent to the first pid ends the restarted process,
 *   and the first pid dies by the same signal (MCP) or mirrors the graceful
 *   exit (ACP, whose agent gets the relayed signal);
 * - closing stdin ends both;
 * - a first pid killed outright leaves no orphan.
 * "Nothing left" is checked by pid: the restarted process, and the ACP agent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, openSync, writeSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { FORWARDED_SIGNALS, SUPERVISOR_POLL_MS } from "@crosscheck/connector-core/config/clean-restart.ts";
import { RUNTIME_ISOLATION_FLAGS } from "@crosscheck/connector-core/config/runtime-isolation.ts";

const ENTRY = resolve(import.meta.dir, "..", "..", "src", "bin", "crosscheck.ts");
const FAKE_AGENT = resolve(import.meta.dir, "..", "..", "..", "connector-acp", "test", "fixtures", "fake-agent.ts");
const PROCESS_TIMEOUT_MS = 20_000;
const POLL_MS = 50;
/** A bun startup variable that changes nothing a test can see. */
const HOST_ENV = { BUN_OPTIONS: "--smol" };

/**
 * `cmd` with core dumps off for it and for everything it starts. SIGQUIT's
 * default action dumps core, and a bun MCP server maps about 6 GB it never
 * touched (Linux, bun 1.4.3: 5.7 GB dumpable, 57 MB resident). Where
 * core_pattern pipes cores to a handler, as systemd-coredump does on GitHub's
 * Ubuntu runners, the kernel writes all of it, untouched pages as zeros, and
 * `ulimit -c 0` does not stop a piped dump. There the restarted server and
 * then its re-raising supervisor each dump in turn: SIGQUIT did not end the
 * first pid within PROCESS_TIMEOUT_MS on ubuntu-latest, where SIGTERM, SIGINT
 * and SIGHUP took about 0.2 s, and macOS (no dumps by default) 0.19 s. These
 * tests prove the forwarding, not the host's crash handler: coredump_filter 0
 * leaves a Linux core its headers only, `ulimit -c 0` covers the rest, both
 * are inherited by the restarted process, and `exec` keeps the pid the host
 * started.
 */
const withoutCoreDumps = (cmd: readonly string[]): readonly string[] => [
  "/bin/sh",
  "-c",
  'ulimit -c 0; if [ -w /proc/self/coredump_filter ]; then echo 0 > /proc/self/coredump_filter; fi; exec "$@"',
  "sh",
  ...cmd,
];

const homes: string[] = [];
const started: ReturnType<typeof Bun.spawn>[] = [];
/** Every pid these tests made, by number: only these are ever killed, and only if a test failed to end them. */
const descendants: number[] = [];
/** FIFO ends this test holds open as a server's stdin. */
const heldFds: number[] = [];

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

afterEach(async () => {
  for (const proc of started) {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
    }
  }
  for (const pid of descendants.filter(isAlive)) {
    process.kill(pid, "SIGKILL");
  }
  for (const fd of heldFds) {
    closeSync(fd);
  }
  started.length = 0;
  descendants.length = 0;
  heldFds.length = 0;
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
  homes.length = 0;
});

/** Whether `proc` ended within the deadline: a hang fails an assertion instead of the test's timeout. */
const exitsWithin = async (proc: ReturnType<typeof Bun.spawn>, timeoutMs: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolveDeadline) => {
    timer = setTimeout(() => resolveDeadline(false), timeoutMs);
  });
  const ended = await Promise.race([proc.exited.then(() => true as const), deadline]);
  clearTimeout(timer);
  return ended;
};

/** Direct children of `pid`, from one `ps` listing (macOS and Linux). */
const childrenOf = (pid: number): readonly number[] =>
  Bun.spawnSync({ cmd: ["ps", "-A", "-o", "pid=,ppid="], stdout: "pipe" })
    .stdout.toString()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([child, parent]) => parent === pid && child !== undefined && Number.isInteger(child))
    .map(([child]) => child ?? -1);

const waitUntil = async (condition: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      return false;
    }
    await Bun.sleep(POLL_MS);
  }
  return true;
};

const scratchHome = async (label: string): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), `cx-restart-${label}-`));
  homes.push(home);
  return home;
};

const envFor = (home: string): Record<string, string> => ({
  PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
  HOME: home,
  CROSSCHECK_HOME: home,
  ...HOST_ENV,
});

/** Reads stdout until a line contains `needle`. */
const readUntil = async (stream: ReadableStream<Uint8Array>, needle: string): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes(needle)) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    seen += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return seen;
};

const INITIALIZE = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`;

/**
 * The MCP server as init writes it, answering one request so the restart is
 * known to be serving. Its stdin is a pipe owned by the first pid, or — with
 * `heldStdin` — a FIFO this test holds open, so the server's stdin outlives a
 * killed first pid (Bun closes a dead subprocess's stdin pipe, measured, and
 * that EOF alone would end the server).
 */
const startMcp = async (
  label: string,
  heldStdin = false,
): Promise<{ readonly host: ReturnType<typeof Bun.spawn>; readonly restarted: number }> => {
  const home = await scratchHome(label);
  const fifo = join(home, "stdin.fifo");
  if (heldStdin) {
    Bun.spawnSync({ cmd: ["mkfifo", fifo] });
    heldFds.push(openSync(fifo, "r+"));
  }
  const held = heldFds.at(-1);
  const host = Bun.spawn({
    cmd: [...withoutCoreDumps([process.execPath, ...RUNTIME_ISOLATION_FLAGS, ENTRY, "mcp"])],
    cwd: home,
    env: envFor(home),
    stdin: heldStdin && held !== undefined ? held : "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  started.push(host);
  if (heldStdin && held !== undefined) {
    writeSync(held, INITIALIZE);
  } else {
    const pipe = host.stdin;
    if (pipe === undefined || pipe === null || typeof pipe === "number") {
      throw new Error("expected a stdin pipe");
    }
    pipe.write(INITIALIZE);
    pipe.flush();
  }
  expect(await readUntil(host.stdout, '"id":1')).toContain('"id":1');
  const restarted = childrenOf(host.pid);
  descendants.push(...restarted);
  expect(restarted).toHaveLength(1);
  return { host, restarted: restarted[0] ?? -1 };
};

describe("the MCP server restarted under BUN_OPTIONS", () => {
  for (const signal of FORWARDED_SIGNALS) {
    test(
      `${signal} to the pid the host started ends the restarted server, and the first pid dies by it`,
      async () => {
        // Arrange
        const { host, restarted } = await startMcp(`mcp-${signal}`);

        // Act
        host.kill(signal);
        const ended = await exitsWithin(host, PROCESS_TIMEOUT_MS);

        // Assert
        expect(ended).toBe(true);
        expect(host.signalCode).toBe(signal);
        expect(await waitUntil(() => !isAlive(restarted), PROCESS_TIMEOUT_MS)).toBe(true);
      },
      PROCESS_TIMEOUT_MS * 2,
    );
  }

  test(
    "closing stdin ends the restarted server, and the first pid exits with its code",
    async () => {
      // Arrange
      const { host, restarted } = await startMcp("mcp-eof");

      // Act — the host closes the pipe, as an editor does on quit
      const pipe = host.stdin;
      if (pipe === undefined || pipe === null || typeof pipe === "number") {
        throw new Error("expected a stdin pipe");
      }
      await pipe.end();
      const ended = await exitsWithin(host, PROCESS_TIMEOUT_MS);

      // Assert
      expect(ended).toBe(true);
      expect(host.exitCode).toBe(0);
      expect(await waitUntil(() => !isAlive(restarted), PROCESS_TIMEOUT_MS)).toBe(true);
    },
    PROCESS_TIMEOUT_MS * 2,
  );

  test(
    "a first pid killed outright leaves no orphan: the restarted server hangs itself up",
    async () => {
      // Arrange — stdin is a FIFO this test holds, so only the supervisor watch can end it
      const { host, restarted } = await startMcp("mcp-sigkill", true);

      // Act
      host.kill("SIGKILL");
      await host.exited;

      // Assert
      expect(await waitUntil(() => !isAlive(restarted), SUPERVISOR_POLL_MS * 10)).toBe(true);
    },
    PROCESS_TIMEOUT_MS * 2,
  );
});

describe("the ACP proxy restarted under BUN_OPTIONS", () => {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    test(
      `${signal} to the pid the editor started reaches the agent through the restarted proxy, and nothing is left`,
      async () => {
        // Arrange — the agent waits for the signal and books it in a marker
        const home = await scratchHome(`acp-${signal}`);
        const marker = join(home, `marker-${signal}`);
        const host = Bun.spawn({
          cmd: [
            process.execPath,
            ...RUNTIME_ISOLATION_FLAGS,
            ENTRY,
            "acp",
            "--",
            process.execPath,
            FAKE_AGENT,
            "--sleep",
            "--on-signal-marker",
            `${signal}:${marker}`,
          ],
          cwd: home,
          env: envFor(home),
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
        });
        started.push(host);
        expect(await readUntil(host.stdout, "ready")).toContain("ready");
        const [proxy] = childrenOf(host.pid);
        const agents = proxy === undefined ? [] : childrenOf(proxy);
        descendants.push(...(proxy === undefined ? [] : [proxy]), ...agents);
        expect(proxy).toBeDefined();
        expect(agents.length).toBeGreaterThan(0);

        // Act
        host.kill(signal);
        const ended = await exitsWithin(host, PROCESS_TIMEOUT_MS);

        // Assert — the agent got it, its graceful exit was mirrored, nothing outlives the first pid
        expect(ended).toBe(true);
        expect(await readFile(marker, "utf8").catch(() => "")).toBe("signaled\n");
        expect(host.exitCode).toBe(0);
        expect(await waitUntil(() => [proxy ?? -1, ...agents].every((pid) => !isAlive(pid)), PROCESS_TIMEOUT_MS)).toBe(true);
      },
      PROCESS_TIMEOUT_MS * 2,
    );
  }
});
