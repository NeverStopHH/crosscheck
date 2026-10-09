/**
 * PATH ENTRIES A REPO CANNOT SUPPLY (review round 2, N6).
 *
 * crosscheck finds `crosscheck` (and the npm shim finds `bun`) by PATH. Some
 * developers put a relative entry such as `node_modules/.bin` on PATH, or a
 * repo's own bin directory (direnv's `PATH_add`). Either way the program that
 * answers to the name is one the repo ships: probed, a repo carrying
 * `node_modules/.bin/bun` ran instead of bun when the shim started in it. So
 * a lookup skips every entry that is relative, or that sits inside the repo
 * the cwd is in (its nearest ancestor holding `.git`, else the cwd itself).
 *
 * The npm shim cannot import this file and carries the same rule
 * (packaging/bin/crosscheck.cjs `isTrustedPathEntry`).
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Compared by real path: a repo reached through a symlink (macOS's
 * /var -> /private/var among them) is the same directory under both names.
 * A path that does not exist yet is its nearest existing ancestor's real
 * path plus the rest, so it compares the same way.
 */
const realOrResolved = (path: string): string => {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  try {
    return realpathSync(absolute);
  } catch {
    return parent === absolute ? absolute : join(realOrResolved(parent), basename(absolute));
  }
};

/** The nearest ancestor of `cwd` holding `.git` (a directory, or a worktree's file); `cwd` itself when none does. */
export const enclosingRepoRoot = (cwd: string): string => {
  const start = realOrResolved(cwd);
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) {
      return dir;
    }
    if (dirname(dir) === dir) {
      return start;
    }
  }
};

/** `..` itself or a `../` prefix leaves the root; an in-repo `..bin` does not. */
const isInside = (path: string, root: string): boolean => {
  const fromRoot = relative(root, path);
  const leaves = fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
  return !leaves;
};

/** Whether a PATH entry is absolute and outside the repo `cwd` is in. */
export const isTrustedPathEntry = (entry: string, cwd: string): boolean =>
  entry.length > 0 && isAbsolute(entry) && !isInside(realOrResolved(entry), enclosingRepoRoot(cwd));

/** The PATH entries a lookup would have used and must not. */
export const untrustedPathEntries = (pathValue: string, cwd: string): readonly string[] =>
  pathValue.split(delimiter).filter((entry) => entry.length > 0 && !isTrustedPathEntry(entry, cwd));

/** `pathValue` with only its trusted entries, for `Bun.which`. */
export const trustedPath = (pathValue: string, cwd: string): string =>
  pathValue
    .split(delimiter)
    .filter((entry) => isTrustedPathEntry(entry, cwd))
    .join(delimiter);
