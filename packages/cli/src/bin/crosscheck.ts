#!/usr/bin/env bun
import { EXIT_FAIL, EXIT_OK, EXIT_USAGE, STDIN_TIMEOUT_MS } from "@crosscheck/connector-core/constants.ts";
import {
  isHookName,
  runHook,
  runStatusline,
  runSummarizeWorker,
} from "@crosscheck/connector-claude";
import { runMcpServer } from "@crosscheck/connector-core/mcp/server.ts";
import { runCli } from "../cli/index.ts";

/**
 * Bounded: this read runs before the hook budget exists, so an stdin the caller
 * never closes must expire here instead of holding the session open.
 */
const readStdin = async (): Promise<string> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(""), STDIN_TIMEOUT_MS);
  });
  try {
    return await Promise.race([Bun.stdin.text().catch(() => ""), expiry]);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
};

/** Hooks and the statusline must never fail the developer's session: exit 0. */
const emitAndExit = (text: string, exitCode: number): never => {
  if (text.length > 0) {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }
  process.exit(exitCode);
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv;

  if (command === "hook") {
    const name = rest[0];
    if (name === undefined || !isHookName(name)) {
      process.exit(EXIT_OK);
    }
    emitAndExit(await runHook(name, await readStdin(), process.env), EXIT_OK);
  }

  if (command === "statusline") {
    emitAndExit(await runStatusline(await readStdin(), process.env), EXIT_OK);
  }

  // The detached Tier-1 summarizer worker (summarizer/worker.ts): spawned by
  // the Stop hook, never by a person. No stdin read — its input is named by
  // flags — and exit 0 always, because nothing downstream reads the code.
  if (command === "summarize-turn") {
    process.exit(await runSummarizeWorker(rest, process.env));
  }

  // NOT through `readStdin`, and that is the whole difference from the two
  // branches above. Those read one payload under STDIN_TIMEOUT_MS, because a
  // hook that blocks on an unclosed stdin holds the developer's session open.
  // An MCP server's stdin stays open for the life of the session BY DESIGN —
  // that is the transport — so the bounded read would end it after one second.
  if (command === "mcp") {
    process.exit(await runMcpServer(process.env, process.cwd()));
  }

  // Cursor IDE hooks (packages/connector-cursor; fronted from packages/cli
  // since Block 8 ended the §1.2 named debt). DYNAMIC import — Claude hooks and
  // the statusline must not pay its load. Reads ONE payload under
  // STDIN_TIMEOUT_MS exactly like `hook`: a cursor hook that blocks on an
  // unclosed stdin holds the developer's session open. UNLIKE `acp`, every
  // failure here — unknown event, import crash — exits 0: Cursor reads
  // non-zero exits as hook failures worth logging (exit 2 even BLOCKS the
  // action), and this connector is never allowed to be either.
  if (command === "cursor-hook") {
    try {
      const { isCursorHookEvent, runCursorHook, CURSOR_NO_OP_OUTPUT } =
        await import("@crosscheck/connector-cursor");
      const event = rest[0];
      if (event === undefined || !isCursorHookEvent(event)) {
        process.stdout.write(`${CURSOR_NO_OP_OUTPUT}\n`);
        process.exit(EXIT_OK);
      }
      emitAndExit(
        await runCursorHook(event, await readStdin(), process.env),
        EXIT_OK,
      );
    } catch {
      // Hardcoded, not CURSOR_NO_OP_OUTPUT: the usual way here is the
      // dynamic import itself crashing, in which case the constant never
      // loaded — and exit 0 with EMPTY stdout would violate the package's
      // own "always parseable JSON" rule (connector-cursor/src/constants.ts).
      process.stdout.write("{}\n");
      process.exit(EXIT_OK);
    }
  }

  // The ACP transparent proxy (packages/connector-acp; fronted from
  // packages/cli since Block 8 ended design §1.2's named debt).
  // DYNAMIC import like `serve`: hooks and the statusline must not pay its
  // load. NOT through `readStdin` either — stdin IS the client half of the
  // wire the proxy forwards, open for the life of the session BY DESIGN.
  // Its own catch, like `serve` below: main()'s silent usage-exit catch is
  // for HOOKS. The proxy contains its own post-spawn failures already
  // (proxy.ts); this net is for what runs before that containment exists —
  // an import failure, a logger-construction crash — which must still be
  // LOUD and EXIT_FAIL, never a silent 64 with an agent left running.
  if (command === "acp") {
    try {
      const { runAcpProxy } = await import("@crosscheck/connector-acp");
      process.exit(await runAcpProxy(rest, process.env));
    } catch (error) {
      console.error(
        `crosscheck acp: internal proxy failure (${error instanceof Error ? error.message : String(error)})`,
      );
      process.exit(EXIT_FAIL);
    }
  }

  // DYNAMIC import, and only here: the hub pulls in hono, drizzle and the
  // PGlite WASM runtime, none of which a hook or the statusline may pay for —
  // those run inside a session-latency budget on every invocation. After
  // startServer resolves, Bun.serve keeps the process alive; no exit call.
  //
  // Its own catch, because main()'s silent-exit catch is for HOOKS, where any
  // output would corrupt the session. An operator whose hub refuses to boot —
  // bad PORT, a data dir another PostgreSQL major wrote — needs the reason.
  if (command === "serve") {
    try {
      const { startServer } = await import("@crosscheck/server");
      await startServer();
      return;
    } catch (error) {
      console.error(
        `crosscheck serve failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(EXIT_FAIL);
    }
  }

  const result = await runCli(argv, process.env, process.cwd());
  process.stdout.write(result.stdout);
  process.exit(result.exitCode);
};

await main().catch(() => {
  process.exit(EXIT_USAGE);
});
