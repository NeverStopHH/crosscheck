import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeRemoteUrl, resolveRepoIdentity } from "../src/index.ts";
import { git, makeRepo } from "./helpers.ts";

describe("normalizeRemoteUrl", () => {
  test("collapses every equivalent remote spelling to one repo id", () => {
    // Arrange
    const remotes = [
      "git@github.com:acme/api.git",
      "https://github.com/Acme/API/",
      "ssh://git@github.com:22/acme/api.git",
      "https://token@github.com/acme/api",
      "github.com/acme/api",
    ];

    // Act
    const normalized = remotes.map(normalizeRemoteUrl);

    // Assert
    expect(normalized).toEqual(remotes.map(() => "github.com/acme/api"));
  });

  test("returns null for an empty remote", () => {
    expect(normalizeRemoteUrl("   ")).toBeNull();
  });
});

describe("resolveRepoIdentity", () => {
  test("derives the repo id from the origin remote", async () => {
    // Arrange
    const repo = await makeRepo("origin-remote", {
      remote: "git@github.com:acme/api.git",
    });

    // Act
    const identity = await resolveRepoIdentity(repo);

    // Assert
    expect(identity?.repoId).toBe("github.com/acme/api");
    expect(identity?.branch.length).toBeGreaterThan(0);
    expect(identity?.baseCommit.length).toBe(40);
    await rm(repo, { recursive: true, force: true });
  });

  test("falls back to a local id when the repo has no remote", async () => {
    // Arrange
    const repo = await makeRepo("no-remote");

    // Act
    const identity = await resolveRepoIdentity(repo);

    // Assert
    // A hash and nothing else: no local directory name may reach a teammate.
    expect(identity?.repoId).toMatch(/^local:[0-9a-f]{12}$/);
    expect(identity?.repoId).not.toContain("cx-no-remote");
    await rm(repo, { recursive: true, force: true });
  });

  test("gives a remote-less worktree the same id as its main checkout", async () => {
    // Arrange
    const repo = await makeRepo("worktree-main");
    const worktree = `${repo}-linked`;
    await git(repo, ["worktree", "add", "-b", "side", worktree]);

    // Act
    const main = await resolveRepoIdentity(repo);
    const linked = await resolveRepoIdentity(worktree);

    // Assert
    expect(linked?.repoId).toBe(main?.repoId as string);
    await rm(worktree, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  });

  test("keeps two remote-less checkouts of one template apart", async () => {
    // Arrange: same root commit, two unrelated working copies
    const source = await makeRepo("template");
    const clone = `${source}-clone`;
    await git(source, ["clone", source, clone]);
    await git(clone, ["remote", "remove", "origin"]);

    // Act
    const first = await resolveRepoIdentity(source);
    const second = await resolveRepoIdentity(clone);

    // Assert
    expect(first?.repoId).toMatch(/^local:/);
    expect(second?.repoId).toMatch(/^local:/);
    expect(second?.repoId).not.toBe(first?.repoId as string);
    await rm(clone, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  });

  test("returns null outside a git repository", async () => {
    // Arrange
    const plain = await mkdtemp(join(tmpdir(), "cx-plain-"));

    // Act
    const identity = await resolveRepoIdentity(plain);

    // Assert
    expect(identity).toBeNull();
    await rm(plain, { recursive: true, force: true });
  });
});
