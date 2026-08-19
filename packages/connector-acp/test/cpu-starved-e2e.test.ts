/**
 * The three gate probes of the 2-CPU wedge (2026-08-19), on the REAL binary:
 *
 *   stdin-eof    zero bytes ever sent, stdin closed after the pumps parked —
 *                the proxy must exit promptly (the wedge never saw the EOF;
 *                its log stopped at "spawned");
 *   step2        an interactive step with stdin HELD OPEN — the reply must
 *                cross while the client is still talking (the wedge released
 *                it only when stdin closed);
 *   sleep-ready  an agent that speaks first — its ready line must cross
 *                (the wedge never delivered it).
 *
 * WHY THIS FILE SKIPS ABOVE 2 EFFECTIVE CPUS: the defect was starvation of
 * Bun's shared blocking-I/O pool (size max(2, hardwareConcurrency)) by the
 * proxy's three parked idle-direction reads — at >= 3 CPUs the pool always
 * has a free thread and the unfixed code was green, so on a developer
 * machine these probes discriminate nothing. The CI lane runs this file
 * inside a `--cpus=2 --cpuset-cpus=0,1` container (ci.yml `cpu-starved`
 * job), where it was RED on the unfixed code. The mechanism itself is pinned
 * at ANY core count by pool-starvation.test.ts, which runs everywhere.
 *
 * Local reproduction of this lane:
 *
 *   docker run --rm -v "$PWD":/repo -w /repo --cpus=2 --cpuset-cpus=0,1 \
 *     oven/bun:1 bun test packages/connector-acp/test/cpu-starved-e2e.test.ts
 */
import { describe, expect, test } from "bun:test";

import { BIN_PATH, FAKE_AGENT_PATH, makeTempHome } from "./fixtures/e2e-helpers.ts";

/** The starvation boundary: pool max(2, hwConcurrency) vs three directions. */
const STARVED_CPU_MAX = 2;
const isStarvedHost = navigator.hardwareConcurrency <= STARVED_CPU_MAX;

/** Cold TS transpile of the CLI graph on a starved box is slow. */
const FIRST_REPLY_BUDGET_MS = 20_000;
/** After the pumps are up a healthy reply is milliseconds. */
const REPLY_BUDGET_MS = 8_000;
/** Idle time before acting, so every direction's read has parked. */
const PARK_SETTLE_MS = 2_500;
const EXIT_BUDGET_MS = 10_000;
const TEST_TIMEOUT_MS = 60_000;

const INITIALIZE =
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}\n';
const SESSION_NEW =
  '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp/acp-e2e","mcpServers":[]}}\n';

if (!isStarvedHost) {
  console.log(
    `cpu-starved-e2e: SKIPPED — ${navigator.hardwareConcurrency} effective CPUs ` +
      `(> ${STARVED_CPU_MAX}); the wedge only discriminates at <= ${STARVED_CPU_MAX}. ` +
      "CI runs this file in the 2-CPU docker lane; locally use the command in the header.",
  );
}

const spawnProxyDirect = async (agentArgs: readonly string[]) => {
  const home = await makeTempHome();
  return Bun.spawn({
    cmd: [process.execPath, BIN_PATH, "acp", "--", process.execPath, FAKE_AGENT_PATH, ...agentArgs],
    env: { ...process.env, CROSSCHECK_HOME: home },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
};

type Proxy = Awaited<ReturnType<typeof spawnProxyDirect>>;

interface StdoutWatch {
  waitForLines(target: number, budgetMs: number): Promise<"ok" | "timeout" | "eof">;
}

const watchStdout = (stream: ReadableStream<Uint8Array>): StdoutWatch => {
  const NEWLINE = 0x0a;
  let newlines = 0;
  let eof = false;
  const signal = { notify: null as (() => void) | null };
  void (async () => {
    for await (const part of stream) {
      for (const byte of part) if (byte === NEWLINE) newlines += 1;
      signal.notify?.();
    }
    eof = true;
    signal.notify?.();
  })();
  const POLL_MS = 100;
  return {
    async waitForLines(target, budgetMs) {
      const deadline = Date.now() + budgetMs;
      while (newlines < target && !eof && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          signal.notify = resolve;
          setTimeout(resolve, POLL_MS);
        });
        signal.notify = null;
      }
      if (newlines >= target) return "ok";
      return eof ? "eof" : "timeout";
    },
  };
};

const send = async (proxy: Proxy, text: string): Promise<void> => {
  proxy.stdin.write(new TextEncoder().encode(text));
  const flushed = proxy.stdin.flush();
  if (flushed instanceof Promise) await flushed;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const exitWithin = (proxy: Proxy, budgetMs: number): Promise<number | "timeout"> =>
  Promise.race([proxy.exited, sleep(budgetMs).then(() => "timeout" as const)]);

describe.skipIf(!isStarvedHost)("the proxy on a <= 2-CPU host (the wedge boundary)", () => {
  test(
    "stdin-eof: zero-byte EOF after the pumps parked still exits the proxy",
    async () => {
      // Arrange
      const proxy = await spawnProxyDirect([]);
      await sleep(PARK_SETTLE_MS);

      // Act: close our write end without ever sending a byte.
      proxy.stdin.end();
      const exit = await exitWithin(proxy, FIRST_REPLY_BUDGET_MS);

      // Assert: the wedge stayed alive forever, log frozen at "spawned".
      if (exit === "timeout") proxy.kill(9);
      expect(exit).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "step2: a reply crosses while stdin is STILL OPEN (not only on close)",
    async () => {
      // Arrange
      const proxy = await spawnProxyDirect([]);
      const watch = watchStdout(proxy.stdout);
      await sleep(PARK_SETTLE_MS);

      // Act + Assert, stepwise — stdin stays open through both steps; the
      // wedge surfaced replies only when stdin closed.
      await send(proxy, INITIALIZE);
      expect(await watch.waitForLines(1, FIRST_REPLY_BUDGET_MS)).toBe("ok");
      await send(proxy, SESSION_NEW);
      expect(await watch.waitForLines(2, REPLY_BUDGET_MS)).toBe("ok");

      // Teardown: an orderly EOF must still end the session.
      proxy.stdin.end();
      const exit = await exitWithin(proxy, EXIT_BUDGET_MS);
      if (exit === "timeout") proxy.kill(9);
      expect(exit).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "sleep-ready: an agent that speaks first gets its ready line across",
    async () => {
      // Arrange: fake-agent --sleep announces "ready\n" and then waits.
      const proxy = await spawnProxyDirect(["--sleep"]);
      const watch = watchStdout(proxy.stdout);

      // Act
      const ready = await watch.waitForLines(1, FIRST_REPLY_BUDGET_MS);

      // Assert: the wedge never delivered this line.
      proxy.kill();
      await proxy.exited;
      expect(ready).toBe("ok");
    },
    TEST_TIMEOUT_MS,
  );
});
