/**
 * Which SCOPE a wiring file belongs to — a repo's project copy or the
 * machine's user-level install — decided by where its path really leads, not
 * by how it is spelled (review 2026-10-05, HIGH).
 *
 * A dotfiles user's $HOME is itself a git work tree. A command run in a folder
 * with no repo of its own then resolves the repo root to $HOME, and "this
 * repo's .claude/settings.json" IS ~/.claude/settings.json: `init --remove`
 * stripped the user-level install doctor had just said to keep, and `init`
 * wrote a project copy into it. A project file symlinked into ~/.claude or
 * ~/.cursor is the same file by another name. Both commands ask
 * `findUserLevelCollision` before they touch anything, and refuse.
 */
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  CLAUDE_SETTINGS_DIR,
  CLAUDE_SETTINGS_FILE,
  MCP_CONFIG_FILE,
} from "@crosscheck/connector-core/constants.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { claudeUserMcpPath, claudeUserSettingsPath } from "@crosscheck/connector-claude";
import { wiringPaths } from "./wiring-removal.ts";
import type { WiringFiles } from "./wiring-removal.ts";

/** Cursor's user-level configuration directory (cursor.com/docs/agent/hooks). */
export const userCursorDir = (env: Env): string =>
  join(env["HOME"] ?? homedir(), ".cursor");

/** The four user-level wiring files `init --global` writes. */
export const userWiringFiles = (env: Env): WiringFiles => ({
  claudeSettingsPath: claudeUserSettingsPath(env),
  mcpPath: claudeUserMcpPath(env),
  cursorDir: userCursorDir(env),
});

/** A repo's project copy: the Claude pair, and the Cursor pair when asked. */
export const projectWiringFiles = async (
  root: string,
  cursor: boolean,
): Promise<WiringFiles> => ({
  claudeSettingsPath: join(root, CLAUDE_SETTINGS_DIR, CLAUDE_SETTINGS_FILE),
  mcpPath: join(root, MCP_CONFIG_FILE),
  // DYNAMIC like every Cursor branch of init: hooks and the statusline must
  // not pay connector-cursor's load.
  cursorDir: cursor
    ? join(root, (await import("@crosscheck/connector-cursor")).CURSOR_DIR)
    : null,
});

/**
 * The path with every component that exists resolved, symlinks included; a
 * missing tail is appended to its nearest existing ancestor — so a file not
 * written yet still compares equal to the one it WOULD be.
 */
const canonicalPath = async (path: string): Promise<string> => {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(await canonicalPath(parent), basename(path));
  }
};

export interface ScopeCollision {
  /** The project path as the command spelled it. */
  readonly projectPath: string;
  /** The user-level file it really is. */
  readonly userPath: string;
}

/** The first project path that IS a user-level wiring file, or null. */
export const findUserLevelCollision = async (
  projectPaths: readonly string[],
  env: Env,
): Promise<ScopeCollision | null> => {
  const userPaths = await wiringPaths(userWiringFiles(env));
  const userCanonical = await Promise.all(userPaths.map(canonicalPath));
  const projectCanonical = await Promise.all(projectPaths.map(canonicalPath));
  const index = projectCanonical.findIndex((path) => userCanonical.includes(path));
  if (index === -1) {
    return null;
  }
  const projectPath = projectPaths[index] ?? "";
  const userPath = userPaths[userCanonical.indexOf(projectCanonical[index] ?? "")] ?? projectPath;
  return { projectPath, userPath };
};

/** The refusal's shared half: which file, and that nothing changed. */
export const collisionSentence = (collision: ScopeCollision, root: string): string =>
  `${collision.projectPath} is your user-level wiring (${collision.userPath}), not a project copy — the git repo here is ${root} — so nothing was changed`;
