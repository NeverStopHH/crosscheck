/**
 * Three real git repos for the landed-change tests: a bare `origin`, the
 * teammate's clone that lands work on it, and the reader's clone whose
 * checkout may or may not contain that work.
 *
 * Real git, never a mock: "does this checkout contain that change" is a
 * question about commit ancestry and patch identity, and a stub would only
 * restate what the test already assumes. Global and system git config are
 * shut out so a developer's own settings (signing, `log.showSignature`) can
 * neither break nor rescue a test.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface Person {
  readonly name: string;
  readonly email: string;
}

export const MIKE: Person = { name: "Mike", email: "mike@example.com" };
export const NICK: Person = { name: "Nick", email: "nick@example.com" };
export const KEN: Person = { name: "Ken", email: "ken@example.com" };

export interface LandingRepos {
  readonly base: string;
  readonly origin: string;
  /** Mike's clone: where teammate work is written and landed. */
  readonly teammate: string;
  /** Nick's clone: on `nick/work`, cut from `origin/main`. */
  readonly reader: string;
}

interface GitOptions {
  /** Author AND committer identity for this one command. */
  readonly as?: Person;
  /** Author AND committer date (ISO 8601) for this one command. */
  readonly date?: string;
}

/** Runs git; throws with stderr on failure; returns trimmed stdout. */
export const gitIn = async (
  cwd: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<string> => {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      ...(options.as === undefined
        ? {}
        : {
            GIT_AUTHOR_NAME: options.as.name,
            GIT_AUTHOR_EMAIL: options.as.email,
            GIT_COMMITTER_NAME: options.as.name,
            GIT_COMMITTER_EMAIL: options.as.email,
          }),
      ...(options.date === undefined
        ? {}
        : { GIT_AUTHOR_DATE: options.date, GIT_COMMITTER_DATE: options.date }),
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${String(exitCode)}): ${stderr.trim()}`);
  }
  return stdout.trim();
};

const writeInto = async (root: string, relativePath: string, content: string): Promise<void> => {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
};

/** Writes one file and commits it; returns the new commit's full sha. */
export const commitFile = async (
  clone: string,
  relativePath: string,
  content: string,
  message: string,
  options: GitOptions = {},
): Promise<string> => {
  await writeInto(clone, relativePath, content);
  // Literally: a name like ":colon.ts" is a file here, not pathspec magic.
  await gitIn(clone, ["add", "--", `:(literal)${relativePath}`]);
  await gitIn(clone, ["commit", "-q", "-m", message], options);
  return gitIn(clone, ["rev-parse", "HEAD"]);
};

/**
 * `origin` with `main` and every branch in `landingBranches` at the same
 * first commit (README.md + src/lines.ts), Mike's clone of it, and Nick's
 * clone on a feature branch cut from `origin/main`.
 */
export const makeLandingRepos = async (
  label: string,
  landingBranches: readonly string[] = ["staging"],
): Promise<LandingRepos> => {
  const base = await mkdtemp(join(tmpdir(), `cx-landing-${label}-`));
  const origin = join(base, "origin.git");
  const teammate = join(base, "mike");
  const reader = join(base, "nick");
  await mkdir(origin);
  await gitIn(origin, ["init", "-q", "--bare", "--initial-branch=main"]);
  await mkdir(teammate);
  await gitIn(teammate, ["init", "-q", "--initial-branch=main"]);
  await gitIn(teammate, ["config", "user.name", MIKE.name]);
  await gitIn(teammate, ["config", "user.email", MIKE.email]);
  await writeInto(teammate, "README.md", "# fixture\n");
  await gitIn(teammate, ["add", "README.md"]);
  await commitFile(teammate, "src/lines.ts", "export const offset = 1;\n", "initial", {
    as: MIKE,
    date: "2026-01-05T09:00:00Z",
  });
  await gitIn(teammate, ["remote", "add", "origin", origin]);
  await gitIn(teammate, ["push", "-q", "origin", "main"]);
  for (const branch of landingBranches) {
    await gitIn(teammate, ["push", "-q", "origin", `main:${branch}`]);
  }
  await gitIn(base, ["clone", "-q", origin, reader]);
  await gitIn(reader, ["config", "user.name", NICK.name]);
  await gitIn(reader, ["config", "user.email", NICK.email]);
  await gitIn(reader, ["checkout", "-q", "-b", "nick/work", "origin/main"]);
  return { base, origin, teammate, reader };
};

let featureCounter = 0;

/**
 * Mike writes `content` to `file` on a feature branch and lands it on
 * `landing` as a merge commit made by `merger` at `landedAt`. The feature
 * commit keeps its own (older) date, the way a real merged branch does.
 * Returns the FEATURE commit's sha.
 */
export const landWithMergeCommit = async (
  repos: LandingRepos,
  input: {
    readonly file: string;
    readonly content: string;
    readonly subject: string;
    readonly landing: string;
    readonly writtenAt: string;
    readonly landedAt: string;
    readonly merger?: Person;
    readonly author?: Person;
  },
): Promise<string> => {
  const { teammate } = repos;
  featureCounter += 1;
  const feature = `feature/change-${String(featureCounter)}`;
  await gitIn(teammate, ["fetch", "-q", "origin"]);
  await gitIn(teammate, ["checkout", "-q", "-b", feature, `origin/${input.landing}`]);
  const sha = await commitFile(teammate, input.file, input.content, input.subject, {
    as: input.author ?? MIKE,
    date: input.writtenAt,
  });
  await gitIn(teammate, ["checkout", "-q", "-B", input.landing, `origin/${input.landing}`]);
  await gitIn(
    teammate,
    ["merge", "-q", "--no-ff", "-m", `Merge ${feature} into ${input.landing}`, feature],
    { as: input.merger ?? MIKE, date: input.landedAt },
  );
  await gitIn(teammate, ["push", "-q", "origin", input.landing]);
  return sha;
};

/** Mike lands one squashed commit straight onto `landing` at `landedAt`. */
export const landWithSquash = async (
  repos: LandingRepos,
  input: {
    readonly file: string;
    readonly content: string;
    readonly subject: string;
    readonly landing: string;
    readonly landedAt: string;
    readonly author?: Person;
  },
): Promise<string> => {
  const { teammate } = repos;
  await gitIn(teammate, ["fetch", "-q", "origin"]);
  await gitIn(teammate, ["checkout", "-q", "-B", input.landing, `origin/${input.landing}`]);
  const sha = await commitFile(teammate, input.file, input.content, input.subject, {
    as: input.author ?? MIKE,
    date: input.landedAt,
  });
  await gitIn(teammate, ["push", "-q", "origin", input.landing]);
  return sha;
};

/** The reader fetches, so its remote-tracking refs show what landed. */
export const readerFetches = async (repos: LandingRepos): Promise<void> => {
  await gitIn(repos.reader, ["fetch", "-q", "origin"]);
};
