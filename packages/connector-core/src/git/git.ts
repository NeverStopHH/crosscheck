import { GIT_KILL_GRACE_MS, GIT_TIMEOUT_MS } from "../constants.ts";

/** Race winner when the deadline beats git. */
const TIMED_OUT = Symbol("crosscheck.git.timed-out");

interface GitOutcome {
  readonly stdout: string;
  readonly exitCode: number;
}

/**
 * Signal a timed-out git without waiting on it: SIGTERM now (git cleans its
 * lock files), SIGKILL after GIT_KILL_GRACE_MS for a git that ignores the
 * first — the escalation timer is unref'd so a long-lived process (the MCP
 * server) is not held open by it, and both kills are no-ops on a process
 * already gone.
 */
const abandonProcess = (proc: ReturnType<typeof Bun.spawn>): void => {
  try {
    proc.kill();
  } catch {
    // Already exited.
  }
  const escalation = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }, GIT_KILL_GRACE_MS);
  escalation.unref();
};

/**
 * Runs git and returns trimmed stdout, or null for any failure at all
 * (missing binary, not a repo, non-zero exit, deadline). Hooks treat null as
 * "this information does not exist" and keep going.
 *
 * THE DEADLINE BOUNDS THE CALL, NOT THE CHILD. Killing the direct child is
 * not enough: a `git` that is a non-exec wrapper, or one that lazy-fetches
 * (partial clones spawning fetch/ssh — teammate base commits are exactly the
 * shas the landed probes ask about), leaves a DESCENDANT holding the
 * inherited stdout pipe, and a read awaited past the kill then pends for
 * that descendant's whole lifetime. So the deadline races the read: when it
 * fires, the caller gets its null immediately and the read is abandoned —
 * it settles quietly whenever the pipe finally closes. Pinned by
 * test/git-timeout.test.ts, which drives exactly that wrapper shape.
 */
export const runGit = async (
  args: readonly string[],
  cwd: string,
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<string | null> => {
  try {
    const proc = Bun.spawn({
      cmd: ["git", ...args],
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof TIMED_OUT>((resolveDeadline) => {
      timer = setTimeout(() => {
        resolveDeadline(TIMED_OUT);
      }, timeoutMs);
    });
    const readAll: Promise<GitOutcome> = (async () => {
      const [stdout, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      return { stdout, exitCode };
    })();
    // An abandoned read that later rejects must not surface as an unhandled
    // rejection; the race path below still sees the original settlement.
    readAll.catch(() => undefined);
    try {
      const outcome = await Promise.race([readAll, deadline]);
      if (outcome === TIMED_OUT) {
        abandonProcess(proc);
        return null;
      }
      if (outcome.exitCode !== 0) {
        return null;
      }
      const trimmed = outcome.stdout.trim();
      return trimmed.length === 0 ? null : trimmed;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
};
