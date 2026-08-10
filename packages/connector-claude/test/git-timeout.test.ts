/**
 * runGit's deadline must bound the CALL, not just the direct child. A `git`
 * that is a non-exec wrapper (corporate shims) or that lazy-fetches (partial
 * clones spawning fetch/ssh) leaves a descendant holding the inherited
 * stdout pipe after the direct child dies — and a timeout that only signals
 * the child then waits on that pipe for the descendant's whole lifetime.
 * Every hook and MCP git call rides on this bound.
 *
 * Runs the probe in a subprocess because executable lookup is fixed at
 * process start — see fixtures/rungit-timeout-probe.ts.
 */
import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The probe's own timeout is 250 ms; anything near it is bounded, the
 * descendant's 5 s lifetime is not. Generous headroom for process startup. */
const BOUNDED_CEILING_MS = 1500;

/**
 * Below this the wrapper cannot have run at all (an exec hiccup fails runGit
 * instantly) — and a null that never waited out the deadline would make this
 * test pass without testing anything.
 */
const DEADLINE_FLOOR_MS = 200;

/** Longer than any plausible CI wobble, far past the ceiling above. */
const DESCENDANT_LIFETIME_S = 5;

interface ProbeReport {
  readonly output: string | null;
  readonly elapsedMs: number;
}

/**
 * A `git` whose real work happens in a child that inherits stdout: sh waits
 * in the foreground, so SIGTERM kills sh while /bin/sleep keeps the pipe's
 * write end open — the exact shape of a shim or a lazy fetch.
 */
const makeHungGitDir = async (): Promise<string> => {
  const binDir = await mkdtemp(join(tmpdir(), "cx-hung-git-"));
  const wrapper = join(binDir, "git");
  await writeFile(
    wrapper,
    `#!/bin/sh\n/bin/sleep ${String(DESCENDANT_LIFETIME_S)}\nexit 0\n`,
    "utf8",
  );
  await chmod(wrapper, 0o755);
  return binDir;
};

const runProbe = async (pathPrefix: string): Promise<ProbeReport> => {
  const probe = join(import.meta.dir, "fixtures", "rungit-timeout-probe.ts");
  const proc = Bun.spawn({
    cmd: [process.execPath, probe],
    cwd: import.meta.dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: {
      ...process.env,
      PATH: `${pathPrefix}:${process.env.PATH ?? ""}`,
    },
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`probe exited ${String(exitCode)}`);
  }
  return JSON.parse(stdout) as ProbeReport;
};

describe("runGit deadline", () => {
  test("a git whose descendant holds the pipe is abandoned at the deadline", async () => {
    // Arrange
    const binDir = await makeHungGitDir();

    // Act
    const report = await runProbe(binDir);

    // Assert: null (the call failed honestly) and BOUNDED — without the
    // deadline race this reads ~5000 ms, the descendant's lifetime. The
    // floor proves the wrapper genuinely ran and the DEADLINE produced the
    // null, not an instant exec failure.
    expect(report.output).toBeNull();
    expect(report.elapsedMs).toBeLessThan(BOUNDED_CEILING_MS);
    expect(report.elapsedMs).toBeGreaterThan(DEADLINE_FLOOR_MS);
  });
});
