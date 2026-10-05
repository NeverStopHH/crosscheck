/**
 * The Cursor half of `crosscheck init --cursor` (design §3.4), split into
 * PREPARE and APPLY so the composed init keeps its all-or-nothing promise:
 * the Claude installer validates EVERY file it will touch — its own two and
 * these two — before writing ANY, because a half-installed repo (Claude
 * hooks registered, Cursor's not, or vice versa) is the state doctor has
 * the hardest time explaining.
 *
 * Both files are repo-committed (install = the same one PR as the Claude
 * connector; Cursor hot-reloads them in trusted workspaces, no restart
 * step). The rejected alternative — rules files — and the gitignore
 * interplay that killed it live in this package's README.
 */
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

import { ensureDir, readTextOrNull } from "@crosscheck/connector-core/config/paths.ts";
import { mergeMcpConfig } from "@crosscheck/connector-core/config/mcp-config.ts";
import type { McpServerEntry } from "@crosscheck/connector-core/config/mcp-config.ts";

import { CURSOR_DIR, CURSOR_HOOKS_FILE, CURSOR_MCP_FILE } from "../constants.ts";
import { buildCursorHooksPlan, mergeCursorHooks } from "./hooks-merge.ts";

/**
 * Saves a file's original before it is rewritten, and says where — or null
 * when it saved nothing. The CALLER owns the policy and the place (cli's
 * `saveProjectOriginal`: only an original the rewrite changes, and never
 * beside the file — a `.bak` in the work tree is a new file git offers to
 * commit, review 2026-10-05); this package only hands it the facts.
 */
export type SaveOriginal = (
  path: string,
  raw: string | null,
  next: string,
) => Promise<string | null>;

export interface CursorWrite {
  readonly path: string;
  /** Where the original was saved; null = there was nothing to save. */
  readonly backup: string | null;
}

export type CursorInitPlan =
  | { readonly ok: false; readonly reason: string }
  | {
      readonly ok: true;
      /** Writes both files, each original handed to the saver first. */
      readonly apply: () => Promise<readonly CursorWrite[]>;
    };

interface ReadJson {
  readonly value: Record<string, unknown>;
  readonly raw: string | null;
}

/**
 * A JSON config init is going to rewrite, or null when it refuses — the
 * Claude installer's rule, same reason: a file that cannot be parsed is a
 * file whose contents cannot be preserved, and overwriting it would silently
 * delete a teammate's configuration.
 */
const readJsonConfig = async (path: string): Promise<ReadJson | null> => {
  const raw = await readTextOrNull(path);
  if (raw === null) {
    return { value: {}, raw: null };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return {
      value:
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {},
      raw,
    };
  } catch {
    return null;
  }
};

const renderJson = (value: Record<string, unknown>): string =>
  `${JSON.stringify(value, null, 2)}\n`;

/**
 * Validates `.cursor/hooks.json` + `.cursor/mcp.json` and hands back the
 * deferred write. `commandPrefix` is the launcher the composed init already
 * resolved under the durable-install rules (core config/launcher.ts — cache
 * paths refused there, not re-checked here); `mcpEntry` is the same entry
 * shape `.mcp.json` gets (core resolveMcpLauncher); `saveOriginal` receives
 * every original before its file is rewritten.
 */
export const prepareCursorInit = async (
  repoRoot: string,
  commandPrefix: string,
  mcpEntry: McpServerEntry,
  saveOriginal: SaveOriginal,
): Promise<CursorInitPlan> => {
  const cursorDir = join(repoRoot, CURSOR_DIR);
  const hooksPath = join(cursorDir, CURSOR_HOOKS_FILE);
  const mcpPath = join(cursorDir, CURSOR_MCP_FILE);

  const hooksRead = await readJsonConfig(hooksPath);
  if (hooksRead === null) {
    return {
      ok: false,
      reason: `${hooksPath} is not valid json — nothing was changed`,
    };
  }
  const mcpRead = await readJsonConfig(mcpPath);
  if (mcpRead === null) {
    return {
      ok: false,
      reason: `${mcpPath} is not valid json — nothing was changed`,
    };
  }

  return {
    ok: true,
    apply: async (): Promise<readonly CursorWrite[]> => {
      const hooksNext = renderJson(
        mergeCursorHooks(hooksRead.value, buildCursorHooksPlan(commandPrefix)),
      );
      const mcpNext = renderJson(mergeMcpConfig(mcpRead.value, mcpEntry));
      // Both originals are saved before EITHER file is written.
      const hooksBackup = await saveOriginal(hooksPath, hooksRead.raw, hooksNext);
      const mcpBackup = await saveOriginal(mcpPath, mcpRead.raw, mcpNext);
      await ensureDir(cursorDir);
      await writeFile(hooksPath, hooksNext, "utf8");
      await writeFile(mcpPath, mcpNext, "utf8");
      return [
        { path: hooksPath, backup: hooksBackup },
        { path: mcpPath, backup: mcpBackup },
      ];
    },
  };
};
