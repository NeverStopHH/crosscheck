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
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runBoundedCommandOutcome } from "../src/git/git.ts";

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

describe("the outcome tells a deadline from a refusal", () => {
  test("a command still running at the deadline reads as timed out; one that refused does not", async () => {
    // Arrange — doctor's landing-fetch line sends the developer to different
    // fixes for the two ("did not finish within 120 s" vs "failed").
    const cwd = tmpdir();

    // Act
    const slow = await runBoundedCommandOutcome(["/bin/sleep", "5"], cwd, 100);
    const refused = await runBoundedCommandOutcome(["/bin/sh", "-c", "exit 3"], cwd, 5000);
    const missing = await runBoundedCommandOutcome(["/nonexistent/crosscheck-binary"], cwd, 5000);

    // Assert
    expect(slow).toEqual({ ok: false, timedOut: true });
    expect(refused).toEqual({ ok: false, timedOut: false });
    expect(missing).toEqual({ ok: false, timedOut: false });
  });
});

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * A command whose grandchild ignores SIGTERM — the shape of an ssh
 * ProxyCommand or a credential helper stuck on a dialog. Returns the
 * grandchild's pid once it has written it.
 */
const stubbornTree = async (dir: string): Promise<{ cmd: readonly string[]; pid: () => Promise<number> }> => {
  const pidFile = join(dir, "grandchild.pid");
  return {
    cmd: [
      "/bin/sh",
      "-c",
      `trap "" TERM; /bin/sh -c 'trap "" TERM; echo $$ > "${pidFile}.tmp" && mv "${pidFile}.tmp" "${pidFile}"; exec /bin/sleep 30' & wait`,
    ],
    pid: async () => Number((await readFile(pidFile, "utf8")).trim()),
  };
};

describe("a command that leads its own process group", () => {
  test("at the deadline its whole tree is ended, a descendant that ignores SIGTERM included", async () => {
    // Arrange
    const dir = await mkdtemp(join(tmpdir(), "cx-own-group-"));
    const tree = await stubbornTree(dir);

    // Act — the call returns only after the group is ended
    const outcome = await runBoundedCommandOutcome(tree.cmd, dir, 700, {}, { ownGroup: true });

    // Assert
    expect(outcome).toEqual({ ok: false, timedOut: true });
    const grandchild = await tree.pid();
    let alive = isAlive(grandchild);
    for (let waited = 0; waited < 2000 && alive; waited += 50) {
      await Bun.sleep(50);
      alive = isAlive(grandchild);
    }
    expect(alive).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  test("the control: without its own group, that descendant outlives the call", async () => {
    // Arrange
    const dir = await mkdtemp(join(tmpdir(), "cx-own-group-control-"));
    const tree = await stubbornTree(dir);

    // Act
    await runBoundedCommandOutcome(tree.cmd, dir, 700);
    await Bun.sleep(1000);

    // Assert — and clean up what this test deliberately left
    const grandchild = await tree.pid();
    expect(isAlive(grandchild)).toBe(true);
    process.kill(grandchild, "SIGKILL");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("a command handed its whole environment", () => {
  test("sees exactly that environment, and nothing of this process's", async () => {
    // Arrange — a variable this process has and the handed environment lacks
    process.env["CX_INHERIT_PROBE"] = "leaked";
    try {
      const echo = ["/bin/sh", "-c", 'echo "${CX_INHERIT_PROBE:-absent}"'];

      // Act
      const handed = await runBoundedCommandOutcome(echo, tmpdir(), 5000, { PATH: "/usr/bin:/bin" }, { inheritEnv: false });
      const layered = await runBoundedCommandOutcome(echo, tmpdir(), 5000, { PATH: "/usr/bin:/bin" });

      // Assert
      expect(handed).toEqual({ ok: true, stdout: "absent" });
      expect(layered).toEqual({ ok: true, stdout: "leaked" });
    } finally {
      delete process.env["CX_INHERIT_PROBE"];
    }
  });
});
