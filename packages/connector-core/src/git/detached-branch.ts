/**
 * How a session on a detached HEAD spells its branch: `detached@<short sha>`,
 * or the bare `HEAD` when git could not name the commit at all
 * (git/repo-identity.ts resolveBranch writes both).
 *
 * THE SPELLING LIVES IN @crosscheck/schema, because the hub reads it too: a
 * detached session's base reaching the default branch is never its work
 * landing (server services/landed.ts). Re-exported here so the render layer
 * — every teammate listing groups a repo's detached sessions as ONE topic
 * (briefing/render.ts) — keeps importing it without pulling in git, which
 * repo-identity.ts runs. Only the title half below is the connector's own.
 */
import { isDetachedBranch } from "@crosscheck/schema";

export {
  DETACHED_BRANCH_PREFIX,
  UNNAMED_HEAD_BRANCH,
  isDetachedBranch,
} from "@crosscheck/schema";

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
