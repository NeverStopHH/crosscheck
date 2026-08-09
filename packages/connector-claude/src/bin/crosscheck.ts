#!/usr/bin/env bun
import { EXIT_OK, EXIT_USAGE, STDIN_TIMEOUT_MS } from "../constants.ts";
import { runCli } from "../cli/index.ts";
import { isHookName, runHook } from "../hooks/index.ts";
import { runMcpServer } from "../mcp/server.ts";
import { runStatusline } from "../statusline/statusline.ts";

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

  // NOT through `readStdin`, and that is the whole difference from the two
  // branches above. Those read one payload under STDIN_TIMEOUT_MS, because a
  // hook that blocks on an unclosed stdin holds the developer's session open.
  // An MCP server's stdin stays open for the life of the session BY DESIGN —
  // that is the transport — so the bounded read would end it after one second.
  if (command === "mcp") {
    process.exit(await runMcpServer(process.env, process.cwd()));
  }

  const result = await runCli(argv, process.env, process.cwd());
  process.stdout.write(result.stdout);
  process.exit(result.exitCode);
};

await main().catch(() => {
  process.exit(EXIT_USAGE);
});
