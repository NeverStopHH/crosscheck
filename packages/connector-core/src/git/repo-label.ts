/**
 * Last segment of the shared repo id (`github.com/acme/api` → `api`), never a
 * local directory name: a work-context title is uploaded and read by
 * teammates. A `local:` id has no shareable segment, so the branch alone has
 * to carry it and this returns null.
 *
 * Its own module because two directions read it: the title builder composes
 * `<branch> @ <label>` with it (flows/register-session.ts), and the briefing
 * strips the same suffix again to read a title's topic (briefing/render.ts) —
 * one spelling, or the two would drift and every title would stop grouping.
 */
const LOCAL_REPO_PREFIX = "local:";

export const repoLabel = (repoId: string): string | null => {
  if (repoId.startsWith(LOCAL_REPO_PREFIX)) {
    return null;
  }
  const last = repoId.split("/").at(-1)?.trim();
  return last === undefined || last.length === 0 ? null : last;
};
