/**
 * Path-derived connected-repo resolution (trial finding #9).
 *
 * The incident: a developer's editor workspace was rooted at the PARENT
 * folder of the repo (~/dev above ~/dev/monorepo). Hooks fire with cwd at
 * the workspace root, cwd-based resolution finds no repo there, and every
 * session in that panel is silently invisible — while terminal sessions
 * (cwd inside the repo) report fine. When the cwd says nothing, the file
 * the hook is actually about says everything: walk UP from the touched file
 * to the repo it belongs to.
 *
 * THE TRUST RULE (DESIGN.md §2.1) IS UNCHANGED AND NON-NEGOTIABLE: the repo
 * decides where a session reports, and only a repo whose ROOT carries the
 * committed `.crosscheck.json` may ever be reported to. This walk is
 * therefore STRICTER than cwd resolution, not looser:
 *
 *   - it stops at the FIRST git boundary above the file (`.git` entry, dir
 *     or worktree file) — exactly the repo `git rev-parse --show-toplevel`
 *     would name for that file. If that repo's root has no parseable
 *     committed config, the answer is null and STAYS null: the walk never
 *     continues past a repo boundary, so a connected OUTER repo can never
 *     capture files belonging to an unconnected repo nested inside it;
 *   - a `.crosscheck.json` found in a plain directory (no `.git` beside it)
 *     is ignored — init writes the config at the repo root, and a stray
 *     copy elsewhere must not mint a reporting target;
 *   - the walk is bounded by CONNECTED_ROOT_WALK_MAX_LEVELS plain fs stats
 *     (two per level, no processes), because it runs inside hook budgets.
 *     Measured on a warm APFS cache: ~106 µs for a 6-level hit, ~18 µs for
 *     a boundary stop, ~121 µs for a full miss to the fs root — three
 *     orders of magnitude under the tightest hook budget; the fallback's
 *     dominant cost stays the git spawns of identity resolution, identical
 *     to the cwd path. The bounds themselves:
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/config/connected-repo.ts");console.log(c.CONNECTED_ROOT_WALK_MAX_LEVELS, c.CONNECTED_ROOT_MAX_CANDIDATE_PATHS)'
 * PRINTS: 32 3
 *
 * The caller re-resolves full repo identity from the returned root (git
 * remote, branch, base commit) and re-checks the committed config at the
 * IDENTITY's root — this module only answers "which directory, if any, is
 * the file's connected repo root".
 */
import { dirname, isAbsolute, resolve } from "node:path";
import { stat } from "node:fs/promises";

import { readRepoConfig } from "./repo-config.ts";

/**
 * Bound on the upward walk from the touched file to a repo root. Deep
 * monorepos sit well under 32 directory levels; a path deeper than this
 * simply resolves to "not connected" (fail-open, silence).
 */
export const CONNECTED_ROOT_WALK_MAX_LEVELS = 32;

/**
 * Most touched-file candidates one hook invocation walks for. The first
 * path that resolves wins; hooks carry one file in the common case.
 */
export const CONNECTED_ROOT_MAX_CANDIDATE_PATHS = 3;

/** `.git` may be a directory (checkout) or a file (worktree) — both count. */
const hasGitEntry = async (dir: string): Promise<boolean> => {
  try {
    await stat(resolve(dir, ".git"));
    return true;
  } catch {
    return false;
  }
};

/**
 * The connected repo root governing `filePath`, or null. Null for: a file
 * outside any git repo, a file whose innermost repo carries no committed
 * config (silent forever — the inverse pin), an unreadable path, a walk
 * past the level bound. Relative paths resolve against `cwd`, exactly as
 * capture resolves them.
 */
export const findConnectedRepoRootForFile = async (
  cwd: string,
  filePath: string,
): Promise<string | null> => {
  const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  let dir = dirname(absolute);
  for (let level = 0; level < CONNECTED_ROOT_WALK_MAX_LEVELS; level += 1) {
    // The file may not exist yet (Write creates it, mkdir -p later): a
    // missing level has no `.git` and no config and the walk continues up.
    if (await hasGitEntry(dir)) {
      // First repo boundary: this repo owns the file. Connected or silent —
      // never look past it (nested-repo trust, header).
      return (await readRepoConfig(dir)) === null ? null : dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
  return null;
};

/**
 * First connected root among the candidate paths, or null. The cap is the
 * caller's protection against a tool payload carrying many paths — the walk
 * is cheap, but it is filesystem work on a hook path and stays bounded.
 */
export const findConnectedRepoRootForPaths = async (
  cwd: string,
  paths: readonly string[],
): Promise<string | null> => {
  for (const path of paths.slice(0, CONNECTED_ROOT_MAX_CANDIDATE_PATHS)) {
    const root = await findConnectedRepoRootForFile(cwd, path);
    if (root !== null) {
      return root;
    }
  }
  return null;
};
