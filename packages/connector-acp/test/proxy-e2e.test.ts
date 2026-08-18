/**
 * Subprocess E2E (design §4.2 layer 3): the REAL crosscheck bin, spawned,
 * wrapping the scripted fake agent, driven by a scripted fake client. The
 * headline proof is byte identity: the full §2.4 happy-path conversation
 * through the proxy is compared hash-for-hash against the direct
 * (unproxied) run. Around it: exit codes, signals both directions, stderr
 * passthrough, partial-frame forwarding, the log file, and `--record`.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { DIE_MID_FRAME_PARTIAL, SLEEP_READY_LINE } from "./fixtures/fake-agent.ts";
import {
  BIN_PATH,
  HAPPY_STEPS,
  collectDrive,
  concatBytes,
  makeTempHome,
  sha256Hex,
  spawnDirectAgent,
  spawnProxy,
  writeToSink,
} from "./fixtures/e2e-helpers.ts";

const E2E_TIMEOUT_MS = 20_000;
const EXIT_USAGE = 64;
const EXIT_SPAWN_FAILURE = 127;

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return concatBytes(parts);
};

const readLogFile = async (home: string, pid: number): Promise<string> =>
  readFile(join(home, "logs", `acp-${pid}.log`), "utf8");

describe("byte transparency through the real binary", () => {
  test(
    "the proxied happy-path conversation is byte-identical to the direct run",
    async () => {
      // Arrange + Act: same scripted client against both topologies.
      const direct = spawnDirectAgent([]);
      const directBytes = await collectDrive(direct, HAPPY_STEPS);
      await direct.exited;

      const home = await makeTempHome();
      const proxied = spawnProxy(home, [], []);
      const proxiedBytes = await collectDrive(proxied, HAPPY_STEPS);
      const proxyExit = await proxied.exited;

      // Assert: hash both sides (§4.2's proof), and the exit mirrored.
      expect(sha256Hex(proxiedBytes)).toBe(sha256Hex(directBytes));
      expect(proxiedBytes.byteLength).toBe(directBytes.byteLength);
      expect(proxyExit).toBe(0);

      // The per-proxy log exists under the crosscheck home (§2.2).
      const log = await readLogFile(home, proxied.pid);
      expect(log).toContain("start pid=");
      expect(log).toMatch(/c2a bytes=\d+ lines=3 unparseable=0 oversized=0/);
      expect(log).toMatch(/a2c bytes=\d+ lines=5 unparseable=0 oversized=0/);
    },
    E2E_TIMEOUT_MS,
  );

  test(
    "a client hangup mid-frame reaches the agent byte-perfect: EOF after the partial",
    async () => {
      // Arrange
      const home = await makeTempHome();
      const dump = join(home, "stdin-dump.bin");
      const proxy = spawnProxy(home, [], ["--dump-stdin", dump]);
      const fullLine =
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}\n';
      const partial = '{"jsonrpc":"2.0","id":2,"method":"session/pro';

      // Act: a full frame, then a hangup mid-frame.
      await writeToSink(proxy.stdin, fullLine);
      await writeToSink(proxy.stdin, partial);
      proxy.stdin.end();
      const exit = await proxy.exited;

      // Assert: the agent saw EXACTLY what the client sent, partial included.
      const dumped = await readFile(dump);
      expect(new TextDecoder().decode(dumped)).toBe(fullLine + partial);
      expect(exit).toBe(0);
    },
    E2E_TIMEOUT_MS,
  );

  test(
    "an agent crash mid-frame forwards the partial bytes verbatim and mirrors the exit code",
    async () => {
      // Arrange: the agent answers the first request with half a frame, exit 3.
      const home = await makeTempHome();
      const proxy = spawnProxy(home, [], ["--die-mid-frame"]);

      // Act
      await writeToSink(proxy.stdin, '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
      const received = await readAll(proxy.stdout);
      const exit = await proxy.exited;

      // Assert
      expect(new TextDecoder().decode(received)).toBe(DIE_MID_FRAME_PARTIAL);
      expect(exit).toBe(3);
    },
    E2E_TIMEOUT_MS,
  );
});

describe("exit codes and signals, faithful in both directions", () => {
  test(
    "the agent's exit code passes through untouched",
    async () => {
      const home = await makeTempHome();
      const proxy = spawnProxy(home, [], ["--exit-code", "7"]);

      proxy.stdin.end();
      const exit = await proxy.exited;

      expect(exit).toBe(7);
    },
    E2E_TIMEOUT_MS,
  );

  test(
    "agent stderr passes through to the proxy's stderr",
    async () => {
      const home = await makeTempHome();
      const proxy = spawnProxy(home, [], ["--stderr", "agent-noise-marker"]);

      proxy.stdin.end();
      const stderr = new TextDecoder().decode(await readAll(proxy.stderr));
      await proxy.exited;

      expect(stderr).toContain("agent-noise-marker");
    },
    E2E_TIMEOUT_MS,
  );

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    test(
      `${signal} to the proxy is relayed to the agent, whose graceful exit is mirrored`,
      async () => {
        // Arrange: agent announces readiness, then waits for the signal.
        const home = await makeTempHome();
        const marker = join(home, `marker-${signal}`);
        const proxy = spawnProxy(home, [], [
          "--sleep",
          "--on-signal-marker",
          `${signal}:${marker}`,
        ]);
        const reader = proxy.stdout.getReader();
        const ready = await reader.read();
        expect(new TextDecoder().decode(ready.value ?? new Uint8Array())).toBe(
          SLEEP_READY_LINE,
        );

        // Act
        proxy.kill(signal);
        const exit = await proxy.exited;

        // Assert: handler ran (relay proven), graceful exit mirrored.
        expect(await readFile(marker, "utf8")).toBe("signaled\n");
        expect(exit).toBe(0);
      },
      E2E_TIMEOUT_MS,
    );
  }

  test(
    "an agent death by signal becomes the proxy's own death by the same signal",
    async () => {
      // Arrange: the agent SIGKILLs itself on the first request.
      const home = await makeTempHome();
      const proxy = spawnProxy(home, [], ["--kill-self", "SIGKILL"]);

      // Act
      await writeToSink(proxy.stdin, '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
      await proxy.exited;

      // Assert: the client's waitpid sees a signal death, not an exit code.
      expect(proxy.signalCode).toBe("SIGKILL");
    },
    E2E_TIMEOUT_MS,
  );
});

describe("observability without interference", () => {
  test(
    "--record captures both directions with parse verdicts; drop counters land in the log",
    async () => {
      // Arrange: happy path plus one unparseable line and one oversized line.
      const home = await makeTempHome();
      const recordPath = join(home, "wire.ndjson");
      const proxy = spawnProxy(home, ["--record", recordPath], []);
      const oversized = `${"x".repeat(2 * 1024 * 1024)}\n`;
      const steps = [
        ...HAPPY_STEPS,
        { send: "this is not json\n", untilLines: 6 },
        { send: oversized, untilLines: 7 },
      ];

      // Act
      await collectDrive(proxy, steps);
      await proxy.exited;

      // Assert: the record has every c2a line, verdicts included.
      const entries = (await readFile(recordPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((raw) => JSON.parse(raw) as Record<string, unknown>);
      const c2a = entries.filter((entry) => entry["dir"] === "c2a");
      const a2c = entries.filter((entry) => entry["dir"] === "a2c");
      expect(c2a.map((entry) => entry["line"] ?? "<oversized>")).toEqual([
        ...HAPPY_STEPS.map((step) => step.send.trimEnd()),
        "this is not json",
        "<oversized>",
      ]);
      expect(c2a[3]?.["parsed"]).toBe(false);
      expect(c2a[4]?.["oversized"]).toBe(oversized.length - 1);
      expect(a2c).toHaveLength(7);
      expect(a2c.every((entry) => entry["parsed"] === true)).toBe(true);

      // And the log summary carries the same counters.
      const log = await readLogFile(home, proxy.pid);
      expect(log).toMatch(/c2a bytes=\d+ lines=5 unparseable=1 oversized=1/);
      expect(log).toMatch(/record-drops=0/);
    },
    E2E_TIMEOUT_MS,
  );
});

describe("refusals happen before any agent exists", () => {
  test(
    "an unknown flag refuses with usage on stderr, exit 64",
    async () => {
      const proxy = Bun.spawn({
        cmd: [process.execPath, BIN_PATH, "acp", "--bogus", "--", "agent"],
        env: { ...process.env, CROSSCHECK_HOME: await makeTempHome() },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });

      const stderr = new TextDecoder().decode(await readAll(proxy.stderr));
      const exit = await proxy.exited;

      expect(exit).toBe(EXIT_USAGE);
      expect(stderr).toContain("--bogus");
      expect(stderr).toContain("usage: crosscheck acp");
    },
    E2E_TIMEOUT_MS,
  );

  test(
    "a missing -- separator refuses with usage, exit 64",
    async () => {
      const proxy = Bun.spawn({
        cmd: [process.execPath, BIN_PATH, "acp"],
        env: { ...process.env, CROSSCHECK_HOME: await makeTempHome() },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });

      const stderr = new TextDecoder().decode(await readAll(proxy.stderr));
      const exit = await proxy.exited;

      expect(exit).toBe(EXIT_USAGE);
      expect(stderr).toContain("usage: crosscheck acp");
    },
    E2E_TIMEOUT_MS,
  );

  test(
    "an unspawnable agent exits 127 with the reason on stderr",
    async () => {
      const proxy = Bun.spawn({
        cmd: [
          process.execPath,
          BIN_PATH,
          "acp",
          "--",
          "/nonexistent/crosscheck-acp-agent-xyz",
        ],
        env: { ...process.env, CROSSCHECK_HOME: await makeTempHome() },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });

      const stderr = new TextDecoder().decode(await readAll(proxy.stderr));
      const exit = await proxy.exited;

      expect(exit).toBe(EXIT_SPAWN_FAILURE);
      expect(stderr).toContain("cannot spawn");
    },
    E2E_TIMEOUT_MS,
  );
});
