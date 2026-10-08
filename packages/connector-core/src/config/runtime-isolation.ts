/**
 * EVERY CROSSCHECK PROCESS STARTS ISOLATED FROM THE REPO IT RUNS IN
 * (security review of the key-origin binding, C1 and H1).
 *
 * Claude Code, Cursor and the ACP host start crosscheck's hooks, statusline
 * and MCP server with the project directory as cwd, and the detached workers
 * inherit it. Bun reads two things from its cwd before any line of ours runs:
 *
 * - `bunfig.toml`, whose `preload` executes the repo's own code inside the
 *   process that holds the developer's api key and can read config.json —
 *   at SessionStart, in any cloned or forked repo, with no prompt;
 * - `.env`, `.env.local` and `.env.<NODE_ENV>`, which land in `process.env`
 *   and from there in `loadConfig`: a repo-shipped `CROSSCHECK_HUB_URL` turned
 *   an exported `CROSSCHECK_API_KEY` into a pair bound to the repo's hub, an
 *   `HTTP_PROXY` received the bearer of a plain-http hub, and
 *   `CROSSCHECK_DISABLED` / `CROSSCHECK_HOME` silenced or redirected capture.
 *
 * So every crosscheck process is started as
 * `bun --no-env-file --config=<isolated.bunfig.toml> <entry> …`: the first
 * flag stops every `.env*` load, the second names crosscheck's own (empty)
 * bunfig, so no repo's is read. Both were measured on Bun 1.3.13 against a
 * bait repo carrying both files; a value in the developer's own environment
 * still wins, which is the point — the developer's shell is theirs, a repo's
 * files are not.
 *
 * THIS FILE IS THE ONLY PLACE THAT NAMES THE RUNNING BUN. Every self-spawn
 * takes its argv from `selfSpawnCmd`, and the launcher's absolute form is a
 * `selfLaunch` (config/launcher.ts), from which the hook prefix, the
 * `.mcp.json` entry and the ACP-injected MCP entry are all derived. A start
 * that does not come from here cannot name the runtime at all. Round 2 of the
 * review found a hand-built `[runtime, entry, "mcp"]` in the ACP injector
 * that a lexical grep for two spellings could not see, so the guard is now
 * structural: no shipped source except this file mentions the runtime's path
 * (packages/connector-core/test/runtime-isolation.test.ts walks every
 * package's src for it). The npm shim (packaging/bin/crosscheck.cjs) passes
 * the same flags, naming this bunfig by its path inside the package.
 *
 * VERIFY: grep -rlE "execPath|argv0" packages --exclude-dir=node_modules | grep -E "^packages/[^/]+/src/" | grep -v "/runtime-isolation.ts$" | wc -l | tr -d ' '
 * PRINTS: 0
 */
import { resolve } from "node:path";

/** crosscheck's own, empty bunfig — inside the package, so it ships wherever the sources do. */
export const ISOLATED_BUNFIG_PATH = resolve(import.meta.dir, "isolated.bunfig.toml");

export const NO_ENV_FILE_FLAG = "--no-env-file";

/** The two flags that keep a repo's bunfig and .env out of a crosscheck process. */
export const RUNTIME_ISOLATION_FLAGS: readonly string[] = [
  NO_ENV_FILE_FLAG,
  `--config=${ISOLATED_BUNFIG_PATH}`,
];

/** A start of one of crosscheck's own entries, as a command and its leading args. */
export interface SelfLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

/** The running bun, the isolation flags, then the entry: the only shape a self-start takes. */
export const selfLaunch = (entry: string): SelfLaunch => ({
  command: process.execPath,
  args: [...RUNTIME_ISOLATION_FLAGS, entry],
});

/** The argv that starts one of crosscheck's own entries under the running bun, isolated. */
export const selfSpawnCmd = (entry: string, args: readonly string[] = []): readonly string[] => {
  const launch = selfLaunch(entry);
  return [launch.command, ...launch.args, ...args];
};

/**
 * The one start that is deliberately NOT isolated: `crosscheck ci-report`
 * re-runs the repo's own failing tests in CI, and those must see the repo's
 * bunfig (its preload sets the tests up) exactly as the primary run did. It
 * starts no crosscheck entry, so nothing of crosscheck's runs under the repo's
 * bunfig, and it uses the running bun rather than whichever is first on PATH.
 */
export const repoTestRunCmd = (args: readonly string[]): readonly string[] => [process.execPath, ...args];
