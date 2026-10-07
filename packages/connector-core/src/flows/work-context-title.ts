/**
 * The honest fallback work-context title, detached-HEAD aware (trial finding
 * #15). `fallbackWorkContextTitle` (flows/register-session.ts) is the cheap
 * synchronous half — `branch @ repo` — and stays what every per-hook path
 * uses. This module is the SESSION-START half: a worktree session runs on a
 * detached HEAD, its branch reads `detached@<sha>`, and `detached@<sha> @
 * monorepo` told teammates nothing (70 of 80 trial work contexts). So, for a
 * detached session only, one bounded git call (HEAD_LABEL_GIT_TIMEOUT_MS,
 * runGit's deadline-raced, killable discipline) for the HEAD commit's
 * subject, sanitized as PROSE and bounded to DETACHED_SUBJECT_MAX_CHARS:
 * `detached@<sha> · <subject> @ api`.
 *
 * NEVER A BRANCH THAT MERELY POINTS AT THE COMMIT. This used to try
 * `for-each-ref --points-at HEAD` first and let the branch win outright. A
 * long-lived detached checkout sits at an OLD commit, and a stale branch from
 * weeks ago points there too: the owner's one session in `agentic-main`
 * titled every topic it worked on — in a dozen sibling worktrees — by that
 * stale branch. A detached HEAD is on no branch, and its title says so; the
 * topics it touches carry their own branches (flows/topic-contexts.ts).
 *
 * The subject is a developer's commit message on its way into an uploaded
 * title that every teammate surface frames in « » — so it takes the same
 * secret gate (a hit DROPS the subject, never redacts) and the same PROSE
 * sanitizer the Claude session_title takes, BEFORE it leaves the machine.
 * `composeDetachedTitle` is the pure composer, exported so the §4.4 registry
 * can plant hostile subjects without a git repo; the sha keeps git's
 * `--short` length (unambiguous per repo) rather than a fixed seven.
 *
 * Every git failure — no git, slow git, an unborn HEAD — falls back to the
 * plain `branch @ repo` title: the registration never waits past the two
 * bounded calls and never loses a session to a label.
 */
import { DETACHED_SUBJECT_MAX_CHARS, HEAD_LABEL_GIT_TIMEOUT_MS } from "../constants.ts";
import { sanitizeUntrusted } from "../briefing/sanitize.ts";
import { containsSecret } from "../capture/secret-scan.ts";
import { runGit } from "../git/git.ts";
import { DETACHED_BRANCH_PREFIX } from "../git/repo-identity.ts";
import type { RepoIdentity } from "../git/repo-identity.ts";
import { fallbackWorkContextTitle } from "./register-session.ts";

/** U+00B7 — the separator the briefing and MCP lines already use. */
const SUBJECT_SEPARATOR = " · ";

/**
 * The commit subject as a title may carry it: dropped whole when the secret
 * scan hits (capture/secret-scan.ts states why dropping beats redacting),
 * else PROSE-sanitized and bounded. Empty means "no subject in the title".
 */
const subjectLabel = (rawSubject: string): string =>
  containsSecret(rawSubject)
    ? ""
    : sanitizeUntrusted(rawSubject, DETACHED_SUBJECT_MAX_CHARS);

/**
 * `detached@<sha> · <subject> @ <repo>` — or without the subject when it
 * sanitized away, and without ` @ <repo>` for a `local:` id (the same
 * repo-label rule fallbackWorkContextTitle applies).
 */
export const composeDetachedTitle = (
  branch: string,
  rawSubject: string,
  repoId: string,
): string => {
  const subject = subjectLabel(rawSubject);
  const head = subject.length === 0 ? branch : `${branch}${SUBJECT_SEPARATOR}${subject}`;
  return fallbackWorkContextTitle(head, repoId);
};

/**
 * The session-start title for a host that supplied none: `branch @ repo`
 * unchanged for a branch session (no git at all), and the detached
 * derivation above for a `detached@…` one. Used by every connector's
 * session-start path (Claude, Cursor, ACP) and by the Claude/Cursor
 * mid-session recoveries — once per session, never per tool.
 */
export const resolveFallbackWorkContextTitle = async (
  identity: RepoIdentity,
): Promise<string> => {
  if (!identity.branch.startsWith(DETACHED_BRANCH_PREFIX)) {
    return fallbackWorkContextTitle(identity.branch, identity.repoId);
  }
  const subject = await runGit(
    ["log", "-1", "--format=%s"],
    identity.root,
    HEAD_LABEL_GIT_TIMEOUT_MS,
  );
  return composeDetachedTitle(identity.branch, subject ?? "", identity.repoId);
};
