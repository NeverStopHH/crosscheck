/**
 * The absolute paths the live driver runs THIS worktree's source from — never a
 * globally installed `crosscheck`. The hub, the `login`/`init` installs and the
 * `--command-prefix` the fixture's hooks and MCP server use all resolve through
 * here, so a run can never silently exercise a different build.
 *
 * `import.meta.dir` is `<worktree>/packages/connector-claude/bench/at7`, so the
 * worktree root is four levels up, and the CLI entry is the bin this repo ships.
 */
import { symlink } from "node:fs/promises";
import { join, resolve } from "node:path";

/** `<worktree>` — the root of the crosscheck checkout this harness lives in. */
export const worktreeRoot = (): string =>
  resolve(import.meta.dir, "..", "..", "..", "..");

/** The CLI entry point under a checkout root (default: this worktree). */
export const crosscheckBinPath = (root: string = worktreeRoot()): string =>
  resolve(root, "packages", "cli", "src", "bin", "crosscheck.ts");

/** The runtime that runs it — the same Bun executing this harness. */
export const runtimePath = (): string => process.execPath;

/**
 * The hook/MCP launcher prefix `crosscheck init --command-prefix` writes, so
 * every hook and the MCP server run `<bun> <bin> …` from `root`. Shell
 * quoting is unnecessary here: both paths are plain (no spaces), and init's
 * override branch passes the string through to `sh -c`.
 */
export const commandPrefix = (root: string = worktreeRoot()): string =>
  `${runtimePath()} ${crosscheckBinPath(root)}`;

/** The neutral name the checkout is linked under inside a work root (A2.4). */
export const TOOL_LINK_NAME = "crosscheck";

/**
 * Links this worktree into the attempt's work root as `crosscheck` and returns
 * the link (A2.4). init writes the command prefix into `.mcp.json` and
 * `.claude/settings.json` inside the fixture, both readable by the agent, and
 * the checkout's own directory name (e.g. `crosscheck-at7`) would ride along.
 * Through the link the hooks and the MCP server still run THIS worktree's
 * source; only the spelling of the path changes.
 */
export const linkToolRoot = async (workRoot: string): Promise<string> => {
  const link = join(workRoot, TOOL_LINK_NAME);
  await symlink(worktreeRoot(), link, "dir");
  return link;
};
