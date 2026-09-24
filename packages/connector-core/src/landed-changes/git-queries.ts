/**
 * The git questions the landed-change probe asks (landed-changes/probe.ts),
 * one function each, and the parsing of their answers.
 *
 * QUIET GIT. Every call runs with GIT_NO_LAZY_FETCH=1 (a blobless partial
 * clone must never fetch from the network inside a hook; git before 2.44
 * ignores it, which is why partial clones also skip `--cherry-pick`, the one
 * flag here that needs blobs), GIT_TERMINAL_PROMPT=0 (no credential prompt
 * can hold the hook) and GIT_OPTIONAL_LOCKS=0 (a read never contends with the
 * developer's own git). Every call is bounded, returns null for any failure,
 * and is skipped once the probe's deadline has passed.
 *
 * THE ONE TIME-SHAPED MODULE of the probe (test/staleness-axis.test.ts, its
 * second allowlist entry): `--since` and `--before` appear only on a landing
 * branch's `--first-parent` line, where a merge or squash commit carries the
 * time a change LANDED, and only to decide whether a change the reader
 * already HAS is recent. Whether the reader is MISSING one is ancestry alone.
 */
import { resolve } from "node:path";

import { MAX_LANDED_COMMITS_SCANNED } from "../constants.ts";
import { runGitOutcome } from "../git/git.ts";
import type { LandingRef } from "./landing-branches.ts";

export const QUIET_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_NO_LAZY_FETCH: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
};

export interface GitContext {
  readonly root: string;
  /** Repo-relative, as git names it. */
  readonly file: string;
  readonly timeoutMs: number;
  /** True once the probe's deadline has passed: no further git is spawned. */
  readonly isCancelled: () => boolean;
}

export const gitStdout = async (context: GitContext, args: readonly string[]): Promise<string | null> => {
  if (context.isCancelled()) {
    return null;
  }
  const outcome = await runGitOutcome(args, context.root, context.timeoutMs, QUIET_GIT_ENV);
  return outcome.ok ? outcome.stdout : null;
};

const FIELD = "\x1f";
/**
 * full sha, short sha, author, email, committer time — and the SUBJECT LAST,
 * so a subject carrying the separator is rejoined, never dropped (a crafted
 * subject must not be able to hide its own commit).
 */
const COMMIT_FORMAT = "%H%x1f%h%x1f%aN%x1f%aE%x1f%ct%x1f%s";
const FIXED_COMMIT_FIELDS = 5;
/** The landing commit's full sha and parents, then COMMIT_FORMAT for itself. */
const LANDING_FORMAT = `%H%x1f%P%x1f${COMMIT_FORMAT}`;
const LANDING_PREFIX_FIELDS = 2;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const EPOCH_SECONDS_PATTERN = /^\d+$/;
const EMAIL_IN_IDENT = /<([^<>]*)>/;
/** A developer's own config must neither break nor rescue the parse. */
const LOG = ["log", "--no-show-signature", "--no-color"] as const;
const SCANNED = `--max-count=${String(MAX_LANDED_COMMITS_SCANNED)}`;

/** The file as git must take it: literally, never as a glob. */
const literalPath = (file: string): string => `:(literal)${file}`;

export interface ParsedCommit {
  readonly sha: string;
  readonly shortSha: string;
  /** Mailmap-aware. Written by another developer: untrusted. */
  readonly authorName: string;
  /** Mailmap-aware. For matching only; never rendered. */
  readonly authorEmail: string;
  /** Written by another developer: untrusted. */
  readonly subject: string;
  readonly committedAt: Date;
}

const toDate = (epochSeconds: string): Date | null =>
  EPOCH_SECONDS_PATTERN.test(epochSeconds) ? new Date(Number(epochSeconds) * 1000) : null;

const parseCommitFields = (fields: readonly string[]): ParsedCommit | null => {
  const [sha = "", shortSha = "", authorName = "", authorEmail = "", time = ""] = fields;
  const committedAt = toDate(time);
  if (fields.length <= FIXED_COMMIT_FIELDS || !FULL_SHA_PATTERN.test(sha) || committedAt === null) {
    return null;
  }
  const subject = fields.slice(FIXED_COMMIT_FIELDS).join(FIELD);
  return { sha, shortSha, authorName, authorEmail, subject, committedAt };
};

const parseCommits = (stdout: string): readonly ParsedCommit[] =>
  stdout
    .split("\n")
    .map((line) => parseCommitFields(line.split(FIELD)))
    .filter((commit): commit is ParsedCommit => commit !== null);

export interface LandingCommit {
  readonly parents: readonly string[];
  /** The landing commit itself; its committer time is when it LANDED. */
  readonly itself: ParsedCommit;
}

const parseLandingLine = (line: string): LandingCommit | null => {
  const fields = line.split(FIELD);
  const [, parents = ""] = fields;
  const itself = parseCommitFields(fields.slice(LANDING_PREFIX_FIELDS));
  return itself === null
    ? null
    : { parents: parents.split(" ").filter((parent) => FULL_SHA_PATTERN.test(parent)), itself };
};

export interface RepoState {
  /** A shallow clone's boundary commit "touches" every path: unreadable. */
  readonly isShallow: boolean;
  /** MERGE_HEAD / CHERRY_PICK_HEAD while one is in progress: arriving work. */
  readonly arriving: readonly string[];
}

/** One call: shallowness, and where the in-progress markers would be. */
export const readRepoState = async (context: GitContext): Promise<RepoState | null> => {
  const markers = ["MERGE_HEAD", "CHERRY_PICK_HEAD"] as const;
  const stdout = await gitStdout(context, [
    "rev-parse",
    "--is-shallow-repository",
    ...markers.flatMap((marker) => ["--git-path", marker]),
  ]);
  if (stdout === null) {
    return null;
  }
  const [shallow, ...paths] = stdout.split("\n");
  const present = await Promise.all(
    markers.map(async (marker, index) => {
      const path = paths[index];
      return path !== undefined && (await Bun.file(resolve(context.root, path)).exists()) ? marker : null;
    }),
  );
  return {
    isShallow: shallow === "true",
    arriving: present.filter((marker): marker is (typeof markers)[number] => marker !== null),
  };
};

/** A blobless (or otherwise filtered) clone: patch ids would need the network. */
export const isPartialClone = async (context: GitContext): Promise<boolean> => {
  const stdout = await gitStdout(context, [
    "config",
    "--get-regexp",
    "^(extensions\\.partialclone|remote\\.origin\\.promisor)$",
  ]);
  return stdout !== null && stdout.length > 0;
};

/**
 * The reader's own email as the commit log spells it: git's own author
 * identity (config, GIT_AUTHOR_EMAIL, or the auto identity), passed through
 * the repo's `.mailmap` exactly like `%aE`. A squash that GitHub wrote under
 * another address is the team's to map there.
 */
export const readOwnEmail = async (context: GitContext): Promise<string | null> => {
  const ident = await gitStdout(context, ["var", "GIT_AUTHOR_IDENT"]);
  const email = ident === null ? undefined : EMAIL_IN_IDENT.exec(ident)?.[1];
  if (email === undefined) {
    return null;
  }
  const mapped = await gitStdout(context, ["check-mailmap", `<${email}>`]);
  return (mapped === null ? undefined : EMAIL_IN_IDENT.exec(mapped)?.[1]) ?? email;
};

export interface MissingAnswer {
  readonly commits: readonly ParsedCommit[];
  /** The query hit its limit: there may be more than it returned. */
  readonly isCapped: boolean;
}

/**
 * Commits on `ref` touching the file that HEAD neither has nor (unless the
 * clone is partial) has an equal of, and that are not the work arriving in
 * a merge or cherry-pick in progress.
 */
export const missingOn = async (
  context: GitContext,
  ref: LandingRef,
  options: { readonly cherryPick: boolean; readonly arriving: readonly string[] },
): Promise<MissingAnswer | null> => {
  const stdout = await gitStdout(context, [
    ...LOG,
    "--no-merges",
    ...(options.cherryPick ? ["--cherry-pick"] : []),
    "--left-only",
    `--format=${COMMIT_FORMAT}`,
    SCANNED,
    `${ref.ref}...HEAD`,
    ...options.arriving.map((marker) => `^${marker}`),
    "--",
    literalPath(context.file),
  ]);
  if (stdout === null) {
    return null;
  }
  const commits = parseCommits(stdout);
  return { commits, isCapped: commits.length >= MAX_LANDED_COMMITS_SCANNED };
};

const blobAt = (context: GitContext, rev: string): Promise<string | null> =>
  gitStdout(context, ["rev-parse", "--verify", "--quiet", `${rev}:${context.file}`]);

/**
 * Nothing an edit could undo: the file on `ref` is byte-identical to HEAD's
 * (a stacked branch, a second squash of the same work), or `ref` made no net
 * change to it since HEAD's branch point (a change and its revert). A file
 * absent on both sides compares equal, which is the same answer.
 */
export const hasNothingNetToUndo = async (context: GitContext, ref: LandingRef): Promise<boolean> => {
  const [onRef, onHead, base] = await Promise.all([
    blobAt(context, ref.ref),
    blobAt(context, "HEAD"),
    gitStdout(context, ["merge-base", ref.ref, "HEAD"]),
  ]);
  if (onRef === onHead) {
    return true;
  }
  return base !== null && FULL_SHA_PATTERN.test(base) && (await blobAt(context, base)) === onRef;
};

/** The landing commits on `ref`'s first-parent line since `since`. */
export const landingsOn = async (
  context: GitContext,
  ref: LandingRef,
  since: Date,
): Promise<readonly LandingCommit[] | null> => {
  const stdout = await gitStdout(context, [
    ...LOG,
    "--first-parent",
    `--since=${since.toISOString()}`,
    `--format=${LANDING_FORMAT}`,
    SCANNED,
    ref.ref,
    "--",
    literalPath(context.file),
  ]);
  return stdout === null
    ? null
    : stdout
        .split("\n")
        .map(parseLandingLine)
        .filter((landing): landing is LandingCommit => landing !== null);
};

/** `ref` as it stood at `before`: the newest first-parent commit that old. */
export const tipAt = async (context: GitContext, ref: LandingRef, before: Date): Promise<string | null> => {
  const stdout = await gitStdout(context, [
    "rev-list",
    "-1",
    "--first-parent",
    `--before=${before.toISOString()}`,
    ref.ref,
  ]);
  return stdout !== null && FULL_SHA_PATTERN.test(stdout) ? stdout : null;
};

/** The changes one landing commit brought in: a merge's side, or itself. */
export const changesLandedBy = async (
  context: GitContext,
  landing: LandingCommit,
): Promise<readonly ParsedCommit[]> => {
  const [firstParent] = landing.parents;
  if (landing.parents.length < 2 || firstParent === undefined) {
    return [landing.itself];
  }
  const stdout = await gitStdout(context, [
    ...LOG,
    "--no-merges",
    `--format=${COMMIT_FORMAT}`,
    SCANNED,
    `${firstParent}..${landing.itself.sha}`,
    "--",
    literalPath(context.file),
  ]);
  return stdout === null ? [] : parseCommits(stdout);
};

/**
 * Was `sha` already on a landing branch before the window opened? One walk:
 * `rev-list --count sha ^tip...` is 0 exactly when some old tip reaches it.
 * Unknown (null) is not "no".
 */
export const landedBefore = async (
  context: GitContext,
  sha: string,
  oldTips: readonly string[],
): Promise<boolean | null> => {
  if (oldTips.length === 0) {
    return false;
  }
  const stdout = await gitStdout(context, ["rev-list", "--count", sha, ...oldTips.map((tip) => `^${tip}`)]);
  return stdout === null ? null : stdout === "0";
};

export const isAncestorOfHead = async (context: GitContext, sha: string): Promise<boolean> =>
  !context.isCancelled() &&
  (await runGitOutcome(["merge-base", "--is-ancestor", sha, "HEAD"], context.root, context.timeoutMs, QUIET_GIT_ENV))
    .ok;
