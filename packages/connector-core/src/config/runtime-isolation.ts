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
 * Every self-spawn goes through `selfSpawnCmd`, and the launcher writes the
 * same two flags into hook commands and MCP entries (config/launcher.ts).
 * The npm shim (packaging/bin/crosscheck.cjs) passes them too, naming this
 * file by its path inside the package.
 *
 * VERIFY: grep -rnE "cmd: \[process\.execPath|^[[:space:]]*process\.execPath,$" packages/connector-claude/src packages/connector-cursor/src packages/connector-acp/src packages/connector-core/src | grep -v runtime-isolation.ts | wc -l | tr -d ' '
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

/** The argv that starts one of crosscheck's own entries under the running bun, isolated. */
export const selfSpawnCmd = (entry: string, args: readonly string[] = []): readonly string[] => [
  process.execPath,
  ...RUNTIME_ISOLATION_FLAGS,
  entry,
  ...args,
];
