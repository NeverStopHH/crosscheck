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

export type CursorInitPlan =
  | { readonly ok: false; readonly reason: string }
  | {
      readonly ok: true;
      /** Writes both files (+ timestamped backups); returns written paths. */
      readonly apply: () => Promise<readonly string[]>;
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

/** Timestamped backup beside the original, so a bad merge is recoverable. */
const backUp = async (path: string, raw: string | null): Promise<void> => {
  if (raw !== null) {
    await writeFile(`${path}.bak-${String(Date.now())}`, raw, "utf8");
  }
};

const renderJson = (value: Record<string, unknown>): string =>
  `${JSON.stringify(value, null, 2)}\n`;

/**
 * Validates `.cursor/hooks.json` + `.cursor/mcp.json` and hands back the
 * deferred write. `commandPrefix` is the launcher the composed init already
 * resolved under the durable-install rules (core config/launcher.ts — cache
 * paths refused there, not re-checked here); `mcpEntry` is the same entry
 * shape `.mcp.json` gets (core resolveMcpLauncher).
 */
export const prepareCursorInit = async (
  repoRoot: string,
  commandPrefix: string,
  mcpEntry: McpServerEntry,
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
    apply: async (): Promise<readonly string[]> => {
      await ensureDir(cursorDir);
      await backUp(hooksPath, hooksRead.raw);
      await backUp(mcpPath, mcpRead.raw);
      await writeFile(
        hooksPath,
        renderJson(
          mergeCursorHooks(hooksRead.value, buildCursorHooksPlan(commandPrefix)),
        ),
        "utf8",
      );
      await writeFile(
        mcpPath,
        renderJson(mergeMcpConfig(mcpRead.value, mcpEntry)),
        "utf8",
      );
      return [hooksPath, mcpPath];
    },
  };
};
