/**
 * A command runner with NO deadline: it waits for the command's own exit.
 *
 * For the ssh subprocess probes whose subject is NOT the deadline — the
 * off-switch, the `-G` parse, the memo of an answer. Through the real bounded
 * runner those assertions raced SSH_RESOLVE_TIMEOUT_MS, a hook-path budget
 * that CPU contention legitimately runs out on a process's first spawn: under
 * 8 burners, 12 of 36 opt-in probes and 28 of 36 memo probes got the
 * deadline's null instead of the fake ssh's answer. Awaiting the exit removes
 * the race instead of widening it; bun's per-test timeout stays the hang
 * guard.
 *
 * The deadline itself is pinned elsewhere, deterministically: the memo policy
 * against injected outcomes (ssh-hostname-deadline.test.ts) and the real
 * abandon-at-the-deadline spawn by repo-ssh-alias.test.ts's hang probe.
 */
import type { SshCommandRunner } from "../../src/git/ssh-hostname.ts";

export const runToExit: SshCommandRunner = async (cmd, cwd) => {
  try {
    const proc = Bun.spawn({
      cmd: [...cmd],
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return exitCode === 0
      ? { ok: true, stdout: stdout.trim() }
      : { ok: false, timedOut: false };
  } catch {
    return { ok: false, timedOut: false };
  }
};
