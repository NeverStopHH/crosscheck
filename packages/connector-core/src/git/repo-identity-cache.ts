/**
 * REPO IDENTITY, CACHED PER WORKING DIRECTORY (batch-2 integration review,
 * M6). Every hook resolved its repo the full way — four git spawns
 * (`--show-toplevel`, the remote, the branch, HEAD) and, for an ssh remote,
 * one `ssh -G` — before it did anything else: 40 ms quiet, 90–108 ms under
 * load (max 355), on every hook, PreToolUse's budget among them.
 *
 * NOW GIT IS ASKED ONCE PER DIRECTORY, and the answer is kept in `cache/`
 * with a STAMP of everything git read to give it, taken from the files
 * alone: the root's `.git` (by inode — a re-clone is another repo), the
 * worktree's git dir, HEAD's content (a checkout is another branch), the
 * repo, worktree, global and XDG git configs and the ssh config (a re-remote
 * or an alias is another id), and the ssh switch. A later hook in the same
 * directory reads the same files; one byte of difference, an entry older
 * than REPO_IDENTITY_CACHE_TTL_MS (an included config file or the system
 * config, which no stamp sees), or a directory between the cwd and the root
 * that became a repository of its own, and git is asked again.
 *
 * HEAD's COMMIT is never cached: it is re-read from the ref files (loose,
 * else `packed-refs`) on every answer, so a commit moves `baseCommit` without
 * git — the same reading git/repo-identity.ts's topic routing already trusts.
 *
 * WHAT THE FILES CANNOT VOUCH FOR IS ALWAYS GIT'S: a detached HEAD (git picks
 * its short-sha length), an unborn branch, a reftable repository (its HEAD
 * file is a placeholder), and any environment that steers git's discovery or
 * config (GIT_DIR and its kin — git/git.ts hands git the process environment
 * whole). An entry is written only when the files say exactly what git just
 * said — the branch HEAD names and the commit it resolves to — so the files
 * are never trusted for a repo where they disagree with git.
 *
 * Fail open: an unreadable or unwritable cache is a full resolution, never an
 * error; nothing here can make a hook resolve a repo git would not.
 */
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { z } from "zod";

import { REPO_IDENTITY_CACHE_TTL_MS, SSH_CANONICALIZE_ENV } from "../constants.ts";
import { readJsonOrNull, repoIdentityCachePath, writePrivateFile } from "../config/paths.ts";
import { branchLabelOfHead, commonDirOf, readHeadFile, resolveHeadCommit, resolveRepoIdentity } from "./repo-identity.ts";
import type { HeadFile, RepoIdentity } from "./repo-identity.ts";

const CACHE_VERSION = 1;

/** A HEAD the files can name a branch for: a symbolic ref to a local branch. */
const LOCAL_BRANCH_HEAD = "ref: refs/heads/";

/**
 * The variables that move what git discovers or which configuration it
 * reads. With any of them set, the files this module reads are not the ones
 * git reads, and git answers every time.
 */
const GIT_STEERING_ENV: readonly string[] = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
];

const IdentityCacheSchema = z.object({
  version: z.literal(CACHE_VERSION),
  stamp: z.string().min(1),
  at: z.number(),
  identity: z.object({
    repoId: z.string().min(1),
    root: z.string().min(1),
    branch: z.string().min(1),
    baseCommit: z.string().min(1),
  }),
});

type Env = Readonly<Record<string, string | undefined>>;

export interface RepoIdentityCacheOptions {
  /** The full resolution; tests count it. Default: git/repo-identity.ts. */
  readonly resolve?: (cwd: string) => Promise<RepoIdentity | null>;
  /** Default: Date.now. */
  readonly now?: () => number;
  /** The environment git runs under. Default: this process's, which git/git.ts hands git whole. */
  readonly gitEnv?: Env;
}

/** What the files say about a root now, with no git: HEAD, its commit, and the stamp of what names the repo. */
interface RootFacts {
  readonly head: HeadFile;
  readonly commit: string;
  readonly stamp: string;
}

/** Whether git, run under `env`, would read other files than the ones a stamp reads. */
export const isGitSteered = (env: Env): boolean => GIT_STEERING_ENV.some((name) => env[name] !== undefined);

/** A file as a stamp: which file it is and how it last changed — or that it is not there. */
export const fileStamp = async (path: string): Promise<string> => {
  try {
    const info = await stat(path);
    return `${String(info.ino)}:${String(info.size)}:${String(info.mtimeMs)}`;
  } catch {
    return "-";
  }
};

/**
 * The `.git` entry by identity only: a main checkout's `.git` directory
 * changes its mtime on every index write, which says nothing about the
 * repo's name — a re-clone at the same path is a new inode.
 */
const gitEntryStamp = async (root: string): Promise<string> => {
  try {
    const info = await stat(join(root, ".git"));
    return `${String(info.ino)}:${info.isDirectory() ? "d" : "f"}`;
  } catch {
    return "-";
  }
};

/** The git config files a repo's answers depend on: its own, its worktree's, the user's two. */
export const gitConfigPaths = (gitDir: string, commonDir: string, env: Env): readonly string[] => {
  const home = env["HOME"] ?? homedir();
  const xdg = env["XDG_CONFIG_HOME"] ?? join(home, ".config");
  return [join(commonDir, "config"), join(gitDir, "config.worktree"), join(home, ".gitconfig"), join(xdg, "git", "config")];
};

/** Every config file that can name, rewrite or alias the remote git resolved. */
const configPaths = (head: HeadFile, commonDir: string, env: Env): readonly string[] => [
  ...gitConfigPaths(head.gitDir, commonDir, env),
  join(env["HOME"] ?? homedir(), ".ssh", "config"),
];

const rootFacts = async (root: string, env: Env): Promise<RootFacts | null> => {
  const head = await readHeadFile(root);
  if (head === null || !head.content.startsWith(LOCAL_BRANCH_HEAD)) {
    return null;
  }
  const [commonDir, commit] = await Promise.all([commonDirOf(head.gitDir), resolveHeadCommit(head)]);
  if (commit === null) {
    return null;
  }
  const stamps = await Promise.all([gitEntryStamp(root), ...configPaths(head, commonDir, env).map(fileStamp)]);
  return {
    head,
    commit,
    stamp: JSON.stringify([root, head.gitDir, head.content, env[SSH_CANONICALIZE_ENV] ?? "", ...stamps]),
  };
};

/**
 * Whether `root` is still the repository that governs `cwd`: the cwd is the
 * root or inside it, and no directory between them has become a repository
 * of its own since.
 */
const isGovernedBy = async (cwd: string, root: string): Promise<boolean> => {
  const physical = await realpath(cwd).catch(() => null);
  if (physical === null || (physical !== root && !physical.startsWith(`${root}${sep}`))) {
    return false;
  }
  const between: string[] = [];
  for (let dir = physical; dir !== root && dir.length > root.length; dir = dirname(dir)) {
    between.push(dir);
  }
  const entries = await Promise.all(between.map((dir) => fileStamp(join(dir, ".git"))));
  return entries.every((entry) => entry === "-");
};

const readCached = async (home: string, cwd: string, env: Env, nowMs: number): Promise<RepoIdentity | null> => {
  const parsed = IdentityCacheSchema.safeParse(await readJsonOrNull(repoIdentityCachePath(home, cwd)));
  if (!parsed.success) {
    return null;
  }
  const { identity, stamp, at } = parsed.data;
  const ageMs = nowMs - at;
  if (!(ageMs >= 0 && ageMs < REPO_IDENTITY_CACHE_TTL_MS) || !(await isGovernedBy(cwd, identity.root))) {
    return null;
  }
  const facts = await rootFacts(identity.root, env);
  return facts === null || facts.stamp !== stamp ? null : { ...identity, baseCommit: facts.commit };
};

/** Kept only when the files say exactly what git just said: the branch HEAD names and the commit it resolves to. */
const remember = async (home: string, cwd: string, identity: RepoIdentity, env: Env, nowMs: number): Promise<void> => {
  const facts = await rootFacts(identity.root, env);
  const isFaithful =
    facts !== null &&
    branchLabelOfHead(facts.head.content) === identity.branch &&
    facts.commit === identity.baseCommit &&
    (await isGovernedBy(cwd, identity.root));
  if (facts === null || !isFaithful) {
    return;
  }
  await writePrivateFile(
    repoIdentityCachePath(home, cwd),
    `${JSON.stringify({ version: CACHE_VERSION, stamp: facts.stamp, at: nowMs, identity })}\n`,
  ).catch(() => undefined);
};

/**
 * `resolveRepoIdentity(cwd)`, answered from `home`'s cache while the files
 * vouch for it (the header says when). Null outside a repository, exactly
 * as git says it; a null is never cached.
 */
export const resolveRepoIdentityCached = async (
  home: string,
  cwd: string,
  options: RepoIdentityCacheOptions = {},
): Promise<RepoIdentity | null> => {
  const resolve = options.resolve ?? ((dir: string) => resolveRepoIdentity(dir));
  const env = options.gitEnv ?? process.env;
  const nowMs = (options.now ?? Date.now)();
  if (isGitSteered(env)) {
    return resolve(cwd);
  }
  const cached = await readCached(home, cwd, env, nowMs).catch(() => null);
  if (cached !== null) {
    return cached;
  }
  const identity = await resolve(cwd);
  if (identity !== null) {
    await remember(home, cwd, identity, env, nowMs).catch(() => undefined);
  }
  return identity;
};
