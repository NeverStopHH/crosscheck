/**
 * THE PIN DOOR ASKS GIT (1.0 spec 01a §3.3d, CSK-28).
 *
 * `canonicalRepoPath` settles `./`, `//` and Unicode form, and nothing that
 * needs a repository. Two everyday mistakes need one: a wrong case typed on a
 * case-insensitive disk (`SRC/auth.ts` for a file git tracks as
 * `src/auth.ts`), and a path typed relative to a subdirectory. Either stores a
 * spelling that LOOKS resolved and matches nothing — the pin protects nothing,
 * `suspect` answers "nobody touched it", and 01a's sweep reads "no pin
 * references this session" and deletes behind it. A mis-spelling becomes a
 * deletion, which is principle 6 inverted.
 *
 * SO THE DOOR ASKS GIT WHETHER IT TRACKS EXACTLY THAT FILE, and refuses what it
 * does not — with the reason, and, when the person was standing in a
 * subdirectory and git can name the file they meant, that file's repo-relative
 * spelling to type instead. It never stores the suggestion itself: guessing
 * which of two files was meant is how a wrong identity gets stored.
 *
 * Git matches the index case-sensitively even with `core.ignorecase` (measured
 * on this machine), so a wrong case is refused on every platform alike rather
 * than resolved on some.
 */
import { canonicalRepoPath } from "@crosscheck/schema";
import type { CanonicalPathRefusal } from "@crosscheck/schema";

import { GIT_TIMEOUT_MS } from "../constants.ts";
import { runGitOutcome } from "./git.ts";

export type PinPathRefusalReason =
  | CanonicalPathRefusal
  /** Git tracks no file at this path — mistyped, wrong case, untracked, or typed from a subdirectory. */
  | "not_tracked"
  /** Git tracks files UNDER this path: it is a directory, and a pin watches files. */
  | "directory"
  /** Git did not answer, so nothing may be stored as though it had. */
  | "git_unanswered";

export interface PinPathRefusal {
  readonly path: string;
  readonly reason: PinPathRefusalReason;
  /** The repo-relative spelling git tracks, when the person stood in a subdirectory. */
  readonly suggestion: string | null;
}

export type PinPathResolution =
  | { readonly ok: true; readonly paths: readonly string[] }
  | { readonly ok: false; readonly refused: readonly PinPathRefusal[] };

const NUL = "\u0000";

/**
 * Tracked files matching these LITERAL pathspecs, in git's own spelling — or
 * null when git did not answer. Literal, so a `*` in a path is a character,
 * not a glob that pins a whole directory.
 */
const listTracked = async (
  cwd: string,
  paths: readonly string[],
): Promise<readonly string[] | null> => {
  const listed = await runGitOutcome(
    ["--literal-pathspecs", "ls-files", "-z", "--full-name", "--", ...paths],
    cwd,
    GIT_TIMEOUT_MS,
  );
  return listed.ok
    ? listed.stdout.split(NUL).filter((path) => path.length > 0)
    : null;
};

/**
 * Where the person stood, as git names it: `src/workbench/`, or "" at the
 * root. GIT names it, not path arithmetic — git reports the REAL root, the
 * shell stands wherever the person `cd`-ed, and across a symlink (every macOS
 * temp dir: /var → /private/var) `relative()` of the two reads `../../..`.
 */
const prefixOf = async (cwd: string): Promise<string | null> => {
  const shown = await runGitOutcome(["rev-parse", "--show-prefix"], cwd, GIT_TIMEOUT_MS);
  return shown.ok ? shown.stdout.replace(/\n$/, "") : null;
};

/**
 * The file the person most likely meant, when they stood in a subdirectory:
 * their path resolved against where they stood, IF git tracks exactly that
 * file. Offered, never stored.
 */
const suggestionFor = async (
  repoRoot: string,
  cwd: string,
  raw: string,
): Promise<string | null> => {
  const prefix = await prefixOf(cwd);
  if (prefix === null || prefix.length === 0) {
    return null;
  }
  const meant = canonicalRepoPath(`${prefix}${raw}`);
  if (!meant.ok) {
    return null;
  }
  const listed = await listTracked(repoRoot, [meant.path]);
  return listed !== null && listed.length === 1 && listed[0] === meant.path
    ? meant.path
    : null;
};

export const resolvePinPaths = async (
  repoRoot: string,
  cwd: string,
  raw: readonly string[],
): Promise<PinPathResolution> => {
  const canonical = raw.map((path) => ({ raw: path, result: canonicalRepoPath(path) }));
  const unusable: PinPathRefusal[] = [];
  const paths: string[] = [];
  for (const entry of canonical) {
    if (entry.result.ok) {
      paths.push(entry.result.path);
    } else {
      unusable.push({ path: entry.raw, reason: entry.result.reason, suggestion: null });
    }
  }
  if (unusable.length > 0) {
    return { ok: false, refused: unusable };
  }
  const tracked = await listTracked(repoRoot, paths);
  if (tracked === null) {
    return {
      ok: false,
      refused: raw.map((path) => ({ path, reason: "git_unanswered" as const, suggestion: null })),
    };
  }
  const exact = new Set(tracked);
  const refused: PinPathRefusal[] = [];
  for (const [index, path] of paths.entries()) {
    if (exact.has(path)) {
      continue;
    }
    const typed = raw[index] ?? path;
    if (tracked.some((file) => file.startsWith(`${path}/`))) {
      refused.push({ path: typed, reason: "directory", suggestion: null });
      continue;
    }
    refused.push({
      path: typed,
      reason: "not_tracked",
      suggestion: await suggestionFor(repoRoot, cwd, typed),
    });
  }
  return refused.length === 0
    ? { ok: true, paths: [...new Set(paths)] }
    : { ok: false, refused };
};
