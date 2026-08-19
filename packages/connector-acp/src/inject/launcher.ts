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
import { resolveLauncher } from "@crosscheck/connector-core/config/launcher.ts";

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
 * Resolved ONCE per proxy, asynchronously, off the wire path (the injector
 * kicks this off at construction; a session/new that arrives before it
 * settles skips injection — fail open, logged).
 */
export const resolveAcpMcpServer = async (
  env: Env,
  entryPath: string,
): Promise<AcpMcpServerResolution> => {
  const launcher = await resolveLauncher(undefined, env, entryPath);
  switch (launcher.kind) {
    case "refused":
      return { kind: "refused", reason: launcher.reason };
    case "override":
      // Unreachable in the proxy (no --command-prefix flag exists here), but
      // the type demands honesty: pass the operator's word through as sh -c.
      return {
        kind: "entry",
        entry: {
          name: MCP_SERVER_NAME,
          command: "sh",
          args: ["-c", `${launcher.prefix} mcp`],
          env: [],
        },
      };
    case "bare":
      return {
        kind: "entry",
        entry: {
          name: MCP_SERVER_NAME,
          command: launcher.path,
          args: ["mcp"],
          env: [],
        },
      };
    case "entry":
      return {
        kind: "entry",
        entry: {
          name: MCP_SERVER_NAME,
          command: launcher.runtime,
          args: [launcher.entry, "mcp"],
          env: [],
        },
      };
  }
};
