/**
 * A thin, typed wrapper over Bun.spawn for the live driver: run a command,
 * optionally feed it stdin, cap it with a timeout, and get back the exit code
 * and captured output. Shared by fixture.ts (git), hub.ts (serve), install.ts
 * (login/init) and run.ts (claude) so there is one spelling of "spawn and wait"
 * rather than four.
 *
 * NEVER INHERITS THE WHOLE ENV (A1.5). A session launched from an agent carries
 * CLAUDE_EFFORT, CLAUDE_CODE_*, CROSSCHECK_TRIPWIRE, and — the dangerous one —
 * CROSSCHECK_HUB_URL, which outranks everything in login/init and would point
 * the run at the team hub. So every child gets an explicit ALLOWLIST (PATH,
 * HOME, USER, LANG, TMPDIR, TERM) plus exactly the variables the caller pins;
 * every other variable of the launching process, every CROSSCHECK_* and
 * CLAUDE_* above all, is dropped. `childEnv` is pure and unit-tested.
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

/**
 * The only variables of the launching process a child inherits (A1.5). These
 * are environment, not identity: a locale and a temp dir, the PATH that finds
 * `git`/`bun`/`claude`, and the HOME that holds the user's own claude
 * credentials (which must stay, so `claude -p` can authenticate).
 */
export const CHILD_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TMPDIR",
  "TERM",
];

/**
 * The child environment: the allowlisted variables of `source`, then the
 * caller's pinned overrides on top. Everything else — every CROSSCHECK_* and
 * CLAUDE_* of the launcher — is absent by construction. Pure.
 */
export const childEnv = (
  source: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
};

export const runProcess = async (
  cmd: readonly string[],
  options: ProcOptions = {},
): Promise<ProcResult> => {
  const proc = Bun.spawn([...cmd], {
    env: childEnv(process.env, options.env ?? {}),
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
