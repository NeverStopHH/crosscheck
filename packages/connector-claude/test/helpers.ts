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
