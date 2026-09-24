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
  /** A submodule: git tracks a commit pointer here, never the files inside it. */
  | "submodule"
  /**
   * Typed from a subdirectory, and git tracks the path BOTH from the repo
   * root and from where the person stood. Pin paths are repo-relative, so the
   * root one would be pinned — silently the wrong file, in a monorepo.
   */
  | "ambiguous"
  /** Git did not answer, so nothing may be stored as though it had. */
  | "git_unanswered";

export interface PinPathRefusal {
  readonly path: string;
  readonly reason: PinPathRefusalReason;
  /** The repo-relative spelling git tracks for where the person stood, when there is one. */
  readonly suggestion: string | null;
}

export type PinPathResolution =
  | { readonly ok: true; readonly paths: readonly string[] }
  | { readonly ok: false; readonly refused: readonly PinPathRefusal[] };

const NUL = "\u0000";
const TAB = "\t";
/** The index mode of a gitlink — a submodule's commit pointer. */
const GITLINK_MODE = "160000";

interface Tracked {
  readonly path: string;
  readonly gitlink: boolean;
}

/**
 * Index entries matching these LITERAL pathspecs, in git's own spelling — or
 * null when git did not answer. Literal, so a `*` in a path is a character,
 * not a glob that pins a whole directory. `-s` for the mode, so a submodule
 * is told apart from a file; a conflicted path's stages collapse to one.
 */
const listTracked = async (
  cwd: string,
  paths: readonly string[],
): Promise<readonly Tracked[] | null> => {
  const listed = await runGitOutcome(
    ["--literal-pathspecs", "ls-files", "-z", "-s", "--full-name", "--", ...paths],
    cwd,
    GIT_TIMEOUT_MS,
  );
  if (!listed.ok) {
    return null;
  }
  const byPath = new Map<string, Tracked>();
  for (const entry of listed.stdout.split(NUL)) {
    const tab = entry.indexOf(TAB);
    if (tab < 0) {
      continue;
    }
    const path = entry.slice(tab + 1);
    byPath.set(path, { path, gitlink: entry.startsWith(`${GITLINK_MODE} `) });
  }
  return [...byPath.values()];
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
 * The file the person may have meant from where they stood — their path
 * resolved against their directory — IF git tracks exactly that file.
 * Offered, never stored.
 */
const trackedFromHere = async (
  repoRoot: string,
  prefix: string,
  raw: string,
): Promise<string | null> => {
  if (prefix.length === 0) {
    return null;
  }
  const meant = canonicalRepoPath(`${prefix}${raw}`);
  if (!meant.ok) {
    return null;
  }
  const listed = await listTracked(repoRoot, [meant.path]);
  return listed?.some((entry) => entry.path === meant.path && !entry.gitlink) === true
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
  const prefix = await prefixOf(cwd);
  if (tracked === null || prefix === null) {
    return {
      ok: false,
      refused: raw.map((path) => ({ path, reason: "git_unanswered" as const, suggestion: null })),
    };
  }
  const exact = new Map(tracked.map((entry) => [entry.path, entry]));
  const refused: PinPathRefusal[] = [];
  for (const [index, path] of paths.entries()) {
    const typed = raw[index] ?? path;
    const entry = exact.get(path);
    const fromHere = await trackedFromHere(repoRoot, prefix, typed);
    if (entry !== undefined && entry.gitlink) {
      refused.push({ path: typed, reason: "submodule", suggestion: null });
      continue;
    }
    if (entry !== undefined) {
      if (fromHere !== null && fromHere !== path) {
        refused.push({ path: typed, reason: "ambiguous", suggestion: fromHere });
      }
      continue;
    }
    if (tracked.some((file) => file.path.startsWith(`${path}/`))) {
      refused.push({ path: typed, reason: "directory", suggestion: null });
      continue;
    }
    refused.push({ path: typed, reason: "not_tracked", suggestion: fromHere });
  }
  return refused.length === 0
    ? { ok: true, paths: [...new Set(paths)] }
    : { ok: false, refused };
};
