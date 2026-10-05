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

import { ensureDir, readText } from "@crosscheck/connector-core/config/paths.ts";
import { mergeMcpConfig } from "@crosscheck/connector-core/config/mcp-config.ts";
import type { McpServerEntry } from "@crosscheck/connector-core/config/mcp-config.ts";

import { CURSOR_DIR, CURSOR_HOOKS_FILE, CURSOR_MCP_FILE } from "../constants.ts";
import { buildCursorHooksPlan, mergeCursorHooks } from "./hooks-merge.ts";

/**
 * One file the plan will write: its original (null = none) and its new
 * content. Handed to the CALLER, which saves every original — the Claude
 * pair's and these — before ANY file is written, out of the work tree (cli's
 * `saveProjectOriginals`; a `.bak` beside the file is a new file git offers
 * to commit, and a save failing after the Claude writes left a
 * half-installed repo — review 2026-10-05).
 */
export interface CursorFile {
  readonly path: string;
  readonly raw: string | null;
  readonly next: string;
}

export type CursorInitPlan =
  | { readonly ok: false; readonly reason: string }
  | {
      readonly ok: true;
      readonly files: readonly CursorFile[];
      /** Writes `files`; their originals are the caller's to have saved first. */
      readonly apply: () => Promise<void>;
    };

interface ReadJson {
  readonly value: Record<string, unknown>;
  readonly raw: string | null;
}

/**
 * A JSON config init is going to rewrite, or the clause saying why it
 * refuses — the Claude installer's rule, same reason: a file that cannot be
 * read or parsed is a file whose contents cannot be preserved, and
 * overwriting it would silently delete a teammate's configuration. An
 * unreadable file is NOT an absent one (review 2026-10-05: it read as absent,
 * so the Claude files and .crosscheck.json were written and the Cursor write
 * failed with EACCES after them).
 */
const readJsonConfig = async (path: string): Promise<ReadJson | string> => {
  const read = await readText(path);
  if (read.kind === "absent") {
    return { value: {}, raw: null };
  }
  if (read.kind === "unreadable") {
    return "could not be read";
  }
  try {
    const parsed = JSON.parse(read.text) as unknown;
    return {
      value:
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {},
      raw: read.text,
    };
  } catch {
    return "is not valid json";
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
  if (typeof hooksRead === "string") {
    return { ok: false, reason: `${hooksPath} ${hooksRead} — nothing was changed` };
  }
  const mcpRead = await readJsonConfig(mcpPath);
  if (typeof mcpRead === "string") {
    return { ok: false, reason: `${mcpPath} ${mcpRead} — nothing was changed` };
  }

  const files: readonly CursorFile[] = [
    {
      path: hooksPath,
      raw: hooksRead.raw,
      next: renderJson(mergeCursorHooks(hooksRead.value, buildCursorHooksPlan(commandPrefix))),
    },
    { path: mcpPath, raw: mcpRead.raw, next: renderJson(mergeMcpConfig(mcpRead.value, mcpEntry)) },
  ];
  return {
    ok: true,
    files,
    apply: async (): Promise<void> => {
      await ensureDir(cursorDir);
      for (const file of files) {
        await writeFile(file.path, file.next, "utf8");
      }
    },
  };
};
