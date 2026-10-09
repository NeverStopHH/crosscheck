/**
 * WHAT A HOST HANDS CROSSCHECK'S PROCESSES AS ENVIRONMENT (review round 2, N2).
 *
 * crosscheck starts bun isolated from a repo's bunfig and .env
 * (connector-core config/runtime-isolation.ts). A host can still pass an
 * environment of its own:
 * - an MCP server entry's `env` block. Claude Code (`.mcp.json`,
 *   `~/.claude.json`) and Cursor (`.cursor/mcp.json`) give it to the server
 *   process. Probed: with `HTTP_PROXY` there, the bearer for a plain-http hub
 *   reached the proxy; with `BUN_OPTIONS`, a repo preload ran. crosscheck never
 *   writes an `env` block, so every key in one is named, and doctor runs no
 *   entry that has one (doctor.ts `mcpProbeTarget`).
 * - `.claude/settings.json` and `settings.local.json` `env`, which Claude Code
 *   applies to its session. Whether it reaches hook processes is not
 *   documented and NOT VERIFIED here, so doctor names the keys there that
 *   would steer crosscheck and leaves the judgement to the person.
 * Only key NAMES are printed: a value is a repo's text and may be a
 * credential. Nothing found prints nothing.
 */
import { join } from "node:path";

import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { readJsonOrNull } from "@crosscheck/connector-core/config/paths.ts";
import { isRuntimeInjectionKey } from "@crosscheck/connector-core/config/runtime-isolation.ts";
import { MCP_CONFIG_FILE, MCP_SERVER_KEY } from "@crosscheck/connector-core/constants.ts";
import { claudeUserMcpPath } from "@crosscheck/connector-claude";

import type { Check } from "./doctor.ts";
import { STEERING_KEY_PATTERN } from "./doctor-repo-runtime.ts";

const MAX_NAMED_KEYS = 6;
const CURSOR_MCP_FILE = join(".cursor", "mcp.json");
const CLAUDE_SETTINGS_FILES = [join(".claude", "settings.json"), join(".claude", "settings.local.json")] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The variable names an MCP server entry's `env` carries: an object's keys
 * (Claude Code, Cursor) or the `name` of each `{name, value}` (ACP's shape).
 */
export const mcpEntryEnvKeys = (entry: unknown): readonly string[] => {
  const env = isRecord(entry) ? entry["env"] : undefined;
  if (Array.isArray(env)) {
    return env.flatMap((item) => (isRecord(item) && typeof item["name"] === "string" ? [item["name"]] : []));
  }
  return isRecord(env) ? Object.keys(env) : [];
};

const named = (keys: readonly string[]): string => {
  const shown = keys.slice(0, MAX_NAMED_KEYS).join(", ");
  return keys.length > MAX_NAMED_KEYS ? `${shown} (+${String(keys.length - MAX_NAMED_KEYS)} more)` : shown;
};

const crosscheckEntryIn = async (path: string): Promise<unknown> => {
  const json = await readJsonOrNull(path);
  const servers = isRecord(json) ? json["mcpServers"] : undefined;
  return isRecord(servers) ? servers[MCP_SERVER_KEY] : undefined;
};

/** Would this name steer crosscheck or configure its runtime? */
const steers = (name: string): boolean => STEERING_KEY_PATTERN.test(name) || isRuntimeInjectionKey(name);

/** Empty when no host-supplied environment reaches crosscheck. */
export const hostEnvChecks = async (repoRoot: string | null, env: Env): Promise<readonly Check[]> => {
  const entryFiles = [
    ...(repoRoot === null ? [] : [join(repoRoot, MCP_CONFIG_FILE), join(repoRoot, CURSOR_MCP_FILE)]),
    claudeUserMcpPath(env),
  ];
  const entryFindings = await Promise.all(
    entryFiles.map(async (path): Promise<string | null> => {
      const keys = mcpEntryEnvKeys(await crosscheckEntryIn(path));
      return keys.length === 0 ? null : `the crosscheck entry in ${path} passes ${named(keys)} to the server`;
    }),
  );
  const settingsFindings = await Promise.all(
    (repoRoot === null ? [] : CLAUDE_SETTINGS_FILES.map((file) => join(repoRoot, file))).map(
      async (path): Promise<string | null> => {
        const json = await readJsonOrNull(path);
        const block = isRecord(json) ? json["env"] : undefined;
        const keys = isRecord(block) ? Object.keys(block).filter(steers) : [];
        return keys.length === 0 ? null : `${path} sets ${named(keys)} for the session`;
      },
    ),
  );
  const findings = [...entryFindings, ...settingsFindings].filter((finding): finding is string => finding !== null);
  if (findings.length === 0) {
    return [];
  }
  return [
    {
      level: "WARN",
      name: "host-supplied env",
      detail:
        `${findings.join("; ")}. crosscheck writes no env block, and the host hands these to crosscheck's ` +
        "processes, where they can choose its hub, key or proxy, or configure bun itself — doctor did not " +
        "start that entry. If you did not add them, remove them (whether a settings env reaches hooks is not verified)",
    },
  ];
};
