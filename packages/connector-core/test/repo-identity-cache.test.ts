/**
 * REPO IDENTITY, CACHED PER WORKING DIRECTORY (batch-2 integration review,
 * M6). Every hook resolved its repo with four git spawns (and, for an ssh
 * remote, an `ssh -G`): 40 ms quiet, 90–108 ms under load, on every hook.
 * A directory's identity is now resolved by git once and then answered from
 * `cache/` while the files git would read say nothing changed — the root's
 * `.git`, HEAD, the configs that name the remote — and for at most
 * REPO_IDENTITY_CACHE_TTL_MS. HEAD's commit is re-read from the ref files on
 * every answer, so a commit moves `baseCommit` without git. Anything the
 * files cannot vouch for — a detached HEAD, a reftable repository, an
 * environment that steers git — is resolved by git every time.
 *
 * `resolve` is injected as a counting wrapper around the real resolver, so
 * "answered from the cache" is a count, not a stopwatch.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { TEST_REAL_HOME_ENV } from "../src/config/paths.ts";
import { REPO_IDENTITY_CACHE_TTL_MS } from "../src/constants.ts";
import { resolveRepoIdentity } from "../src/git/repo-identity.ts";
import type { RepoIdentity } from "../src/git/repo-identity.ts";
import { gitConfigPaths, resolveRepoIdentityCached } from "../src/git/repo-identity-cache.ts";

/** A real home that does not exist, so not even a test without the guard could read a real one. */
const ABSENT_REAL_HOME = "/cx-absent-real-home/someone";
import { git, makeHome, makeRepo, writeRepoFile } from "./helpers.ts";

const made: string[] = [];

afterEach(async () => {
  await Promise.all(made.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

interface Counted {
  readonly resolve: (cwd: string) => Promise<RepoIdentity | null>;
  readonly calls: () => number;
}

/** The real resolver, counted. */
const counted = (): Counted => {
  const state = { calls: 0 };
  return {
    resolve: async (cwd) => {
      state.calls += 1;
      return resolveRepoIdentity(cwd);
    },
    calls: () => state.calls,
  };
};

const fixture = async (label: string): Promise<{ readonly repo: string; readonly home: string }> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  made.push(repo, home);
  return { repo, home };
};

/** HEAD's commit as git names it. */
const headOf = async (repo: string): Promise<string | undefined> => (await resolveRepoIdentity(repo))?.baseCommit;

describe("a working directory's repo identity", () => {
  test("is resolved by git once, then answered from the cache with the same identity", async () => {
    // Arrange
    const { repo, home } = await fixture("ric-hit");
    const git1 = counted();

    // Act
    const first = await resolveRepoIdentityCached(home, repo, { resolve: git1.resolve });
    const second = await resolveRepoIdentityCached(home, repo, { resolve: git1.resolve });

    // Assert
    expect(first?.repoId).toBe("github.com/acme/api");
    expect(second).toEqual(first);
    expect(git1.calls()).toBe(1);
  });

  test("a commit moves the base commit without asking git again", async () => {
    // Arrange
    const { repo, home } = await fixture("ric-commit");
    const git1 = counted();
    await resolveRepoIdentityCached(home, repo, { resolve: git1.resolve });
    await writeRepoFile(repo, "src/a.ts", "export const a = 1;\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "a"]);

    // Act
    const after = await resolveRepoIdentityCached(home, repo, { resolve: git1.resolve });

    // Assert
    expect(after?.baseCommit).toBe(await headOf(repo));
    expect(git1.calls()).toBe(1);
  });

  test("a checkout of another branch is resolved by git again", async () => {
    // Arrange
    const { repo, home } = await fixture("ric-checkout");
    const git1 = counted();
    await resolveRepoIdentityCached(home, repo, { resolve: git1.resolve });
    await git(repo, ["checkout", "-q", "-b", "feat/other"]);

    // Act
    const after = await resolveRepoIdentityCached(home, repo, { resolve: git1.resolve });

    // Assert
    expect(after?.branch).toBe("feat/other");
    expect(git1.calls()).toBe(2);
  });

  test("a re-remoted checkout is resolved by git again, under its new id", async () => {
    // Arrange
    const { repo, home } = await fixture("ric-remote");
    const git1 = counted();
    await resolveRepoIdentityCached(home, repo, { resolve: git1.resolve });
    await git(repo, ["remote", "set-url", "origin", "git@github.com:acme/other.git"]);

    // Act
    const after = await resolveRepoIdentityCached(home, repo, { resolve: git1.resolve });

    // Assert
    expect(after?.repoId).toBe("github.com/acme/other");
    expect(git1.calls()).toBe(2);
  });

  test("an entry older than its TTL is resolved by git again", async () => {
    // Arrange
    const { repo, home } = await fixture("ric-ttl");
    const git1 = counted();
    const start = Date.now();
    await resolveRepoIdentityCached(home, repo, { resolve: git1.resolve, now: () => start });

    // Act
    await resolveRepoIdentityCached(home, repo, {
      resolve: git1.resolve,
      now: () => start + REPO_IDENTITY_CACHE_TTL_MS + 1,
    });

    // Assert
    expect(git1.calls()).toBe(2);
  });

  test("a detached HEAD is resolved by git every time", async () => {
    // Arrange
    const { repo, home } = await fixture("ric-detached");
    await git(repo, ["checkout", "-q", "--detach"]);
    const git1 = counted();

    // Act
    const first = await resolveRepoIdentityCached(home, repo, { resolve: git1.resolve });
    await resolveRepoIdentityCached(home, repo, { resolve: git1.resolve });

    // Assert
    expect(first?.branch.startsWith("detached@")).toBe(true);
    expect(git1.calls()).toBe(2);
  });

  test("a reftable repository is resolved by git every time", async () => {
    // Arrange
    const repo = await makeRepo("ric-reftable", { remote: "git@github.com:acme/api.git", refFormat: "reftable" });
    const home = await makeHome("ric-reftable");
    made.push(repo, home);
    const git1 = counted();

    // Act
    const first = await resolveRepoIdentityCached(home, repo, { resolve: git1.resolve });
    await resolveRepoIdentityCached(home, repo, { resolve: git1.resolve });

    // Assert
    expect(first?.repoId).toBe("github.com/acme/api");
    expect(git1.calls()).toBe(2);
  });

  test("a subdirectory that became a repo of its own is never answered with the outer one", async () => {
    // Arrange
    const { repo, home } = await fixture("ric-nested");
    const sub = join(repo, "packages", "inner");
    await mkdir(sub, { recursive: true });
    const git1 = counted();
    const outer = await resolveRepoIdentityCached(home, sub, { resolve: git1.resolve });
    await git(sub, ["init", "-q", "--initial-branch=main"]);

    // Act
    const inner = await resolveRepoIdentityCached(home, sub, { resolve: git1.resolve });

    // Assert
    expect(outer?.repoId).toBe("github.com/acme/api");
    expect(inner?.repoId).not.toBe("github.com/acme/api");
    expect(git1.calls()).toBe(2);
  });

  test("outside any repository: null, and nothing is cached", async () => {
    // Arrange
    const home = await makeHome("ric-none");
    const outside = await makeHome("ric-outside");
    made.push(home, outside);
    const git1 = counted();

    // Act
    const first = await resolveRepoIdentityCached(home, outside, { resolve: git1.resolve });
    await resolveRepoIdentityCached(home, outside, { resolve: git1.resolve });

    // Assert
    expect(first).toBeNull();
    expect(git1.calls()).toBe(2);
  });

  test("an environment that steers git (GIT_DIR) is resolved by git every time", async () => {
    // Arrange
    const { repo, home } = await fixture("ric-gitdir");
    const git1 = counted();
    await resolveRepoIdentityCached(home, repo, { resolve: git1.resolve });

    // Act: the same environment, GIT_DIR the one difference
    await resolveRepoIdentityCached(home, repo, {
      resolve: git1.resolve,
      gitEnv: { ...process.env, GIT_DIR: join(repo, ".git") },
    });

    // Assert
    expect(git1.calls()).toBe(2);
  });

  test("in a test process, the git and ssh configs of the real user's home are refused, on the path alone", () => {
    // Arrange: a recorded real home that does not exist
    const recorded = process.env[TEST_REAL_HOME_ENV];
    process.env[TEST_REAL_HOME_ENV] = ABSENT_REAL_HOME;

    try {
      // Act + Assert
      expect(() => gitConfigPaths("/repo/.git", "/repo/.git", { HOME: ABSENT_REAL_HOME })).toThrow("test home guard");
    } finally {
      if (recorded === undefined) {
        delete process.env[TEST_REAL_HOME_ENV];
      } else {
        process.env[TEST_REAL_HOME_ENV] = recorded;
      }
    }
  });
});
