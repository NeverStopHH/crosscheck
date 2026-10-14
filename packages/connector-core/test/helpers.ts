import { chmod, mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const git = async (
  cwd: string,
  args: readonly string[],
): Promise<void> => {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed with ${exitCode}`);
  }
};

export interface MakeRepoOptions {
  readonly remote?: string;
  /** `reftable` keeps refs and reflogs in git's table files: HEAD reads `ref: refs/heads/.invalid`, no `logs/HEAD` (review M3). */
  readonly refFormat?: "files" | "reftable";
}

/** A real git repo with one commit — repo identity is git-derived, not mocked. */
export const makeRepo = async (
  label: string,
  options: MakeRepoOptions = {},
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), `cx-${label}-`));
  await git(root, ["init", "--initial-branch=main", ...(options.refFormat === undefined ? [] : [`--ref-format=${options.refFormat}`])]);
  await git(root, ["config", "user.email", "dev@example.com"]);
  await git(root, ["config", "user.name", "Dev"]);
  await writeFile(join(root, "README.md"), "# fixture\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  if (options.remote !== undefined) {
    await git(root, ["remote", "add", "origin", options.remote]);
  }
  return root;
};

export const writeRepoFile = async (
  root: string,
  relativePath: string,
  content: string,
): Promise<string> => {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return path;
};

export const makeHome = async (label: string): Promise<string> =>
  mkdtemp(join(tmpdir(), `cx-home-${label}-`));

/** Files created at once while seeding: enough to be quick, few enough fds. */
const SEED_CHUNK = 500;

/**
 * `count` empty files in `dir`, each named exactly like a writePrivateFile
 * temp sibling and each `ageMs` older than `now` — the abandoned-temp
 * backlog the sweep tests need (state/temp-sweep.ts). Returns their paths.
 */
export const seedAbandonedTemps = async (
  dir: string,
  count: number,
  ageMs: number,
  now: Date = new Date(),
): Promise<readonly string[]> => {
  await mkdir(dir, { recursive: true });
  const when = new Date(now.getTime() - ageMs);
  const paths = Array.from({ length: count }, (_, index) =>
    join(dir, `seeded-${String(index)}.json.tmp-${String(index)}-abcdefgh`),
  );
  for (let start = 0; start < paths.length; start += SEED_CHUNK) {
    await Promise.all(
      paths.slice(start, start + SEED_CHUNK).map(async (path) => {
        await writeFile(path, "", "utf8");
        await utimes(path, when, when);
      }),
    );
  }
  return paths;
};

/** Far past any deadline a test hands a stalled git. */
const STALLED_GIT_LIFETIME_S = 30;

/**
 * A directory whose `git` never answers in time: it sleeps, as the git it
 * replaces would under a cold cache or a lock. A tiny deadline is no stand-in
 * for one: in a Linux container a real `git check-attr` answered in about
 * 0.6 ms and beat a 0 ms deadline 19 times in 20 (bun 1.4.3; 10 in 20 on
 * 1.3.13), and GitHub's Ubuntu runner failed both tests that relied on it.
 * `exec`, so the deadline's kill ends the sleep too and nothing outlives the
 * test.
 */
export const makeStalledGitDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-stalled-git-"));
  const wrapper = join(dir, "git");
  await writeFile(wrapper, `#!/bin/sh\nexec /bin/sleep ${String(STALLED_GIT_LIFETIME_S)}\n`, "utf8");
  await chmod(wrapper, 0o755);
  return dir;
};

/**
 * Runs a test/fixtures probe in a child bun whose PATH finds `gitDir`'s `git`
 * first, hands it `input` as JSON (its first argument) and returns what it
 * printed, parsed. A child, because executable lookup is fixed at process
 * start: changing process.env.PATH inside a test does not redirect
 * Bun.spawn's `git` (fixtures/rungit-timeout-probe.ts).
 */
export const runProbeWithGit = async <T>(probe: string, gitDir: string, input: unknown): Promise<T> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, probe, JSON.stringify(input)],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${gitDir}:${process.env["PATH"] ?? ""}` },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`probe ${probe} exited ${String(exitCode)}: ${stderr.trim()}`);
  }
  return JSON.parse(stdout) as T;
};

/** What the kernel is given to move an exited child into the zombie state. */
const ZOMBIE_SETTLE_MS = 300;

export interface Zombie {
  /** A pid that has EXITED and whose table entry is still there. */
  readonly pid: number;
  /** Kills the parent; init then reaps the entry. */
  readonly release: () => void;
}

/**
 * A holder that crashed and has NOT been reaped — what a crashed hook leaves
 * behind whenever the process that started it is still alive. The entry stays
 * in the process table until its parent wait()s, and `process.kill(pid, 0)`
 * succeeds for it, so it reads as alive with no pid reuse involved.
 *
 * perl rather than a shell: a shell reaps its background children and would
 * leave no zombie to test against. This parent prints its child's pid and then
 * never wait()s for it.
 */
export const spawnZombie = async (): Promise<Zombie> => {
  const proc = Bun.spawn({
    cmd: [
      "perl",
      "-e",
      'my $p = fork(); exit 0 unless $p; $| = 1; print "$p\n"; sleep 30;',
    ],
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  const reader = proc.stdout.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  const pid = Number(new TextDecoder().decode(value ?? new Uint8Array()).trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    proc.kill();
    throw new Error("could not fork a zombie: perl printed no pid");
  }
  await Bun.sleep(ZOMBIE_SETTLE_MS);
  return {
    pid,
    release: () => {
      proc.kill();
    },
  };
};
