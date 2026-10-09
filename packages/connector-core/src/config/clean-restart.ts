/**
 * RESTARTING AN ENTRY WITHOUT THE RUNTIME VARIABLES A HOST PASSED
 * (runtime-isolation.ts `hasBunStartupKey`; review round 2, N2).
 *
 * Bun reads `BUN_OPTIONS`, `BUN_CONFIG_*` and `BUN_INSPECT*` before the first
 * line of ours, so an entry that finds one starts itself again without it.
 * Bun 1.3.13 has no exec-replace (`process.execve` is undefined, measured), so
 * the first process stays and supervises the restarted one. A synchronous
 * restart blocked every signal the host sends to the pid it started, and the
 * MCP server and the ACP proxy live as long as the editor: the restarted one
 * outlived it. So:
 * - the child starts asynchronously, isolated, without the variables, with
 *   the same stdio. The parent never reads stdin, so the child gets the
 *   host's bytes and their EOF directly, and a stdio server ends on that EOF
 *   exactly as it does unrestarted. (The parent cannot watch stdin itself
 *   without stealing bytes from the child.)
 * - SIGTERM, SIGINT, SIGHUP and SIGQUIT sent to the parent go on to the
 *   child. A terminal's ctrl-C reaches both, since they share a process
 *   group, so the child may see SIGINT twice.
 * - the parent leaves with the child's exit code, or dies by the child's
 *   signal, so the host's waitpid sees what it would have seen.
 * - the child is told the parent's pid and hangs itself up when that parent
 *   is gone (a SIGKILL, which nothing can forward), so it never outlives its
 *   supervisor by more than one poll.
 * The parent's promise never settles: clean-runtime.ts awaits it at top
 * level, and Bun then evaluates none of the entry's other modules (measured).
 */
import { constants as osConstants } from "node:os";

import { hasBunStartupKey, selfSpawnCmd, withoutRuntimeInjection } from "./runtime-isolation.ts";

/** What a host or a person sends to stop a crosscheck process; each goes on to the restarted one. */
export const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];

/** How a restarted process learns which pid supervises it. */
export const SUPERVISOR_PID_ENV = "CROSSCHECK_SUPERVISOR_PID";

/** How often a restarted process checks that its supervisor is still its parent. */
export const SUPERVISOR_POLL_MS = 500;

/** The hang-up a dropped terminal gives: what a restarted process sends itself once orphaned. */
const ORPHAN_SIGNAL: NodeJS.Signals = "SIGHUP";

/** The shell convention for a death by signal n: 128 + n. */
const SIGNAL_EXIT_BASE = 128;

/** How long a re-raised signal gets to end this process before the numeric exit does. */
const RERAISE_GRACE_MS = 100;

/** Die by `signal` ourselves, so a waitpid sees the child's death; 128+n only if the re-raise did not end us. */
const dieBy = (signal: NodeJS.Signals): void => {
  for (const forwarded of FORWARDED_SIGNALS) {
    process.removeAllListeners(forwarded);
  }
  const fallback = SIGNAL_EXIT_BASE + (osConstants.signals[signal] ?? osConstants.signals.SIGTERM);
  setTimeout(() => process.exit(fallback), RERAISE_GRACE_MS);
  try {
    process.kill(process.pid, signal);
  } catch {
    process.exit(fallback);
  }
};

/** Start the entry again without the variables, supervise it, and never return. */
const superviseRestart = (): Promise<never> => {
  const [, entry = "", ...args] = process.argv;
  const child = Bun.spawn({
    cmd: [...selfSpawnCmd(entry, args)],
    env: { ...withoutRuntimeInjection(process.env), [SUPERVISOR_PID_ENV]: String(process.pid) },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  for (const signal of FORWARDED_SIGNALS) {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {
        // Already gone: its exit is mirrored below.
      }
    });
  }
  void child.exited.then((code) => {
    if (child.signalCode !== null) {
      dieBy(child.signalCode);
      return;
    }
    process.exit(code);
  });
  return new Promise<never>(() => undefined);
};

/** In a restarted process: hang up once the supervisor is no longer the parent. */
const watchSupervisor = (): void => {
  const raw = process.env[SUPERVISOR_PID_ENV];
  if (raw === undefined) {
    return;
  }
  delete process.env[SUPERVISOR_PID_ENV];
  const supervisor = Number(raw);
  if (!Number.isInteger(supervisor) || supervisor <= 1) {
    return;
  }
  const timer = setInterval(() => {
    if (process.ppid !== supervisor) {
      clearInterval(timer);
      process.kill(process.pid, ORPHAN_SIGNAL);
    }
  }, SUPERVISOR_POLL_MS);
  // A short-lived hook must not be held open by its own watchdog.
  timer.unref();
};

/**
 * RUN FIRST IN EVERY CROSSCHECK ENTRY (clean-runtime.ts awaits it).
 * Resolves at once for a clean runtime, dropping `NODE_OPTIONS`, which bun
 * ignores, so no child inherits it. Never resolves in a process that
 * restarted itself: that process only supervises.
 */
export const ensureCleanRuntime = async (): Promise<void> => {
  watchSupervisor();
  if (!hasBunStartupKey(process.env)) {
    delete process.env["NODE_OPTIONS"];
    return;
  }
  await superviseRestart();
};
