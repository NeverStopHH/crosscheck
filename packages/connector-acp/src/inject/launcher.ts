/**
 * The ACP mcpServers entry (design §2.5 write point 1): crosscheck's MCP
 * server as one session-setup array entry, launcher resolved through the
 * CORE durable-install rules (config/launcher.ts — the init.ts rules,
 * moved): PATH-installed `crosscheck` preferred, the running entry script's
 * absolute path as fallback, and an npx/bunx cache path REFUSES injection
 * (log + skip) rather than wiring a command that dies with the cache.
 *
 * Shape per the session-setup spec (verified 2026-08-18 in the design):
 * `{"name": "crosscheck", "command": "<abs launcher>", "args": […], "env": []}`
 * — `env` is the array-of-EnvVariable shape, empty on purpose (the server
 * reads its config from the developer's home, never from injected env).
 *
 * The `bare` launcher uses its RESOLVED absolute path rather than the bare
 * name init writes into `.mcp.json`: an ACP agent may spawn MCP servers
 * under a trimmed PATH, and an absolute path of a durable install is immune
 * to that while costing nothing.
 */
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { resolveLauncher, resolveMcpLauncher } from "@crosscheck/connector-core/config/launcher.ts";

import { MCP_SERVER_NAME } from "@crosscheck/connector-core/constants.ts";

/** The wire entry, per the ACP session-setup schema. */
export interface AcpMcpServerEntry {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: readonly never[];
}

export type AcpMcpServerResolution =
  | { readonly kind: "entry"; readonly entry: AcpMcpServerEntry }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Resolved ONCE per proxy, asynchronously, off the wire path. The injector
 * kicks this off at construction, and a session/new that arrives before it
 * settles AWAITS it under the shared ACP_SESSION_SETUP_INJECT_BUDGET_MS
 * deadline (injector.ts decideSetup) — an editor's first session lands
 * milliseconds after spawn and is exactly the one the tools are for. Only a
 * blown deadline skips (`launcher-pending`; fail open, logged).
 */
export const resolveAcpMcpServer = async (
  env: Env,
  entryPath: string,
): Promise<AcpMcpServerResolution> => {
  const launcher = await resolveLauncher(undefined, env, entryPath);
  if (launcher.kind === "refused") {
    return { kind: "refused", reason: launcher.reason };
  }
  // The bare install's RESOLVED path (header). Every other form is the one
  // init writes into `.mcp.json`, taken from the core rather than rebuilt
  // here: a hand-built `[runtime, entry, "mcp"]` in this file once dropped
  // the isolation flags, and the agent started the server in a bait repo
  // with that repo's bunfig preload (review round 2, N1). The `override`
  // form is unreachable in the proxy (no --command-prefix flag exists here).
  const mcp =
    launcher.kind === "bare"
      ? { command: launcher.path, args: ["mcp"] }
      : resolveMcpLauncher(launcher);
  return {
    kind: "entry",
    entry: { name: MCP_SERVER_NAME, command: mcp.command, args: mcp.args, env: [] },
  };
};
