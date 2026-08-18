import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { resolveCommitDrift, resolveDriftByBaseCommit } from "../src/index.ts";
import { runGit } from "../src/git/git.ts";
import { git, makeRepo, writeRepoFile } from "./helpers.ts";

const repos: string[] = [];

const repo = async (label: string): Promise<string> => {
  const path = await makeRepo(label);
  repos.push(path);
  return path;
};

const commit = async (root: string, file: string): Promise<void> => {
  await writeRepoFile(root, file, `export const value = "${file}";\n`);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", `add ${file}`]);
};

const headSha = async (root: string): Promise<string> =>
  (await runGit(["rev-parse", "HEAD"], root)) ?? "";

afterEach(async () => {
  await Promise.all(repos.map((path) => rm(path, { recursive: true, force: true })));
  repos.length = 0;
});

describe("resolveCommitDrift", () => {
  test("counts how far a teammate's base sits behind the reader's HEAD", async () => {
    // Arrange: the teammate branched two commits ago
    const root = await repo("drift-behind");
    const base = await headSha(root);
    await commit(root, "a.ts");
    await commit(root, "b.ts");

    // Act
    const drift = await resolveCommitDrift(root, base);

    // Assert
    expect(drift).toEqual({ ahead: 0, behind: 2 });
  });

  test("returns null for a commit this checkout has never seen", async () => {
    // Arrange
    const root = await repo("drift-unknown");

    // Act
    const drift = await resolveCommitDrift(root, "b".repeat(40));

    // Assert
    expect(drift).toBeNull();
  });

  test("refuses a base commit that is not a plain object name", async () => {
    // Arrange: a hostile hub could otherwise smuggle a git flag
    const root = await repo("drift-flag");

    // Act
    const drift = await resolveCommitDrift(root, "--output=/tmp/pwned");

    // Assert
    expect(drift).toBeNull();
  });
});

describe("resolveDriftByBaseCommit", () => {
  test("maps only the base commits it could resolve", async () => {
    // Arrange
    const root = await repo("drift-map");
    const base = await headSha(root);

    // Act
    const drift = await resolveDriftByBaseCommit(root, [
      base,
      "c".repeat(40),
      base,
    ]);

    // Assert
    expect(Object.keys(drift)).toEqual([base]);
    expect(drift[base]).toEqual({ ahead: 0, behind: 0 });
  });
});
