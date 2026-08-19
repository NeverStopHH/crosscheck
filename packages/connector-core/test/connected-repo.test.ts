/**
 * The bounded upward walk behind path-derived repo resolution (trial
 * finding #9). The pins that matter are the TRUST pins: the walk stops at
 * the first git boundary whether or not that repo is connected, ignores
 * stray configs outside a repo root, and gives up at the level bound —
 * every null is silence, exactly what an unconnected repo must stay.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONNECTED_ROOT_WALK_MAX_LEVELS,
  findConnectedRepoRootForFile,
  findConnectedRepoRootForPaths,
} from "../src/config/connected-repo.ts";
import { renderRepoConfig } from "../src/config/repo-config.ts";

const HUB_URL = "http://127.0.0.1:7100";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

const makeDir = async (label: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), `cx-walk-${label}-`));
  paths.push(dir);
  return dir;
};

/** A fake repo root: a `.git` dir is enough — the walk spawns no git. */
const makeBoundary = async (
  root: string,
  options: { readonly connected: boolean; readonly gitAsFile?: boolean },
): Promise<void> => {
  if (options.gitAsFile === true) {
    await writeFile(join(root, ".git"), "gitdir: /elsewhere/.git\n", "utf8");
  } else {
    await mkdir(join(root, ".git"), { recursive: true });
  }
  if (options.connected) {
    await writeFile(
      join(root, ".crosscheck.json"),
      renderRepoConfig(HUB_URL),
      "utf8",
    );
  }
};

describe("findConnectedRepoRootForFile", () => {
  test("resolves a deep file to its connected repo root", async () => {
    // Arrange: workspace/monorepo is connected; the file sits levels down
    const workspace = await makeDir("deep");
    const repo = join(workspace, "monorepo");
    await mkdir(join(repo, "src", "auth", "tokens"), { recursive: true });
    await makeBoundary(repo, { connected: true });

    // Act: cwd is the PARENT workspace — the trial incident's shape
    const root = await findConnectedRepoRootForFile(
      workspace,
      join(repo, "src", "auth", "tokens", "verify.ts"),
    );

    // Assert
    expect(root).toBe(repo);
  });

  test("a worktree's `.git` FILE is a boundary too", async () => {
    // Arrange
    const workspace = await makeDir("worktree");
    const repo = join(workspace, "wt");
    await mkdir(join(repo, "src"), { recursive: true });
    await makeBoundary(repo, { connected: true, gitAsFile: true });

    // Act + Assert
    expect(
      await findConnectedRepoRootForFile(workspace, join(repo, "src", "a.ts")),
    ).toBe(repo);
  });

  test("an UNCONNECTED repo stays silent even under a connected ancestor", async () => {
    // Arrange: outer repo is connected, vendor/inner is its own repo WITHOUT
    // config — the nested-repo trust pin: the walk must not climb past the
    // inner boundary and let the outer repo capture the inner repo's files.
    const workspace = await makeDir("nested");
    const outer = join(workspace, "outer");
    const inner = join(outer, "vendor", "inner");
    await mkdir(join(inner, "src"), { recursive: true });
    await makeBoundary(outer, { connected: true });
    await makeBoundary(inner, { connected: false });

    // Act
    const root = await findConnectedRepoRootForFile(
      workspace,
      join(inner, "src", "lib.ts"),
    );

    // Assert
    expect(root).toBeNull();
  });

  test("a stray config in a plain directory (no .git) does not connect", async () => {
    // Arrange: config copied into a folder that is not a repo root
    const workspace = await makeDir("stray");
    const folder = join(workspace, "notes");
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, ".crosscheck.json"),
      renderRepoConfig(HUB_URL),
      "utf8",
    );

    // Act + Assert: no git boundary anywhere under the temp dir → null
    expect(
      await findConnectedRepoRootForFile(workspace, join(folder, "a.md")),
    ).toBeNull();
  });

  test("a config the walk passes OUTSIDE the repo boundary is ignored", async () => {
    // Arrange: workspace itself holds a stray config; the repo inside has
    // its own boundary WITHOUT config — the boundary answer (silence) wins.
    const workspace = await makeDir("outside");
    await writeFile(
      join(workspace, ".crosscheck.json"),
      renderRepoConfig(HUB_URL),
      "utf8",
    );
    const repo = join(workspace, "scratch");
    await mkdir(join(repo, "src"), { recursive: true });
    await makeBoundary(repo, { connected: false });

    // Act + Assert
    expect(
      await findConnectedRepoRootForFile(workspace, join(repo, "src", "x.ts")),
    ).toBeNull();
  });

  test("a `..`-spelled path cannot smuggle an OUTSIDE file into the repo", async () => {
    // Arrange: the file lives OUTSIDE any repo; only its SPELLING routes
    // through the connected repo. Without normalization the lexical dirname
    // chain visits `<repo>/..`, then `<repo>` — a non-ancestor — and answers
    // the connected root for a file the repo does not contain (found by the
    // adversarial review, executed repro).
    const workspace = await makeDir("dotdot");
    const repo = join(workspace, "monorepo");
    await mkdir(join(repo, "src"), { recursive: true });
    await makeBoundary(repo, { connected: true });
    const outside = join(workspace, "plain", "notes");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "x.md"), "# private\n", "utf8");

    // Act: spelled through the repo, normalizing to the outside dir. The
    // spelling is built by string concatenation on purpose: `join` would
    // collapse the `..` and hide exactly the input a hostile payload sends.
    const root = await findConnectedRepoRootForFile(
      workspace,
      `${repo}/../plain/notes/x.md`,
    );

    // Assert: the normalized location decides — not the spelling
    expect(root).toBeNull();
  });

  test("a file inside the repo's own .git metadata never resolves", async () => {
    // Arrange: `.git/config` sits under a connected repo, but git metadata
    // is not work — `git rev-parse` refuses to answer inside `.git`, and the
    // walk must not be looser than that (capture noise otherwise).
    const workspace = await makeDir("gitmeta");
    const repo = join(workspace, "monorepo");
    await mkdir(join(repo, "src"), { recursive: true });
    await makeBoundary(repo, { connected: true });

    // Act + Assert
    expect(
      await findConnectedRepoRootForFile(
        workspace,
        join(repo, ".git", "config"),
      ),
    ).toBeNull();
  });

  test("relative paths resolve against the hook's cwd", async () => {
    // Arrange
    const workspace = await makeDir("relative");
    const repo = join(workspace, "monorepo");
    await mkdir(join(repo, "src"), { recursive: true });
    await makeBoundary(repo, { connected: true });

    // Act
    const root = await findConnectedRepoRootForFile(
      workspace,
      join("monorepo", "src", "a.ts"),
    );

    // Assert
    expect(root).toBe(repo);
  });

  test("gives up silently past the level bound", async () => {
    // Arrange: a connected root with a file buried BELOW the walk bound
    const workspace = await makeDir("bound");
    const repo = join(workspace, "deep-repo");
    const levels = Array.from(
      { length: CONNECTED_ROOT_WALK_MAX_LEVELS + 1 },
      (_ignored, index) => `d${String(index)}`,
    );
    const deepDir = join(repo, ...levels);
    await mkdir(deepDir, { recursive: true });
    await makeBoundary(repo, { connected: true });

    // Act + Assert: the config exists but sits above the bound — null
    expect(
      await findConnectedRepoRootForFile(workspace, join(deepDir, "a.ts")),
    ).toBeNull();
  });
});

describe("findConnectedRepoRootForPaths", () => {
  test("first connected candidate wins; unconnected ones are skipped", async () => {
    // Arrange
    const workspace = await makeDir("multi");
    const scratch = join(workspace, "scratch");
    await mkdir(join(scratch, "src"), { recursive: true });
    await makeBoundary(scratch, { connected: false });
    const repo = join(workspace, "monorepo");
    await mkdir(join(repo, "src"), { recursive: true });
    await makeBoundary(repo, { connected: true });

    // Act
    const root = await findConnectedRepoRootForPaths(workspace, [
      join(scratch, "src", "notes.ts"),
      join(repo, "src", "a.ts"),
    ]);

    // Assert
    expect(root).toBe(repo);
  });

  test("caps the candidates it walks", async () => {
    // Arrange: the connected candidate sits past the cap
    const workspace = await makeDir("cap");
    const repo = join(workspace, "monorepo");
    await mkdir(join(repo, "src"), { recursive: true });
    await makeBoundary(repo, { connected: true });
    const outside = join(workspace, "plain");
    await mkdir(outside, { recursive: true });

    // Act: three unconnected candidates first, the connected one fourth
    const root = await findConnectedRepoRootForPaths(workspace, [
      join(outside, "a.ts"),
      join(outside, "b.ts"),
      join(outside, "c.ts"),
      join(repo, "src", "a.ts"),
    ]);

    // Assert
    expect(root).toBeNull();
  });
});
