/**
 * A DEADLINE IS NOT AN ANSWER: an `ssh -G` that ran out its budget once must
 * cost that one call, not the rest of the process's life.
 *
 * The defect (found by the load-only flake in repo-ssh-determinism.test.ts):
 * resolveSshHostname memoized every outcome per host per process, deadlines
 * included. Under CPU contention the FIRST `ssh -G` of a process outlived
 * SSH_RESOLVE_TIMEOUT_MS — measured: 28 of 36 memo probes under 8 burners
 * answered `[null, null, "resolved-beta"]`, the repeat of the timed-out host
 * served from memory — so the alias was lost for every later call too. For
 * the long-lived MCP server that is every tool call until restart, each one
 * resolving the repo under its LITERAL alias host: an identity the hub
 * treats as a different repo, so teammates silently never match (the
 * 2026-08-18 incident ssh-hostname.ts exists to kill). constants.ts already
 * promised the opposite — a slow config "loses its aliasing for that call".
 *
 * Every case here runs in-process against an INJECTED runner: no spawn, no
 * clock, no PATH — the outcome sequence is the whole input, so the memo
 * policy is pinned deterministically at any load.
 */
import { describe, expect, test } from "bun:test";

import { SSH_RESOLVE_DEADLINE_STRIKES } from "../src/constants.ts";
import {
  createSshHostnameResolver,
  type SshCommandOutcome,
} from "../src/git/ssh-hostname.ts";

/** Canonicalization ON: the suite preload's off-switch is not in this env. */
const ENV_ON: Readonly<Record<string, string | undefined>> = {};

const TIMED_OUT: SshCommandOutcome = { ok: false, timedOut: true };
const REFUSED: SshCommandOutcome = { ok: false, timedOut: false };
const answered = (hostname: string): SshCommandOutcome => ({
  ok: true,
  stdout: `user git\nhostname ${hostname}\nport 22`,
});

/** A runner that plays back `outcomes` in order and counts its spawns. */
const scriptedRunner = (outcomes: readonly SshCommandOutcome[]) => {
  const asked: string[] = [];
  const run = async (cmd: readonly string[]): Promise<SshCommandOutcome> => {
    asked.push(cmd.join(" "));
    return outcomes[asked.length - 1] ?? REFUSED;
  };
  return { run, asked };
};

describe("an ssh -G deadline costs that one call", () => {
  test("a host that ran out the deadline is asked again, and its answer is then kept", async () => {
    // Arrange: contention on the first spawn only
    const { run, asked } = scriptedRunner([TIMED_OUT, answered("corp-proxy.example")]);
    const resolve = createSshHostnameResolver(run, ENV_ON);

    // Act
    const first = await resolve("github.com-alias", "/");
    const second = await resolve("github.com-alias", "/");
    const third = await resolve("github.com-alias", "/");

    // Assert: the deadline was not remembered, the real answer was
    expect([first, second, third]).toEqual([null, "corp-proxy.example", "corp-proxy.example"]);
    expect(asked).toEqual(["ssh -G github.com-alias", "ssh -G github.com-alias"]);
  });

  test("a config that keeps running out the deadline is remembered unresolvable after its strikes", async () => {
    // Arrange: a Match exec that never fits the budget
    const { run, asked } = scriptedRunner(
      Array.from({ length: SSH_RESOLVE_DEADLINE_STRIKES + 2 }, () => TIMED_OUT),
    );
    const resolve = createSshHostnameResolver(run, ENV_ON);

    // Act
    for (let call = 0; call < SSH_RESOLVE_DEADLINE_STRIKES + 2; call += 1) {
      expect(await resolve("slow.example", "/")).toBeNull();
    }

    // Assert: the worst case is bounded — STRIKES spawns, then memory
    expect(asked).toHaveLength(SSH_RESOLVE_DEADLINE_STRIKES);
  });

  test("a definitive refusal is remembered at once, as before", async () => {
    // Arrange: ssh exited non-zero — config evaluation said no, not "later"
    const { run, asked } = scriptedRunner([REFUSED, answered("never.example")]);
    const resolve = createSshHostnameResolver(run, ENV_ON);

    // Act
    const first = await resolve("refused.example", "/");
    const second = await resolve("refused.example", "/");

    // Assert
    expect([first, second]).toEqual([null, null]);
    expect(asked).toHaveLength(1);
  });

  test("concurrent callers share one spawn, and a shared deadline re-asks once", async () => {
    // Arrange
    const { run, asked } = scriptedRunner([TIMED_OUT, answered("corp-proxy.example")]);
    const resolve = createSshHostnameResolver(run, ENV_ON);

    // Act: two callers on the same in-flight spawn, then one more
    const pair = await Promise.all([resolve("racy.example", "/"), resolve("racy.example", "/")]);
    const after = await resolve("racy.example", "/");

    // Assert
    expect(pair).toEqual([null, null]);
    expect(after).toBe("corp-proxy.example");
    expect(asked).toHaveLength(2);
  });

  test("the off-switch still answers null before the runner is consulted", async () => {
    // Arrange
    const { run, asked } = scriptedRunner([answered("corp-proxy.example")]);
    const resolve = createSshHostnameResolver(run, { CROSSCHECK_SSH_CANONICALIZE: "off" });

    // Act + Assert
    expect(await resolve("github.com-alias", "/")).toBeNull();
    expect(asked).toHaveLength(0);
  });
});
