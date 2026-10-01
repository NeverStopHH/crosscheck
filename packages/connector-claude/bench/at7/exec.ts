/**
 * A thin, typed wrapper over Bun.spawn for the live driver: run a command,
 * optionally feed it stdin, cap it with a timeout, and get back the exit code
 * and captured output. Shared by fixture.ts (git), hub.ts (serve), install.ts
 * (login/init) and run.ts (claude) so there is one spelling of "spawn and wait"
 * rather than four.
 *
 * NEVER INHERITS A PARTIAL ENV. Bun.spawn REPLACES the environment with the
 * object it is given, so the merged env is built explicitly from the current
 * process env plus the caller's overrides — a run that dropped PATH would fail
 * to find `git` or `bun` in ways that look like logic bugs.
 */

export interface ProcResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the timeout killed the process before it exited on its own. */
  readonly timedOut: boolean;
}

export interface ProcOptions {
  readonly cwd?: string;
  /** Overrides merged over the current process env (never a bare replace). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
}

const mergedEnv = (
  overrides: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> => {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      base[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value !== undefined) {
      base[key] = value;
    }
  }
  return base;
};

export const runProcess = async (
  cmd: readonly string[],
  options: ProcOptions = {},
): Promise<ProcResult> => {
  const proc = Bun.spawn([...cmd], {
    env: mergedEnv(options.env),
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
    // Spread the optionals so `exactOptionalPropertyTypes` never sees an
    // explicit `undefined`, which fails the SpawnOptions overload.
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeout: options.timeoutMs, killSignal: "SIGKILL" as const }),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    exitCode,
    stdout,
    stderr,
    // Bun reports the kill signal rather than a code when the timeout fires.
    timedOut: proc.killed && exitCode !== 0,
  };
};
