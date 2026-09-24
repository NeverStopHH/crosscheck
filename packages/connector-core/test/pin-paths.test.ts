/**
 * THE PIN DOOR ASKS GIT (1.0 spec 01a §3.3d, CSK-28).
 *
 * Canonicalisation settles `./`, `//` and Unicode form. It cannot settle two
 * everyday mistakes that produce a path which LOOKS resolved and matches
 * nothing: a wrong case typed on a case-insensitive disk, and a path typed
 * relative to a subdirectory. A pin stored in either spelling protects nothing,
 * `suspect` answers "nobody touched it", and 01a's sweep would read "no pin
 * references this session" and delete behind it. So the door asks git whether
 * it tracks exactly that file, and refuses — with the reason and, where git
 * can say, the spelling it does track — rather than storing a guess.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolvePinPaths } from "../src/git/pin-paths.ts";
import { git, makeRepo, writeRepoFile } from "./helpers.ts";

let repo: string;

beforeAll(async () => {
  repo = await makeRepo("pin-paths");
  await writeRepoFile(repo, "src/x.ts", "export const x = 1;\n");
  await writeRepoFile(repo, "src/Auth.ts", "export const auth = 1;\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "files"]);
  await writeRepoFile(repo, "src/untracked.ts", "export const u = 1;\n");
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("resolvePinPaths", () => {
  test("a tracked file, however it was spelled, is stored as git spells it", async () => {
    // Arrange & Act
    const result = await resolvePinPaths(repo, repo, ["src/x.ts", "./src/x.ts", "src//x.ts"]);

    // Assert
    expect(result).toEqual({ ok: true, paths: ["src/x.ts"] });
  });

  test("a wrong case is refused, never resolved into a spelling that matches nothing", async () => {
    // Arrange & Act — git tracks src/Auth.ts
    const result = await resolvePinPaths(repo, repo, ["src/auth.ts"]);

    // Assert
    expect(result).toEqual({
      ok: false,
      refused: [{ path: "src/auth.ts", reason: "not_tracked", suggestion: null }],
    });
  });

  test("a path typed from a subdirectory is refused, with the repo-relative spelling offered", async () => {
    // Arrange & Act — standing in src/, the person typed x.ts
    const result = await resolvePinPaths(repo, join(repo, "src"), ["x.ts"]);

    // Assert — refused: pin paths are repo-relative, and guessing which one
    // was meant is how a wrong identity gets stored
    expect(result).toEqual({
      ok: false,
      refused: [{ path: "x.ts", reason: "not_tracked", suggestion: "src/x.ts" }],
    });
  });

  test("the spelling is offered from a symlinked checkout too", async () => {
    // Arrange — git reports the REAL root; the shell stands in the link. On
    // macOS every temp dir is such a pair (/var → /private/var), and path
    // arithmetic across the two spellings reads as `../../..` and offers nothing.
    const links = await mkdtemp(join(tmpdir(), "cx-pin-paths-link-"));
    const linked = join(links, "checkout");
    await symlink(repo, linked);

    // Act
    const result = await resolvePinPaths(repo, join(linked, "src"), ["x.ts"]);

    // Assert
    expect(result).toEqual({
      ok: false,
      refused: [{ path: "x.ts", reason: "not_tracked", suggestion: "src/x.ts" }],
    });
    await rm(links, { recursive: true, force: true });
  });

  test("from a subdirectory, a path git tracks from the root AND from there is refused as ambiguous", async () => {
    // Arrange — the monorepo shape: src/x.ts at the root, and src/src/x.ts
    // under the directory the person stands in
    await writeRepoFile(repo, "src/src/x.ts", "export const nested = 1;\n");
    await git(repo, ["add", "src/src/x.ts"]);
    await git(repo, ["commit", "-m", "nested"]);

    // Act — standing in src/, typing src/x.ts
    const result = await resolvePinPaths(repo, join(repo, "src"), ["src/x.ts"]);

    // Assert — never silently the root file
    expect(result).toEqual({
      ok: false,
      refused: [{ path: "src/x.ts", reason: "ambiguous", suggestion: "src/src/x.ts" }],
    });
  });

  test("from a subdirectory, a repo-relative path git tracks only from the root is accepted", async () => {
    // Act — standing in src/, typing the repo-relative src/Auth.ts
    const result = await resolvePinPaths(repo, join(repo, "src"), ["src/Auth.ts"]);

    // Assert
    expect(result).toEqual({ ok: true, paths: ["src/Auth.ts"] });
  });

  test("a submodule is not a file", async () => {
    // Arrange — a gitlink in the index, as `git submodule add` leaves one
    const head = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: repo }).stdout.toString().trim();
    await git(repo, ["update-index", "--add", "--cacheinfo", `160000,${head},vendor/lib`]);

    // Act
    const result = await resolvePinPaths(repo, repo, ["vendor/lib"]);

    // Assert
    expect(result).toEqual({
      ok: false,
      refused: [{ path: "vendor/lib", reason: "submodule", suggestion: null }],
    });
  });

  test("a directory is not a file", async () => {
    // Arrange & Act — git's pathspec would happily list every file under it
    const result = await resolvePinPaths(repo, repo, ["src"]);

    // Assert
    expect(result).toEqual({
      ok: false,
      refused: [{ path: "src", reason: "directory", suggestion: null }],
    });
  });

  test("a file git does not track is refused", async () => {
    // Arrange & Act
    const result = await resolvePinPaths(repo, repo, ["src/untracked.ts"]);

    // Assert
    expect(result).toEqual({
      ok: false,
      refused: [{ path: "src/untracked.ts", reason: "not_tracked", suggestion: null }],
    });
  });

  test("a path that cannot be a repo file is refused before git is asked", async () => {
    // Arrange & Act
    const result = await resolvePinPaths(repo, repo, ["../outside.ts"]);

    // Assert
    expect(result).toEqual({
      ok: false,
      refused: [{ path: "../outside.ts", reason: "parent_segment", suggestion: null }],
    });
  });

  test("a repository whose index git cannot read refuses as unanswered, not as untracked", async () => {
    // Arrange — rev-parse still answers; ls-files cannot read the index. The
    // person must be told git did not answer, not sent looking for a typo.
    const broken = await makeRepo("pin-paths-broken-index");
    await writeRepoFile(broken, "src/x.ts", "export const x = 1;\n");
    await git(broken, ["add", "-A"]);
    await git(broken, ["commit", "-m", "files"]);
    await Bun.write(join(broken, ".git", "index"), "not an index");

    // Act
    const result = await resolvePinPaths(broken, broken, ["src/x.ts"]);

    // Assert
    expect(result).toEqual({
      ok: false,
      refused: [{ path: "src/x.ts", reason: "git_unanswered", suggestion: null }],
    });
    await rm(broken, { recursive: true, force: true });
  });

  test("a git that cannot answer refuses everything — nothing is stored unverified", async () => {
    // Arrange — not a repository at all
    const nowhere = await mkdtemp(join(tmpdir(), "cx-pin-paths-norepo-"));

    // Act
    const result = await resolvePinPaths(nowhere, nowhere, ["src/x.ts"]);

    // Assert
    expect(result).toEqual({
      ok: false,
      refused: [{ path: "src/x.ts", reason: "git_unanswered", suggestion: null }],
    });
    await rm(nowhere, { recursive: true, force: true });
  });
});
