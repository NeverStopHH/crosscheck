import { basename, dirname, isAbsolute, resolve } from "node:path";
import { realpath } from "node:fs/promises";

import { LOCAL_REPO_HASH_CHARS } from "../constants.ts";
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

/**
 * The LITERAL host of an ssh-shaped remote, pre-normalization — the token a
 * user's ssh config would match. Null for anything ssh config cannot touch:
 * http(s)/git:// remotes (their hosts are DNS names), local paths, and
 * anything unparseable.
 */
export const sshHostOf = (raw: string): string | null => {
  const trimmed = raw.trim();
  const isSshUrl = SSH_SCHEME_PATTERN.test(trimmed);
  if (!isSshUrl && SCHEME_PATTERN.test(trimmed)) {
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
  return host.length === 0 ? null : host;
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

const NO_COMMIT_SHA = "0000000";

const resolveBranch = async (cwd: string): Promise<string> => {
  const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (branch === null) {
    return "HEAD";
  }
  if (branch !== "HEAD") {
    return branch;
  }
  const shortSha = await runGit(["rev-parse", "--short", "HEAD"], cwd);
  return shortSha === null ? "HEAD" : `detached@${shortSha}`;
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
