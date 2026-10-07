/**
 * How a session on a detached HEAD spells its branch, in ONE place both sides
 * of the wire read: this prefix plus git's own `--short` sha
 * (`detached@abc1234`), or the bare `HEAD` when git could not name the commit
 * at all (connector-core git/repo-identity.ts resolveBranch writes both).
 *
 * Two readers, one spelling. The connector groups a repo's detached sessions
 * as ONE topic and never one per sha (connector-core briefing/render.ts). The
 * hub never reads a detached session's base commit reaching the default
 * branch as that session's work landing (server services/landed.ts): a
 * detached HEAD is a checkout of a commit — an orchestration worktree, a
 * review — and the work its session does happens elsewhere.
 *
 * No imports, so the render layer can read it without pulling in git.
 */
export const DETACHED_BRANCH_PREFIX = "detached@";

/** The branch label when git could not even name the HEAD commit. */
export const UNNAMED_HEAD_BRANCH = "HEAD";

/**
 * git never abbreviates below 4 hex digits; a full object id is 40 under
 * SHA-1 and 64 under the SHA-256 object format, so the bound is the longer.
 */
const MIN_SHORT_SHA_HEX = 4;
const FULL_SHA_HEX = 64;

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
