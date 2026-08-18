/**
 * Resolves an ssh HOST ALIAS to the hostname the user's own ssh config gives
 * it. The incident (2026-08-18 trial onboarding): a teammate's multi-account
 * alias remote `git@github.com-toandiep:org/repo` produced repo identity
 * `github.com-toandiep/org/repo` while every other checkout of the same repo
 * was `github.com/org/repo` — the hub saw two different repos, and the two
 * developers would silently never match. Identity-by-remote (DESIGN.md §3)
 * only works if the HOST half means the same thing on every machine, and an
 * ssh alias is by definition one machine's private name.
 *
 * `ssh -G <host>` evaluates the config WITHOUT connecting anywhere and
 * prints one `hostname <value>` line: the alias's HostName when the config
 * maps it, the literal input echoed back otherwise (verified against OpenSSH
 * on macOS; test/repo-ssh-alias.test.ts pins the parse against a scripted
 * dump). It runs through the same bounded runner discipline as every git
 * spawn (runBoundedCommand) because identity resolution sits on every hook's
 * path: SSH_RESOLVE_TIMEOUT_MS bounds it, and EVERY failure — ssh missing,
 * non-zero exit, deadline, unparseable output, a host that could read as an
 * option — yields null so the caller keeps the literal host. Fail-open:
 * today's identity is the floor, never lost, only improved.
 *
 * MIGRATION STORY, stated so nobody goes looking for a tool that does not
 * need to exist: identities already recorded under an aliased form stay as
 * they are — repo ids are opaque strings to the hub, so there is no
 * server-side rewrite and none is needed. From the first session after this
 * change the canonical id is reported, and new work accumulates under it;
 * work recorded under the aliased id remains on the hub and reachable, it
 * simply belongs to a repo id nobody reports into anymore and ages out of
 * the presence/briefing surfaces. A developer can equally fix the remote
 * itself (our teammate did, by hand, the day of the incident) — both paths
 * converge on the canonical id.
 */
import {
  SSH_CANONICALIZE_ENV,
  SSH_CANONICALIZE_OFF,
  SSH_RESOLVE_TIMEOUT_MS,
} from "../constants.ts";
import { runBoundedCommand } from "./git.ts";

/** The `hostname <value>` line of an `ssh -G` dump; keys print lowercased. */
const HOSTNAME_LINE_PATTERN = /^hostname\s+(\S+)\s*$/im;

export const parseSshHostname = (output: string): string | null => {
  const match = HOSTNAME_LINE_PATTERN.exec(output);
  return match?.[1] ?? null;
};

export type SshHostnameResolver = (host: string) => Promise<string | null>;

/**
 * One answer per host per PROCESS. `ssh -G` is pure config evaluation, so
 * within one process the answer cannot change, and re-spawning it billed the
 * long-lived surfaces per call — the MCP server resolves identity on every
 * tool call — at ~10 ms typical, SSH_RESOLVE_TIMEOUT_MS worst case under a
 * pathological config. Memoizing the PROMISE also collapses concurrent
 * callers onto one spawn. Failures (null) are cached too: a config that ran
 * out the deadline once would otherwise re-bill the full deadline on every
 * call for the rest of the process's life. Hook and statusline processes are
 * one-shot, so they pay at most one bounded spawn per run; a config edit is
 * picked up by the next process (for the MCP server: on restart). The first
 * caller's timeoutMs governs — later per-call overrides cannot re-run a
 * host that already answered.
 */
const hostnameByHost = new Map<string, Promise<string | null>>();

/**
 * One bounded `ssh -G` per host per process. The leading-dash guard keeps
 * a hostile "host" from ever reaching ssh as an option; `--` is not used
 * because `ssh -G -- <host>` is fine but older ssh quirks are not worth the
 * bet when null is a safe answer. CROSSCHECK_SSH_CANONICALIZE=off answers
 * null before consulting the cache or spawning anything (src/constants.ts
 * names both audiences: pathological user configs, and the test suite's
 * preload) — checked per call, so flipping the variable mid-process wins.
 */
export const resolveSshHostname = (
  host: string,
  cwd: string,
  timeoutMs: number = SSH_RESOLVE_TIMEOUT_MS,
): Promise<string | null> => {
  if (host.length === 0 || host.startsWith("-")) {
    return Promise.resolve(null);
  }
  if (process.env[SSH_CANONICALIZE_ENV] === SSH_CANONICALIZE_OFF) {
    return Promise.resolve(null);
  }
  const cached = hostnameByHost.get(host);
  if (cached !== undefined) {
    return cached;
  }
  const resolved = runBoundedCommand(["ssh", "-G", host], cwd, timeoutMs).then(
    (output) => (output === null ? null : parseSshHostname(output)),
  );
  hostnameByHost.set(host, resolved);
  return resolved;
};
