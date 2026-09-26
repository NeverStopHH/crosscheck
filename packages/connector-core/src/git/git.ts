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
 * End a command's WHOLE process group — the command leads it (`ownGroup`) —
 * and wait out the grace before returning, so a caller that exits right after
 * (a detached worker) cannot leave the SIGKILL unsent the way an unref'd
 * escalation timer would. SIGTERM first, so a git still running removes its
 * lock files; then SIGKILL for whatever ignored it (a ProxyCommand, a
 * credential helper stuck on a dialog).
 */
const endGroup = async (leader: number): Promise<void> => {
  try {
    process.kill(-leader, "SIGTERM");
  } catch {
    return;
  }
  await Bun.sleep(GIT_KILL_GRACE_MS);
  try {
    process.kill(-leader, "SIGKILL");
  } catch {
    // The group is already gone.
  }
};

export interface CommandOptions {
  /**
   * Start the command as the leader of its own process group, and at the
   * deadline end that whole group (see `endGroup`). Only that call's tree:
   * a daemon an earlier, finished call started stays the developer's.
   */
  readonly ownGroup?: boolean;
  /**
   * False: run with exactly `extraEnv`, NOT the inherited environment plus
   * it — for a caller that was handed the environment to use (the landing
   * fetch worker runs git with the developer's, as the hook was given it).
   */
  readonly inheritEnv?: boolean;
}

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
 * A command that did not answer. `timedOut` tells a deadline apart from a
 * refusal (non-zero exit, missing binary) for the one reader that says which
 * to a human — `doctor`'s landing-fetch line, where "did not finish within
 * 120 s" and "failed" send the developer to different fixes.
 */
export interface CommandFailure {
  readonly ok: false;
  readonly timedOut: boolean;
}

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
  /**
   * Added to the inherited environment for this one command. Omitted, the
   * child inherits the environment untouched, exactly as before.
   */
  extraEnv?: Readonly<Record<string, string>>,
  options: CommandOptions = {},
): Promise<
  { readonly ok: true; readonly stdout: string } | CommandFailure
> => {
  try {
    const env =
      extraEnv === undefined
        ? undefined
        : options.inheritEnv === false
          ? { ...extraEnv }
          : { ...process.env, ...extraEnv };
    const proc = Bun.spawn({
      cmd: [...cmd],
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      ...(env === undefined ? {} : { env }),
      ...(options.ownGroup === true ? { detached: true } : {}),
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
        if (options.ownGroup === true) {
          await endGroup(proc.pid);
        } else {
          abandonProcess(proc);
        }
        return { ok: false, timedOut: true };
      }
      if (outcome.exitCode !== 0) {
        return { ok: false, timedOut: false };
      }
      return { ok: true, stdout: outcome.stdout.trim() };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false, timedOut: false };
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
  extraEnv?: Readonly<Record<string, string>>,
  options: CommandOptions = {},
): Promise<
  { readonly ok: true; readonly stdout: string } | CommandFailure
> => runBoundedCommandOutcome(["git", ...args], cwd, timeoutMs, extraEnv, options);
