import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
}

/** A real git repo with one commit — repo identity is git-derived, not mocked. */
export const makeRepo = async (
  label: string,
  options: MakeRepoOptions = {},
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), `cx-${label}-`));
  await git(root, ["init", "--initial-branch=main"]);
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
