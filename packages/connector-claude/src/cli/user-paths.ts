/**
 * Where Claude Code keeps its USER-scope configuration — the two files
 * `crosscheck init --global` (finding #11) merges into:
 *
 *   - `~/.claude/settings.json`: user settings; hooks and the statusline.
 *     Hook entries MERGE across settings levels (project entries never
 *     replace user ones), and an identical handler defined in more than one
 *     settings file runs once — code.claude.com/docs/en/hooks, "Hooks from
 *     settings files".
 *   - `~/.claude.json`: Claude Code's own state file, which is ALSO where
 *     user-scope MCP servers live (top-level `mcpServers`) — the same
 *     location `claude mcp add --scope user` writes;
 *     code.claude.com/docs/en/mcp, "MCP installation scopes". Scope
 *     precedence is local > project > user with connect-once semantics, so
 *     a project `.mcp.json` entry wins over ours where both exist.
 *
 * `CLAUDE_CONFIG_DIR` relocates both (Claude Code's own convention: the
 * settings directory becomes that path, and `.claude.json` moves inside
 * it). `HOME` comes from the passed env first so tests sandbox without
 * touching the real account, exactly as doctor's bunfig scan resolves it.
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { CLAUDE_SETTINGS_FILE } from "@crosscheck/connector-core/constants.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";

const USER_CLAUDE_DIR_NAME = ".claude";
const USER_MCP_FILE_NAME = ".claude.json";

/** The user-scope settings directory (`~/.claude` or CLAUDE_CONFIG_DIR). */
export const claudeUserDir = (env: Env): string =>
  env["CLAUDE_CONFIG_DIR"] ??
  join(env["HOME"] ?? homedir(), USER_CLAUDE_DIR_NAME);

export const claudeUserSettingsPath = (env: Env): string =>
  join(claudeUserDir(env), CLAUDE_SETTINGS_FILE);

/** `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json` when relocated. */
export const claudeUserMcpPath = (env: Env): string =>
  env["CLAUDE_CONFIG_DIR"] === undefined
    ? join(env["HOME"] ?? homedir(), USER_MCP_FILE_NAME)
    : join(env["CLAUDE_CONFIG_DIR"], USER_MCP_FILE_NAME);
