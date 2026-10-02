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
  /**
   * True ONLY when this module's own timer killed the process (A2.5). Never
   * derived from `proc.killed` or the exit code: Bun sets `killed` on every
   * exited process, so a plain non-zero exit read as a timeout.
   */
  readonly timedOut: boolean;
}

export interface ProcOptions {
  readonly cwd?: string;
  /**
   * Variables the caller pins on top of the allowlist (`childEnv`). The child
   * never sees the rest of the launching process's env.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: string;
  /** The harness's own kill timer: SIGKILL after this many ms. */
  readonly timeoutMs?: number;
}

/** The signal the timer sends: a wedged run must not be able to ignore it. */
const TIMEOUT_SIGNAL = "SIGKILL";

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

/**
 * Reads a child's output stream to the end, keeping only its last `maxChars`
 * characters. For a LONG-LIVED child (the hub): a pipe nobody reads fills and
 * blocks the child's writes, so its stderr is drained from the start, and the
 * bounded tail is what an error message can quote.
 */
export const drainTail = async (
  stream: ReadableStream<Uint8Array>,
  maxChars: number,
): Promise<string> => {
  const decoder = new TextDecoder();
  let tail = "";
  for await (const chunk of stream) {
    tail = `${tail}${decoder.decode(chunk, { stream: true })}`.slice(-maxChars);
  }
  return `${tail}${decoder.decode()}`.slice(-maxChars);
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
    // Spread the optional so `exactOptionalPropertyTypes` never sees an
    // explicit `undefined`, which fails the SpawnOptions overload.
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  // The harness owns the timeout (A2.5): only THIS timer firing sets timedOut.
  let killedByTimer = false;
  const timer =
    options.timeoutMs === undefined
      ? null
      : setTimeout(() => {
          killedByTimer = true;
          proc.kill(TIMEOUT_SIGNAL);
        }, options.timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr, timedOut: killedByTimer };
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
};
