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

/** git never abbreviates below 4 hex digits; a full SHA-1 is 40. */
const MIN_SHORT_SHA_HEX = 4;
const FULL_SHA_HEX = 40;

/**
 * Matched EXACTLY — the prefix and a lowercase hex sha git's `--short` could
 * print. A prefix match made `detached@release`, a legal branch name, a
 * detached HEAD, and folded somebody's real branch into the one detached
 * topic every teammate listing prints.
 */
const DETACHED_REF_PATTERN = new RegExp(
  `^${DETACHED_BRANCH_PREFIX}[0-9a-f]{${String(MIN_SHORT_SHA_HEX)},${String(FULL_SHA_HEX)}}$`,
);

export const isDetachedBranch = (branch: string): boolean =>
  branch === UNNAMED_HEAD_BRANCH || DETACHED_REF_PATTERN.test(branch);

/** Between the ref and the commit subject in a detached fallback title. */
export const DETACHED_SUBJECT_SEPARATOR = " · ";

/**
 * A fallback title's head (its ` @ <repo>` already off) names a detached
 * HEAD when the ref it opens with does: `detached@<sha>` alone, or
 * `detached@<sha> · <subject>` (flows/work-context-title.ts
 * composeDetachedTitle).
 */
export const isDetachedTitleHead = (head: string): boolean =>
  isDetachedBranch(head.split(DETACHED_SUBJECT_SEPARATOR, 1)[0] ?? head);
