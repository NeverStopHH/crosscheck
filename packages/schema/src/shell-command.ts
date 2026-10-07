/**
 * A BARE SHELL COMMAND is the developer running a tool, not naming a task
 * (DESIGN.md §4; hold-out review round 5, M3): "bun test", "npm run build",
 * "git log -5", "bun test packages/api/src/auth". A binary the developer
 * types every hour, then nothing but flags, paths and the session's own
 * operation words — "bun test" reached the CI-cache tree on "bun" and
 * "test". A command FOLLOWED BY A TASK is a task: "npm run build fails with
 * ENOENT on the icons dir" says what broke.
 *
 * HERE, IN THE SHARED SCHEMA, beside slash-command.ts, so the connector (which
 * then never asks) and the hub (which refuses again, for every connector
 * already installed) read one verdict (prompt-terms.ts isContentFree).
 */
import { foldWord, wordClassOf } from "./session-control.ts";

/** The binaries a developer runs by hand in a session's terminal. */
export const SHELL_COMMAND_BINARIES: readonly string[] = [
  "bun", "npm", "npx", "pnpm", "yarn", "git", "make", "docker", "kubectl", "cargo", "go", "pytest", "uv",
];

const BINARIES: ReadonlySet<string> = new Set(SHELL_COMMAND_BINARIES);

/** What a shell prompt or Claude Code's bang puts before the command: "$ npm test", "!git status". */
const PROMPT_MARK = /^[!$]+\s*/u;

/** Sentence marks after a word: "bun test." is the command, "fails." is no path. */
const TRAILING_MARKS = /[.,;:!?]+$/u;

/** A flag: "-5", "-x", "--force-with-lease", "--" itself. */
const FLAG = /^-/u;

/** A path: a slash or a tilde in it, a leading dot ("./src", ".nvmrc"), or a dot between two name characters ("auth.spec.ts"). */
const PATH = /[/~]|^\.[\p{L}\p{N}]|[\p{L}\p{N}_-]\.[\p{L}\p{N}_-]/u;

/** A word a command may take without naming a task: a flag, a path, or one of the session's operation words ("test", "run", "build"). */
const isCommandOwn = (word: string): boolean =>
  word.length === 0 || FLAG.test(word) || PATH.test(word) || wordClassOf(foldWord(word)) === "operation";

/** Is this text a binary from the list, then nothing but flags, paths and operation words? */
export const isBareShellCommand = (text: string): boolean => {
  const [first, ...rest] = text.trim().replace(PROMPT_MARK, "").split(/\s+/u);
  if (first === undefined || !BINARIES.has(first.toLowerCase())) {
    return false;
  }
  return rest.every((word) => isCommandOwn(word.replace(TRAILING_MARKS, "")));
};
