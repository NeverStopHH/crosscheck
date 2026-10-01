/**
 * The absolute paths the live driver runs THIS worktree's source from — never a
 * globally installed `crosscheck`. The hub, the `login`/`init` installs and the
 * `--command-prefix` the fixture's hooks and MCP server use all resolve through
 * here, so a run can never silently exercise a different build.
 *
 * `import.meta.dir` is `<worktree>/packages/connector-claude/bench/at7`, so the
 * worktree root is four levels up, and the CLI entry is the bin this repo ships.
 */
import { resolve } from "node:path";

/** `<worktree>` — the root of the crosscheck checkout this harness lives in. */
export const worktreeRoot = (): string =>
  resolve(import.meta.dir, "..", "..", "..", "..");

/** The CLI entry point: `<worktree>/packages/cli/src/bin/crosscheck.ts`. */
export const crosscheckBinPath = (): string =>
  resolve(worktreeRoot(), "packages", "cli", "src", "bin", "crosscheck.ts");

/** The runtime that runs it — the same Bun executing this harness. */
export const runtimePath = (): string => process.execPath;

/**
 * The hook/MCP launcher prefix `crosscheck init --command-prefix` writes, so
 * every hook and the MCP server run `<bun> <bin> …` from this worktree. Shell
 * quoting is unnecessary here: both paths are plain (no spaces) under the
 * worktree, and init's override branch passes the string through to `sh -c`.
 */
export const commandPrefix = (): string =>
  `${runtimePath()} ${crosscheckBinPath()}`;
