/**
 * THE WORKTREES A SHELL WORKED IN (review H2 of feat/topic-contexts; DESIGN.md
 * "One session, many topics").
 *
 * A Bash call's payload names the directory the hook ran in, and in the
 * owner's shape that is the START checkout: a subagent's cwd is reset to it
 * between calls, and its command is `cd ~/worktrees/x && cp … && git commit`.
 * Marking only the payload cwd marked the start checkout, and a sibling that
 * no Edit ever touched was never swept — its committed and new files nowhere,
 * and nothing counting them. Two answers, both fs-only:
 *
 *   - the command's own words: `cd` / `pushd` targets, `git -C` targets, and
 *     absolute or `~/` path words, bounded and parsed conservatively — a word
 *     carrying `$`, a backtick or a glob is never guessed at — each resolved
 *     to the worktree holding it and kept only when it is a worktree of the
 *     session's repo (`rootsNamedByCommand`);
 *   - where the words cannot tell, the repo's worktrees whose index or HEAD
 *     log changed since the session began (`changedWorktreesOf`): the next
 *     Stop sweeps them within its root budget, and the ones that do not fit
 *     are counted (flows/git-lane.ts).
 *
 * No git runs here: `.git` files, `commondir`, `<commondir>/worktrees/*` and
 * two `stat`s per worktree.
 */
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { commonDirOf, gitDirOf } from "./repo-identity.ts";

/** Words of one command looked at, at most — a pasted script must not cost a walk per word. */
export const MAX_SHELL_WORDS = 64;
/** Distinct roots one command may mark. */
export const MAX_SHELL_ROOTS = 8;
/** Worktrees of one repo looked at by discovery, at most. */
export const MAX_DISCOVERED_WORKTREES = 64;
/** Directory levels walked up from a named path to the worktree holding it. */
const MAX_ROOT_DEPTH = 64;

const SEPARATORS = /[\s;&|()<>]+/u;
const QUOTES = /^['"]+|['"]+$/gu;
/** A word the shell would expand: never guessed at. */
const EXPANDS = /[$`*?[{]/u;
const DIR_VERBS: ReadonlySet<string> = new Set(["cd", "pushd"]);

/** One word, unquoted, `--flag=/path` reduced to its path; `~/` from `home`; null when the shell would expand it. */
const pathOfWord = (word: string, home: string): string | null => {
  const unquoted = word.replace(QUOTES, "");
  const value = unquoted.startsWith("-") && unquoted.includes("=") ? unquoted.slice(unquoted.indexOf("=") + 1) : unquoted;
  if (value.length === 0 || EXPANDS.test(value)) {
    return null;
  }
  if (value === "~" || value.startsWith("~/")) {
    return join(home, value.slice(1));
  }
  return value;
};

/**
 * The directories a command names (header), relative ones resolved against
 * the payload cwd. A plain relative word is not a path claim (`cp a b`), so
 * only `cd`/`pushd` and `git -C` targets may be relative.
 */
export const commandDirectories = (command: string, cwd: string, home: string): readonly string[] => {
  const words = command.split(SEPARATORS).filter((word) => word.length > 0).slice(0, MAX_SHELL_WORDS);
  const found: string[] = [];
  for (const [index, word] of words.entries()) {
    const previous = words[index - 1] ?? "";
    const isDirTarget = DIR_VERBS.has(previous) || (previous === "-C" && words[index - 2] === "git");
    const path = pathOfWord(word, home);
    if (path === null) {
      continue;
    }
    if (isAbsolute(path)) {
      found.push(path);
    } else if (isDirTarget) {
      found.push(resolve(cwd, path));
    }
  }
  return [...new Set(found)];
};

const exists = async (path: string): Promise<boolean> => (await stat(path).catch(() => null)) !== null;

/** The worktree holding `path`: the nearest directory at or above it with a `.git` entry. Realpath'd; null past the bound. */
export const worktreeRootOf = async (path: string): Promise<string | null> => {
  let current = path;
  for (let depth = 0; depth < MAX_ROOT_DEPTH; depth += 1) {
    if (await exists(join(current, ".git"))) {
      return realpath(current).catch(() => current);
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
  return null;
};

/** The git common dir a worktree's refs live in, realpath'd — what makes two worktrees one repo. */
export const commonDirOfRoot = async (root: string): Promise<string | null> => {
  const gitDir = await gitDirOf(root);
  if (gitDir === null) {
    return null;
  }
  const common = await commonDirOf(gitDir);
  return realpath(common).catch(() => common);
};

/**
 * THE ROOTS A COMMAND NAMES that are worktrees of the repo whose common dir is
 * `commonDir`, each once, at most MAX_SHELL_ROOTS. A path into another repo,
 * or into no repo, marks nothing.
 */
export const rootsNamedByCommand = async (
  command: string,
  cwd: string,
  home: string,
  commonDir: string,
): Promise<readonly string[]> => {
  const roots: string[] = [];
  for (const directory of commandDirectories(command, cwd, home)) {
    if (roots.length >= MAX_SHELL_ROOTS) {
      break;
    }
    const root = await worktreeRootOf(directory);
    if (root !== null && !roots.includes(root) && (await commonDirOfRoot(root)) === commonDir) {
      roots.push(root);
    }
  }
  return roots;
};

/** The newest of a git dir's index and HEAD-log mtimes, or null when it has neither. */
const changedAtMs = async (gitDir: string): Promise<number | null> => {
  const times = await Promise.all(
    [join(gitDir, "index"), join(gitDir, "logs", "HEAD")].map(async (path) => (await stat(path).catch(() => null))?.mtimeMs ?? null),
  );
  const known = times.filter((time): time is number => time !== null);
  return known.length === 0 ? null : Math.max(...known);
};

/** Every worktree of the repo: its main one, and each `<commondir>/worktrees/<name>`, with its git dir. */
const worktreesOf = async (commonDir: string): Promise<readonly { readonly root: string; readonly gitDir: string }[]> => {
  const main = basename(commonDir) === ".git" ? [{ root: dirname(commonDir), gitDir: commonDir }] : [];
  const names = await readdir(join(commonDir, "worktrees")).catch(() => [] as string[]);
  const linked = await Promise.all(
    names.slice(0, MAX_DISCOVERED_WORKTREES).map(async (name) => {
      const gitDir = join(commonDir, "worktrees", name);
      const pointer = (await readFile(join(gitDir, "gitdir"), "utf8").catch(() => "")).trim();
      return pointer.length === 0 ? null : { root: dirname(pointer), gitDir };
    }),
  );
  return [...main, ...linked.filter((entry): entry is { root: string; gitDir: string } => entry !== null)];
};

/** A worktree that changed, and when: the newest of its index and HEAD-log writes. */
export interface ChangedWorktree {
  readonly root: string;
  readonly changedAtMs: number;
}

/**
 * THE WORKTREES OF THE REPO THAT CHANGED since `since` — their index or HEAD
 * log written at or after it: where a shell may have worked when its words
 * could not tell. Realpath'd, each once, at most MAX_DISCOVERED_WORKTREES
 * looked at, a worktree whose directory is gone left out.
 */
export const changedWorktreesOf = async (commonDir: string, since: Date): Promise<readonly ChangedWorktree[]> => {
  const changed = new Map<string, number>();
  for (const worktree of await worktreesOf(commonDir)) {
    const at = await changedAtMs(worktree.gitDir);
    if (at !== null && at >= since.getTime() && (await exists(worktree.root))) {
      changed.set(await realpath(worktree.root).catch(() => worktree.root), at);
    }
  }
  return [...changed].map(([root, changedAtMs]) => ({ root, changedAtMs }));
};
