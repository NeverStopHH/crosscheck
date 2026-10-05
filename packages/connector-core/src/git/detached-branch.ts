/**
 * How a session on a detached HEAD spells its branch, in ONE place: this
 * prefix plus git's own `--short` sha (`detached@abc1234`), or the bare
 * `HEAD` when git could not name the commit at all (git/repo-identity.ts
 * resolveBranch writes both).
 *
 * Its own module, with no imports, because the render layer reads it too —
 * every teammate listing groups a repo's detached sessions as ONE topic and
 * never one per sha (briefing/render.ts) — while repo-identity.ts runs git.
 */
export const DETACHED_BRANCH_PREFIX = "detached@";

/** The branch label when git could not even name the HEAD commit. */
export const UNNAMED_HEAD_BRANCH = "HEAD";

export const isDetachedBranch = (branch: string): boolean =>
  branch === UNNAMED_HEAD_BRANCH || branch.startsWith(DETACHED_BRANCH_PREFIX);
