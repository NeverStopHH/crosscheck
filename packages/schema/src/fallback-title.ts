/**
 * THE HONEST FALLBACK TITLE, in ONE place both sides of the wire read.
 *
 * When the host supplies no title, a connector names a work context
 * `<branch> @ <label>` (connector-core flows/register-session.ts), and a
 * detached worktree `detached@<sha> · <subject> @ <label>`. Either way that
 * title IS the session's branch or HEAD — the developer's live location — so
 * the hub recognises the same shape to withhold it from viewers an opted-out
 * developer's location is hidden from (server services/live-location.ts),
 * and both sides spell the shape with these two functions.
 */
const LOCAL_REPO_PREFIX = "local:";

/**
 * Last segment of the shared repo id (`github.com/acme/api` → `api`), never a
 * local directory name: a work-context title is uploaded and read by
 * teammates. A `local:` id has no shareable segment, so the branch alone has
 * to carry it and this returns null.
 */
export const repoLabel = (repoId: string): string | null => {
  if (repoId.startsWith(LOCAL_REPO_PREFIX)) {
    return null;
  }
  const last = repoId.split("/").at(-1)?.trim();
  return last === undefined || last.length === 0 ? null : last;
};

/**
 * True when `title` has the fallback shape for `repoId`: anything, then
 * ` @ <label>`. A `local:` repo has no label and so no recognisable shape —
 * its id is a hash of one machine's path, which no teammate's session shares.
 */
export const isFallbackTitle = (title: string, repoId: string): boolean => {
  const label = repoLabel(repoId);
  return label !== null && title.endsWith(` @ ${label}`);
};

/**
 * What a withheld fallback title reads as on every surface: the product's own
 * neutral words — no branch, no sha, nothing the phrase filter or the frame
 * would treat as anything but a label.
 */
export const WITHHELD_TITLE = "untitled work";
