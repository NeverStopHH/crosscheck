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
  SSH_RESOLVE_DEADLINE_STRIKES,
  SSH_RESOLVE_TIMEOUT_MS,
} from "../constants.ts";
import { runBoundedCommandOutcome } from "./git.ts";

/** The `hostname <value>` line of an `ssh -G` dump; keys print lowercased. */
const HOSTNAME_LINE_PATTERN = /^hostname\s+(\S+)\s*$/im;

export const parseSshHostname = (output: string): string | null => {
  const match = HOSTNAME_LINE_PATTERN.exec(output);
  return match?.[1] ?? null;
};

export type SshHostnameResolver = (host: string) => Promise<string | null>;

/** What one bounded `ssh -G` came back with — a deadline told apart. */
export type SshCommandOutcome = Awaited<ReturnType<typeof runBoundedCommandOutcome>>;

/** The spawn, injectable so the memo policy is testable without a clock. */
export type SshCommandRunner = (
  cmd: readonly string[],
  cwd: string,
  timeoutMs: number,
) => Promise<SshCommandOutcome>;

const answerOf = (outcome: SshCommandOutcome): string | null =>
  outcome.ok && outcome.stdout.length > 0 ? parseSshHostname(outcome.stdout) : null;

/**
 * One answer per host per PROCESS. `ssh -G` is pure config evaluation, so
 * within one process the answer cannot change, and re-spawning it billed the
 * long-lived surfaces per call — the MCP server resolves identity on every
 * tool call — at ~10 ms typical, SSH_RESOLVE_TIMEOUT_MS worst case under a
 * pathological config. Memoizing the PROMISE also collapses concurrent
 * callers onto one spawn. Hook and statusline processes are one-shot, so
 * they pay at most one bounded spawn per run; a config edit is picked up by
 * the next process (for the MCP server: on restart). The first caller's
 * timeoutMs governs — later per-call overrides cannot re-run a host that
 * already answered.
 *
 * A DEADLINE IS NOT AN ANSWER, and is the one outcome not remembered at
 * once. Everything else is: a hostname, an exit that refused, unparseable
 * output — config evaluation said so, and will say so again. A deadline says
 * only that this spawn was slow, and under CPU contention a process's FIRST
 * spawn routinely is (measured: 28 of 36 probes under load). Memoized, that
 * one slow moment cost a long-lived process its alias for the rest of its
 * life — every MCP tool call resolving the repo under the literal alias host,
 * an identity the hub treats as a different repo. So a timed-out host is
 * asked again on the next call, until it has run out the deadline
 * SSH_RESOLVE_DEADLINE_STRIKES times: then its null is remembered, and a
 * config that genuinely never fits bills that many deadlines per process,
 * not one per call.
 *
 * `env` is read per call, so flipping CROSSCHECK_SSH_CANONICALIZE mid-process
 * wins; the default is the live process environment.
 */
export const createSshHostnameResolver = (
  run: SshCommandRunner = runBoundedCommandOutcome,
  env: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const hostnameByHost = new Map<string, Promise<string | null>>();
  const deadlinesByHost = new Map<string, number>();

  const remember = (host: string, outcome: SshCommandOutcome): string | null => {
    if (!outcome.ok && outcome.timedOut) {
      const strikes = (deadlinesByHost.get(host) ?? 0) + 1;
      deadlinesByHost.set(host, strikes);
      if (strikes < SSH_RESOLVE_DEADLINE_STRIKES) {
        hostnameByHost.delete(host);
      }
    }
    return answerOf(outcome);
  };

  /**
   * One bounded `ssh -G` per host per process. The leading-dash guard keeps
   * a hostile "host" from ever reaching ssh as an option; `--` is not used
   * because `ssh -G -- <host>` is fine but older ssh quirks are not worth the
   * bet when null is a safe answer. CROSSCHECK_SSH_CANONICALIZE=off answers
   * null before consulting the cache or spawning anything (src/constants.ts
   * names both audiences: pathological user configs, and the test suite's
   * preload).
   */
  return (
    host: string,
    cwd: string,
    timeoutMs: number = SSH_RESOLVE_TIMEOUT_MS,
  ): Promise<string | null> => {
    if (host.length === 0 || host.startsWith("-")) {
      return Promise.resolve(null);
    }
    if (env[SSH_CANONICALIZE_ENV] === SSH_CANONICALIZE_OFF) {
      return Promise.resolve(null);
    }
    const cached = hostnameByHost.get(host);
    if (cached !== undefined) {
      return cached;
    }
    const resolved = run(["ssh", "-G", host], cwd, timeoutMs).then((outcome) =>
      remember(host, outcome),
    );
    hostnameByHost.set(host, resolved);
    return resolved;
  };
};

/** The process's own resolver: the real bounded spawn, the live environment. */
export const resolveSshHostname = createSshHostnameResolver();
