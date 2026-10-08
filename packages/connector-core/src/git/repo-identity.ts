import { NO_COMMIT_SHA } from "@crosscheck/schema";

import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";

import { DETACHED_LABEL_SHA_CHARS, LOCAL_REPO_HASH_CHARS } from "../constants.ts";
import { DETACHED_BRANCH_PREFIX, UNNAMED_HEAD_BRANCH } from "./detached-branch.ts";
import { runGit } from "./git.ts";
import { resolveSshHostname } from "./ssh-hostname.ts";
import type { SshHostnameResolver } from "./ssh-hostname.ts";

export interface RepoIdentity {
  readonly repoId: string;
  readonly root: string;
  readonly branch: string;
  readonly baseCommit: string;
}

const SCHEME_PATTERN = /^(?:https?|ssh|git|git\+ssh):\/\//i;
const USERINFO_PATTERN = /^[^/@]+@/;
const PORT_PATTERN = /^([^/:]+):(\d+)(\/.*)?$/;
const SCP_PATTERN = /^([^/:]+):(.+)$/;

/**
 * Identity by remote, not by path (DESIGN.md §3). Path case is lowercased
 * deliberately: forge case-insensitivity plus remote-typo tolerance is worth
 * more than distinguishing two repos that differ only in case.
 */
export const normalizeRemoteUrl = (raw: string): string | null => {
  const withoutScheme = raw
    .trim()
    .replace(/\/+$/, "")
    .replace(SCHEME_PATTERN, "");
  const withoutUserinfo = withoutScheme.replace(USERINFO_PATTERN, "");

  const portMatch = PORT_PATTERN.exec(withoutUserinfo);
  const scpMatch = portMatch === null ? SCP_PATTERN.exec(withoutUserinfo) : null;
  const hostAndPath =
    portMatch !== null
      ? `${portMatch[1]}${portMatch[3] ?? ""}`
      : scpMatch !== null
        ? `${scpMatch[1]}/${scpMatch[2]}`
        : withoutUserinfo;

  const normalized = hostAndPath
    .replace(/\.git$/i, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
  return normalized.length === 0 ? null : normalized;
};

/** ssh-shaped by scheme; a bare scp-like `[user@]host:path` is ssh too. */
const SSH_SCHEME_PATTERN = /^(?:ssh|git\+ssh):\/\//i;

/** ANY url scheme at all — a remote carrying one is never scp-shaped. */
const ANY_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The LITERAL host of an ssh-shaped remote, pre-normalization — the token a
 * user's ssh config would match. Null for anything ssh config cannot touch:
 * every non-ssh url scheme (http(s)/git:// hosts are DNS names; file:// and
 * the rest have no host for ssh at all), local and Windows drive-letter
 * paths, and anything unparseable. Null means the caller never spawns
 * `ssh -G` for it — before the scheme check was generalized, `file:///…`
 * read as scp host "file" and every resolution paid one wasted bounded
 * spawn.
 */
export const sshHostOf = (raw: string): string | null => {
  const trimmed = raw.trim();
  const isSshUrl = SSH_SCHEME_PATTERN.test(trimmed);
  if (!isSshUrl && ANY_SCHEME_PATTERN.test(trimmed)) {
    return null;
  }
  const withoutScheme = trimmed.replace(SCHEME_PATTERN, "");
  const withoutUserinfo = withoutScheme.replace(USERINFO_PATTERN, "");
  if (isSshUrl) {
    const host = /^[^/:]+/.exec(withoutUserinfo)?.[0] ?? "";
    return host.length === 0 ? null : host;
  }
  const scpMatch = SCP_PATTERN.exec(withoutUserinfo);
  const host = scpMatch?.[1] ?? "";
  // A one-character "host" is a Windows drive letter (C:\repo), not a host.
  return host.length <= 1 ? null : host;
};

/**
 * The raw remote with its literal ssh host replaced by the canonical one.
 * Index-based, not a string replace: after stripping the scheme and userinfo
 * prefixes the remainder STARTS with the host by construction (sshHostOf
 * derived it as exactly that prefix), so the splice can never touch a host
 * lookalike inside the path or the userinfo.
 */
const withCanonicalHost = (
  raw: string,
  literalHost: string,
  canonicalHost: string,
): string => {
  const trimmed = raw.trim();
  const afterScheme = trimmed.replace(SCHEME_PATTERN, "");
  const afterUserinfo = afterScheme.replace(USERINFO_PATTERN, "");
  const hostStart = trimmed.length - afterUserinfo.length;
  return (
    trimmed.slice(0, hostStart) +
    canonicalHost +
    trimmed.slice(hostStart + literalHost.length)
  );
};

/**
 * A resolved host that IS the literal host, or a subdomain of it, is a
 * TRANSPORT override, not an identity: the vendors' own documented
 * port-22-firewall workarounds map `github.com` -> `ssh.github.com` and
 * `gitlab.com` -> `altssh.gitlab.com`, and rewriting the repo id to the
 * transport host would fork it away from every plain teammate — the exact
 * silent-mismatch F5 exists to KILL, and one a firewalled remote teammate is
 * FAR likelier to hit than a multi-account alias. A genuine alias
 * (`github.com-toandiep`) resolves to an UNRELATED host and is not caught here,
 * so it still canonicalizes. Dot-boundary endsWith so `evilgithub.com` is not
 * mistaken for a subdomain of `github.com`.
 */
const isTransportVariant = (literalHost: string, resolvedHost: string): boolean => {
  const literal = literalHost.toLowerCase();
  const resolved = resolvedHost.toLowerCase();
  return resolved === literal || resolved.endsWith(`.${literal}`);
};

/**
 * An ssh-shaped remote with its alias resolved through the user's own ssh
 * config; every other remote — and every resolution failure — passes through
 * untouched. See git/ssh-hostname.ts for the incident and the migration
 * story. Case-insensitive comparison because ssh lowercases what it echoes.
 * A transport-only HostName override (the forge's port-443 workaround) is
 * detected and left as the literal host — see isTransportVariant.
 */
export const canonicalizeSshRemote = async (
  raw: string,
  resolveHost: SshHostnameResolver,
): Promise<string> => {
  const literalHost = sshHostOf(raw);
  if (literalHost === null) {
    return raw;
  }
  const canonicalHost = await resolveHost(literalHost).catch(() => null);
  if (
    canonicalHost === null ||
    canonicalHost.length === 0 ||
    isTransportVariant(literalHost, canonicalHost)
  ) {
    return raw;
  }
  return withCanonicalHost(raw, literalHost, canonicalHost);
};

const sha256Hex = (input: string): string =>
  new Bun.CryptoHasher("sha256").update(input).digest("hex");

/**
 * Hash only. The seed contains a local checkout path, and this id is uploaded,
 * returned by /api/presence and /api/work-contexts and rendered in teammates'
 * briefings — so the path may shape the id but must never be readable from it.
 */
const localRepoId = (seed: string): string =>
  `local:${sha256Hex(seed).slice(0, LOCAL_REPO_HASH_CHARS)}`;

const firstRemoteName = async (cwd: string): Promise<string | null> => {
  const listed = await runGit(["remote"], cwd);
  if (listed === null) {
    return null;
  }
  const names = listed
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .sort();
  return names[0] ?? null;
};

const resolveRemoteUrl = async (cwd: string): Promise<string | null> => {
  const origin = await runGit(["remote", "get-url", "origin"], cwd);
  if (origin !== null) {
    return origin;
  }
  const fallbackName = await firstRemoteName(cwd);
  if (fallbackName === null || fallbackName === "origin") {
    return null;
  }
  return runGit(["remote", "get-url", fallbackName], cwd);
};

/** `--git-common-dir` so every worktree of one repo resolves to the same place. */
const resolveCommonDir = async (cwd: string): Promise<string | null> => {
  const commonDir = await runGit(["rev-parse", "--git-common-dir"], cwd);
  if (commonDir === null) {
    return null;
  }
  const absolute = isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
};

/**
 * Both halves of a local id must be worktree-stable, so they come from the MAIN
 * checkout (parent of the common git dir), not the current worktree.
 */
const resolveMainCheckout = (root: string, commonDir: string | null): string =>
  commonDir === null || basename(commonDir) !== ".git"
    ? root
    : dirname(commonDir);

/**
 * The root commit alone collides: two developers scaffolding from the same
 * template share it, and their unrelated repos would merge into one presence
 * space. The main checkout path disambiguates them inside the hash and is
 * identical across every worktree of one repo, so worktree sharing survives.
 */
const resolveLocalRepoId = async (
  cwd: string,
  root: string,
): Promise<string> => {
  const commonDir = await resolveCommonDir(cwd);
  const mainCheckout = resolveMainCheckout(root, commonDir);
  const rootCommits = await runGit(["rev-list", "--max-parents=0", "HEAD"], cwd);
  const rootCommit = rootCommits?.split("\n").at(-1)?.trim() ?? "";
  return localRepoId(`${rootCommit}\n${mainCheckout}`);
};

/**
 * What `baseCommit` is when git could not name HEAD at all — an unborn branch,
 * a repository with no commits, a git that did not answer.
 *
 * Re-exported from `@crosscheck/schema` rather than declared here: the HUB has
 * to recognise the placeholder to refuse binding a claim to it, and the hub
 * cannot import this package. One literal, two readers.
 */
export { NO_COMMIT_SHA };

/**
 * The branch label of a detached HEAD: this prefix plus git's own `--short`
 * sha (git picks the unambiguous length — 9 in a large monorepo, 7 in a
 * small one). ONE spelling, exported, so the session-start title builder
 * (flows/work-context-title.ts) can recognize a detached session from the
 * identity alone and never re-runs git in the per-hook path that computes
 * this. Declared in git/detached-branch.ts, which has no imports, so the
 * render layer can recognize a detached session without importing git.
 */
export { DETACHED_BRANCH_PREFIX };

/**
 * A ROOT'S HEAD, READ FROM THE FILE — the topic a touch belongs to, at the
 * cost of two small reads and no git (capture/touched-root.ts).
 *
 * WHY NOT GIT. Every tool call of a session can land in a different sibling
 * worktree, and each of those can switch branches between two calls. Asking
 * git there is 5-10 ms of spawn per touch on the hook's hot path; the HEAD
 * file says the same thing in microseconds. Git is still what answers a root
 * this session has never seen (its repo id), once — a cache miss.
 *
 * `content` IS THE STAMP: a later touch that reads the same bytes knows the
 * branch already, and one that reads different bytes has seen a checkout.
 */
export interface HeadFile {
  /** The HEAD file's trimmed content: `ref: refs/heads/x`, or a commit id. */
  readonly content: string;
  /** `feat/x`, or `detached@<sha>` for a detached HEAD. */
  readonly branch: string;
  /** The per-worktree git dir the HEAD file lives in. */
  readonly gitDir: string;
}

const SYMBOLIC_REF_PREFIX = "ref: ";
const HEADS_PREFIX = "refs/heads/";
const REFS_PREFIX = "refs/";
const GITDIR_PREFIX = "gitdir: ";
/** SHA-1 or SHA-256, as git writes a detached HEAD: lower-case hex, nothing else. */
const COMMIT_ID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/**
 * What a REFTABLE repository's HEAD file always says (review M3): the real
 * HEAD lives in the reftable, and the file is a placeholder older tools read
 * as a broken branch. `.invalid` can never be a branch — git refuses a ref
 * component that starts with a dot.
 */
const REFTABLE_HEAD_PLACEHOLDER = "refs/heads/.invalid";

/**
 * The branch a HEAD file names: the short name of a `refs/heads/` ref, the
 * whole ref otherwise, and `detached@<sha>` for a bare commit id — never a
 * branch that merely points at the same commit (flows/work-context-title.ts
 * says why that guess was wrong). Null for content that is neither, and for a
 * reftable repository's placeholder — the files cannot tell its branch, and
 * reading it as one would make one `.invalid` topic of every branch.
 */
export const branchLabelOfHead = (content: string): string | null => {
  if (content.startsWith(SYMBOLIC_REF_PREFIX)) {
    const ref = content.slice(SYMBOLIC_REF_PREFIX.length).trim();
    if (ref.length === 0 || ref === REFTABLE_HEAD_PLACEHOLDER) {
      return null;
    }
    return ref.startsWith(HEADS_PREFIX) ? ref.slice(HEADS_PREFIX.length) : ref;
  }
  return COMMIT_ID_PATTERN.test(content)
    ? `${DETACHED_BRANCH_PREFIX}${content.slice(0, DETACHED_LABEL_SHA_CHARS)}`
    : null;
};

const readTrimmed = async (path: string): Promise<string | null> => {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return null;
  }
};

/** `.git` itself for a checkout; the `gitdir:` line of a linked worktree's `.git` file. */
export const gitDirOf = async (root: string): Promise<string | null> => {
  const entry = join(root, ".git");
  const stats = await stat(entry).catch(() => null);
  if (stats === null) {
    return null;
  }
  if (stats.isDirectory()) {
    return entry;
  }
  const pointer = await readTrimmed(entry);
  if (pointer === null || !pointer.startsWith(GITDIR_PREFIX)) {
    return null;
  }
  const dir = pointer.slice(GITDIR_PREFIX.length).trim();
  return isAbsolute(dir) ? dir : resolve(root, dir);
};

/**
 * The root's HEAD, or null when it cannot be read — no `.git`, a pointer to
 * nowhere, a HEAD that names neither a ref nor a commit. Null is UNKNOWN:
 * the caller files the touch under the session's own context.
 */
export const readHeadFile = async (root: string): Promise<HeadFile | null> => {
  const gitDir = await gitDirOf(root);
  if (gitDir === null) {
    return null;
  }
  const content = await readTrimmed(join(gitDir, "HEAD"));
  const branch = content === null ? null : branchLabelOfHead(content);
  return content === null || branch === null ? null : { content, branch, gitDir };
};

/** A git dir whose refs and reflogs live in the reftable — its HEAD file is the placeholder (review M3). */
export const isReftableGitDir = async (gitDir: string): Promise<boolean> =>
  (await readTrimmed(join(gitDir, "HEAD"))) === `${SYMBOLIC_REF_PREFIX}${REFTABLE_HEAD_PLACEHOLDER}`;

/** The shared git dir a linked worktree's refs live in — its `commondir` file, or the git dir itself. */
export const commonDirOf = async (gitDir: string): Promise<string> => {
  const pointer = await readTrimmed(join(gitDir, "commondir"));
  if (pointer === null || pointer.length === 0) {
    return gitDir;
  }
  return isAbsolute(pointer) ? pointer : resolve(gitDir, pointer);
};

/** A ref git itself could have written: under `refs/`, no `..` to walk out of the git dir. */
const isPlainRef = (ref: string): boolean =>
  ref.startsWith(REFS_PREFIX) && !ref.split("/").includes("..");

/**
 * THE COMMIT A HEAD NAMES, still without git: the id itself when detached,
 * else the loose ref file, else its `packed-refs` line. Null for an unborn
 * branch or a ref none of those hold — the caller then carries no base
 * commit rather than a guessed one.
 */
export const resolveHeadCommit = async (head: HeadFile): Promise<string | null> => {
  if (!head.content.startsWith(SYMBOLIC_REF_PREFIX)) {
    return COMMIT_ID_PATTERN.test(head.content) ? head.content : null;
  }
  return resolveRefCommit(head.gitDir, head.content.slice(SYMBOLIC_REF_PREFIX.length).trim());
};

/**
 * The commit a ref names, from git's files: the loose ref in the worktree's
 * own git dir or the shared one, else its `packed-refs` line. Null for a ref
 * that names nothing — which is how a RENAMED branch's old name reads
 * (flows/topic-rules.ts, rule b).
 */
export const resolveRefCommit = async (gitDir: string, ref: string): Promise<string | null> => {
  if (!isPlainRef(ref)) {
    return null;
  }
  const commonDir = await commonDirOf(gitDir);
  for (const dir of [gitDir, commonDir]) {
    const loose = await readTrimmed(join(dir, ref));
    if (loose !== null && COMMIT_ID_PATTERN.test(loose)) {
      return loose;
    }
  }
  const packed = (await readTrimmed(join(commonDir, "packed-refs"))) ?? "";
  const line = packed.split("\n").find((entry) => entry.endsWith(` ${ref}`));
  const id = line?.slice(0, line.indexOf(" ")) ?? "";
  return COMMIT_ID_PATTERN.test(id) ? id : null;
};

const resolveBranch = async (cwd: string): Promise<string> => {
  const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (branch === null) {
    return UNNAMED_HEAD_BRANCH;
  }
  if (branch !== "HEAD") {
    return branch;
  }
  const shortSha = await runGit(["rev-parse", "--short", "HEAD"], cwd);
  return shortSha === null ? UNNAMED_HEAD_BRANCH : `${DETACHED_BRANCH_PREFIX}${shortSha}`;
};

/**
 * Returns null outside a git repo — every hook then silently no-ops.
 * `resolveHost` is injectable for tests; the default asks the user's own ssh
 * config (bounded, fail-open) so an ssh ALIAS in the remote cannot fork the
 * repo's identity across machines (git/ssh-hostname.ts).
 */
export const resolveRepoIdentity = async (
  cwd: string,
  resolveHost: SshHostnameResolver = (host) => resolveSshHostname(host, cwd),
): Promise<RepoIdentity | null> => {
  const root = await runGit(["rev-parse", "--show-toplevel"], cwd);
  if (root === null) {
    return null;
  }
  const remoteUrl = await resolveRemoteUrl(cwd);
  const canonicalRemote =
    remoteUrl === null ? null : await canonicalizeSshRemote(remoteUrl, resolveHost);
  const fromRemote =
    canonicalRemote === null ? null : normalizeRemoteUrl(canonicalRemote);
  const repoId = fromRemote ?? (await resolveLocalRepoId(cwd, root));
  return {
    repoId,
    root,
    branch: await resolveBranch(cwd),
    baseCommit: (await runGit(["rev-parse", "HEAD"], cwd)) ?? NO_COMMIT_SHA,
  };
};
