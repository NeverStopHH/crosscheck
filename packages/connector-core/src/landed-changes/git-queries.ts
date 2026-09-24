/**
 * The git questions the landed-change probe asks (landed-changes/probe.ts),
 * one function each, and the parsing of their answers.
 *
 * QUIET GIT. The default runner (`quietGitRunner`) adds GIT_NO_LAZY_FETCH=1
 * (a blobless partial clone must never fetch from the network inside a hook;
 * git before 2.44 ignores it, which is why partial clones also skip
 * `--cherry-pick`, the one flag here that needs blobs), GIT_TERMINAL_PROMPT=0
 * (no credential prompt can hold the hook) and GIT_OPTIONAL_LOCKS=0 (a read
 * never contends with the developer's own git). Every call is bounded,
 * answers null for any failure, and is skipped once the deadline has passed.
 *
 * PINNED REVISIONS. Every question names the commits the probe read once, at
 * its start — HEAD's sha, each landing branch's tip — never `HEAD` or a ref
 * name again, so a git operation running at the same moment cannot make one
 * answer describe two states of the repo.
 *
 * NUL-SEPARATED FIELDS. Git names and subjects cannot carry a NUL, so no
 * author name, mailmap entry or subject can shift a field and hide its own
 * commit.
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

/** Runs one git command in the probe's worktree: stdout, or null for any failure. */
export type GitRunner = (args: readonly string[]) => Promise<string | null>;

export const quietGitRunner =
  (root: string, timeoutMs: number): GitRunner =>
  async (args) => {
    const outcome = await runGitOutcome(args, root, timeoutMs, QUIET_GIT_ENV);
    return outcome.ok ? outcome.stdout : null;
  };

export interface GitContext {
  readonly root: string;
  /** Repo-relative, as git names it. */
  readonly file: string;
  readonly run: GitRunner;
  /** True once the probe's deadline has passed: no further git is spawned. */
  readonly isCancelled: () => boolean;
}

export const gitStdout = (context: GitContext, args: readonly string[]): Promise<string | null> =>
  context.isCancelled() ? Promise.resolve(null) : context.run(args);

const FIELD = "\x00";
/** full sha, short sha, author, email, committer time, subject */
const COMMIT_FORMAT = "%H%x00%h%x00%aN%x00%aE%x00%ct%x00%s";
const COMMIT_FIELDS = 6;
/** The landing commit's full sha and parents, then COMMIT_FORMAT for itself. */
const LANDING_FORMAT = `%H%x00%P%x00${COMMIT_FORMAT}`;
const LANDING_PREFIX_FIELDS = 2;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const EPOCH_SECONDS_PATTERN = /^\d+$/;
const EMAIL_IN_CONTACT = /<([^<>]*)>/;
/** `Name <email> 1727000000 +0200` → `Name <email>`. */
const IDENT_TIMESTAMP = /\s+\d+\s+[+-]\d{4}$/;
/** A developer's own config must neither break nor rescue the parse. */
const LOG = ["log", "--no-show-signature", "--no-color"] as const;
const SCANNED = `--max-count=${String(MAX_LANDED_COMMITS_SCANNED)}`;

/** The file as a pathspec: literally, never as a glob or a `:` magic. */
const literalPath = (file: string): string => `:(literal)${file}`;

export const isFullSha = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && FULL_SHA_PATTERN.test(value);

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
  const [sha = "", shortSha = "", authorName = "", authorEmail = "", time = "", subject = ""] = fields;
  const committedAt = toDate(time);
  if (fields.length !== COMMIT_FIELDS || !isFullSha(sha) || committedAt === null) {
    return null;
  }
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
  return itself === null ? null : { parents: parents.split(" ").filter(isFullSha), itself };
};

export interface RepoState {
  /** A shallow clone's boundary commit "touches" every path: unreadable. */
  readonly isShallow: boolean;
  readonly headSha: string;
  /** MERGE_HEAD's commits while a merge is in progress — their work is arriving. */
  readonly mergeHeads: readonly string[];
  /** A cherry-pick in progress: exactly this ONE commit is arriving. */
  readonly pickedSha: string | null;
}

const readMarker = async (root: string, path: string | undefined): Promise<readonly string[]> => {
  if (path === undefined) {
    return [];
  }
  const file = Bun.file(resolve(root, path));
  return (await file.exists())
    ? (await file.text())
        .split("\n")
        .map((line) => line.trim())
        .filter(isFullSha)
    : [];
};

/** One call: shallowness, HEAD, and where the in-progress markers would be. */
export const readRepoState = async (context: GitContext): Promise<RepoState | null> => {
  const stdout = await gitStdout(context, [
    "rev-parse",
    "--is-shallow-repository",
    "HEAD",
    "--git-path",
    "MERGE_HEAD",
    "--git-path",
    "CHERRY_PICK_HEAD",
  ]);
  const [shallow, headSha, mergePath, pickPath] = stdout?.split("\n") ?? [];
  if (!isFullSha(headSha)) {
    return null;
  }
  const [mergeHeads, picked] = await Promise.all([
    readMarker(context.root, mergePath),
    readMarker(context.root, pickPath),
  ]);
  return { isShallow: shallow === "true", headSha, mergeHeads, pickedSha: picked[0] ?? null };
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
 * identity (config, GIT_AUTHOR_EMAIL, or the auto identity) — name AND email,
 * since a mailmap entry may key on both — passed through the repo's
 * `.mailmap` exactly like `%aE`. A squash that GitHub wrote under another
 * address is the team's to map there.
 */
export const readOwnEmail = async (context: GitContext): Promise<string | null> => {
  const ident = await gitStdout(context, ["var", "GIT_AUTHOR_IDENT"]);
  const contact = ident?.replace(IDENT_TIMESTAMP, "");
  const email = contact === undefined ? undefined : EMAIL_IN_CONTACT.exec(contact)?.[1];
  if (contact === undefined || email === undefined) {
    return null;
  }
  const mapped = await gitStdout(context, ["check-mailmap", contact]);
  return (mapped === null ? undefined : EMAIL_IN_CONTACT.exec(mapped)?.[1]) ?? email;
};

export interface MissingAnswer {
  readonly commits: readonly ParsedCommit[];
  /** The query hit its limit: there may be more than it returned. */
  readonly isCapped: boolean;
}

export interface MissingQuery {
  readonly cherryPick: boolean;
  readonly headSha: string;
  /** Commits whose whole ancestry is excluded inside git — a merge's heads. */
  readonly exclude?: readonly string[];
  /** Commits git returns at most; "possibly more" is measured against it. */
  readonly limit?: number;
}

/**
 * Commits on `ref` touching the file that HEAD neither has nor (unless the
 * clone is partial) has an equal of — and, with `exclude`, that no excluded
 * commit reaches either, so the limit is spent only on what can still be
 * missing.
 */
export const missingOn = async (
  context: GitContext,
  ref: LandingRef,
  query: MissingQuery,
): Promise<MissingAnswer | null> => {
  const limit = query.limit ?? MAX_LANDED_COMMITS_SCANNED;
  const stdout = await gitStdout(context, [
    ...LOG,
    "--no-merges",
    ...(query.cherryPick ? ["--cherry-pick"] : []),
    "--left-only",
    `--format=${COMMIT_FORMAT}`,
    `--max-count=${String(limit)}`,
    `${ref.tip}...${query.headSha}`,
    ...(query.exclude ?? []).map((sha) => `^${sha}`),
    "--",
    literalPath(context.file),
  ]);
  if (stdout === null) {
    return null;
  }
  const commits = parseCommits(stdout);
  return { commits, isCapped: commits.length >= limit };
};

/**
 * While a merge is in progress: the commits on `ref` touching the file that
 * neither HEAD nor any MERGE_HEAD reaches — what will STILL be missing once
 * the merge the reader is resolving is done. Everything MERGE_HEAD reaches is
 * arriving with it, so excluding its ancestry is right here (and wrong for a
 * cherry-pick, which brings exactly one commit).
 */
export const stillMissingAfterMerge = async (
  context: GitContext,
  ref: LandingRef,
  state: RepoState,
): Promise<ReadonlySet<string> | null> => {
  const stdout = await gitStdout(context, [
    "rev-list",
    ref.tip,
    `^${state.headSha}`,
    ...state.mergeHeads.map((sha) => `^${sha}`),
    "--",
    literalPath(context.file),
  ]);
  return stdout === null ? null : new Set(stdout.split("\n").filter(isFullSha));
};

/** The file at a revision: its blob, known absent, or unknown. */
export type FileAtRev =
  | { readonly kind: "blob"; readonly id: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown" };

/**
 * `ls-tree`, not `rev-parse <rev>:<file>`: an empty answer from ls-tree is a
 * file that is not there, and a failure is a git that did not answer — two
 * things rev-parse reports identically, and "both absent" must never be
 * inferred from "both timed out". The path is literal, so a name like
 * `:colon.ts` is a file, not pathspec magic.
 */
export const fileAt = async (context: GitContext, rev: string): Promise<FileAtRev> => {
  const stdout = await gitStdout(context, ["ls-tree", rev, "--", literalPath(context.file)]);
  if (stdout === null) {
    return { kind: "unknown" };
  }
  const id = stdout.split(/\s+/)[2];
  return stdout.length === 0 ? { kind: "absent" } : isFullSha(id) ? { kind: "blob", id } : { kind: "unknown" };
};

export const isSameContent = (a: FileAtRev, b: FileAtRev): boolean =>
  (a.kind === "absent" && b.kind === "absent") || (a.kind === "blob" && b.kind === "blob" && a.id === b.id);

/** Does anyone but the reader have a commit to the file between `base` and HEAD? */
const othersOnReaderSide = async (
  context: GitContext,
  range: { readonly base: string; readonly headSha: string },
  selfEmail: string | null,
): Promise<boolean | null> => {
  const stdout = await gitStdout(context, [
    ...LOG,
    "--format=%aE",
    `${range.base}..${range.headSha}`,
    "--",
    literalPath(context.file),
  ]);
  const self = selfEmail?.toLowerCase() ?? null;
  return stdout === null
    ? null
    : stdout
        .split("\n")
        .filter((email) => email.length > 0)
        .some((email) => email.toLowerCase() !== self);
};

/**
 * Nothing an edit could undo, known for certain:
 *
 *   1. the file on `ref` is byte-identical to HEAD's (a stacked branch, a
 *      second squash of the same work) — nothing on `ref` differs, so nothing
 *      of it can be undone;
 *   2. `ref` made no net change to the file since HEAD's branch point (a
 *      change and its revert) AND nobody but the reader touched the file on
 *      HEAD's side. The second half is what makes rule 2 safe: a branch that
 *      carries a teammate's work which `ref` has since REVERTED would bring
 *      that work back, and that is exactly the change this feature exists to
 *      stop.
 *
 * Unknown is never "nothing to undo".
 */
export const hasNothingNetToUndo = async (
  context: GitContext,
  ref: LandingRef,
  options: { readonly headSha: string; readonly selfEmail: string | null },
): Promise<boolean> => {
  const [onRef, onHead, base] = await Promise.all([
    fileAt(context, ref.tip),
    fileAt(context, options.headSha),
    gitStdout(context, ["merge-base", ref.tip, options.headSha]),
  ]);
  if (isSameContent(onRef, onHead)) {
    return true;
  }
  if (!isFullSha(base)) {
    return false;
  }
  const [onBase, others] = await Promise.all([
    fileAt(context, base),
    othersOnReaderSide(context, { base, headSha: options.headSha }, options.selfEmail),
  ]);
  return isSameContent(onBase, onRef) && others === false;
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
    ref.tip,
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

/**
 * `ref` as it stood at `before`: the newest first-parent commit that old.
 * Null both when there is none (a branch born inside the window) and when git
 * did not answer; the caller tells them apart by `isAnswered`.
 */
export const tipAt = async (
  context: GitContext,
  ref: LandingRef,
  before: Date,
): Promise<{ readonly isAnswered: boolean; readonly tip: string | null }> => {
  const stdout = await gitStdout(context, [
    "rev-list",
    "-1",
    "--first-parent",
    `--before=${before.toISOString()}`,
    ref.tip,
  ]);
  return { isAnswered: stdout !== null, tip: isFullSha(stdout) ? stdout : null };
};

/** The changes one landing commit brought in — a merge's side, or itself — or null. */
export const changesLandedBy = async (
  context: GitContext,
  landing: LandingCommit,
): Promise<readonly ParsedCommit[] | null> => {
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
  return stdout === null ? null : parseCommits(stdout);
};

/**
 * Is `sha` reachable from any of `from`? One walk: `rev-list --count sha
 * ^from...` is 0 exactly when some `from` reaches it. Null when git did not
 * answer — never "no".
 */
export const isReachableFromAny = async (
  context: GitContext,
  sha: string,
  from: readonly string[],
): Promise<boolean | null> => {
  if (from.length === 0) {
    return false;
  }
  const stdout = await gitStdout(context, ["rev-list", "--count", sha, ...from.map((tip) => `^${tip}`)]);
  return stdout === null ? null : stdout === "0";
};
