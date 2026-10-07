/**
 * Whether a session's branch IS the repo's default branch, in ONE place both
 * sides of the wire read (pilot finding, 2026-10-05). A session on the
 * default branch has a base commit that is an ancestor of it from its first
 * second, so its reaching the default branch says nothing about its work: the
 * connector skips landed collection from such a session (connector-claude
 * hooks/session-start.ts isOnDefaultBranch), and the hub never stamps its
 * context landed by base ancestry (server services/landed.ts).
 *
 * `defaultBranchRef` is what git and the landed report spell — usually the
 * REMOTE-tracking ref, `origin/main` — while a session's branch is the local
 * name, so the comparison is against the segment after the last `/` as well
 * as the whole ref. Null — no default branch known — never matches: that
 * would be a guess.
 */
export const isDefaultBranch = (
  branch: string,
  defaultBranchRef: string | null,
): boolean => {
  if (defaultBranchRef === null) {
    return false;
  }
  const localName = defaultBranchRef.split("/").at(-1) ?? defaultBranchRef;
  return branch === localName || branch === defaultBranchRef;
};
