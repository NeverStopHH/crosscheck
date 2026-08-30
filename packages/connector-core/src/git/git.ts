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
 * Runs a command and returns trimmed stdout, or null for any failure at all
 * (missing binary, non-zero exit, deadline). Callers treat null as "this
 * information does not exist" and keep going.
 *
 * THE DEADLINE BOUNDS THE CALL, NOT THE CHILD. Killing the direct child is
 * not enough: a binary that is a non-exec wrapper, or one that spawns helpers
 * (git lazy-fetching from a partial clone, ssh running a Match exec), leaves
 * a DESCENDANT holding the inherited stdout pipe, and a read awaited past the
 * kill then pends for that descendant's whole lifetime. So the deadline races
 * the read: when it fires, the caller gets its null immediately and the read
 * is abandoned — it settles quietly whenever the pipe finally closes. Pinned
 * by test/git-timeout.test.ts (git through a wrapper) and
 * test/repo-ssh-alias.test.ts (a hanging fake ssh), which drive exactly that
 * shape.
 */
export const runBoundedCommand = async (
  cmd: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<string | null> => {
  const outcome = await runBoundedCommandOutcome(cmd, cwd, timeoutMs);
  if (!outcome.ok) {
    return null;
  }
  return outcome.stdout.length === 0 ? null : outcome.stdout;
};

/**
 * The same call, WITHOUT the null-collapse — for the one caller that must
 * tell "the command answered, and said nothing" apart from "the command did
 * not answer".
 *
 * `runBoundedCommand` above returns null for both, which is right for every
 * caller that only wants a value: an empty answer and no answer are equally
 * unusable to them. It is wrong for the regression guard's git lane, where
 * an empty `git diff --name-only` means a clean worktree and a deadline means
 * the lane saw nothing at all — collapsing them makes a lane that times out
 * on every turn indistinguishable from a healthy one, which `doctor` would
 * then report as health (flows/capture-git-touches.ts).
 */
export const runBoundedCommandOutcome = async (
  cmd: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<
  { readonly ok: true; readonly stdout: string } | { readonly ok: false }
> => {
  try {
    const proc = Bun.spawn({
      cmd: [...cmd],
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
        return { ok: false };
      }
      if (outcome.exitCode !== 0) {
        return { ok: false };
      }
      return { ok: true, stdout: outcome.stdout.trim() };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false };
  }
};

/**
 * Runs git and returns trimmed stdout, or null for any failure at all
 * (missing binary, not a repo, non-zero exit, deadline). Hooks treat null as
 * "this information does not exist" and keep going. The deadline discipline
 * lives in runBoundedCommand above; the wrapper only supplies the binary and
 * the git default budget.
 */
export const runGit = (
  args: readonly string[],
  cwd: string,
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<string | null> => runBoundedCommand(["git", ...args], cwd, timeoutMs);

/** `runGit` for the caller that needs empty-but-answered (see the outcome). */
export const runGitOutcome = (
  args: readonly string[],
  cwd: string,
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<
  { readonly ok: true; readonly stdout: string } | { readonly ok: false }
> => runBoundedCommandOutcome(["git", ...args], cwd, timeoutMs);
