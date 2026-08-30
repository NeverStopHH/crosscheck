/**
 * The post-commit pin sweep (regression-guard Stage 1).
 *
 * WHY IT EXISTS. Without it a rename silently kills a pin while `status`
 * still reports it registered: the pinned path stops matching any recorded
 * touch, nothing ever fires, and the surface reads as watched. That is the
 * fail-silent-dead shape the ladder forbids — and this repo renames weekly,
 * including one 60-file end-to-end rename.
 *
 * Driven against REAL git repositories, because the whole module is a claim
 * about what git says: a mocked `runGit` would only prove that the parser
 * parses its own fixture.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { sweepPinPaths } from "../src/git/pin-sweep.ts";
import { git, makeRepo, writeRepoFile } from "./helpers.ts";

const repos: string[] = [];

const repoWithPlayback = async (label: string): Promise<string> => {
  const root = await makeRepo(label);
  repos.push(root);
  await writeRepoFile(root, "src/workbench/usePlayback.ts", "export const play = 1;\n");
  await writeRepoFile(root, "src/workbench/Controls.tsx", "export const Controls = 1;\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "workbench"]);
  return root;
};

afterAll(async () => {
  await Promise.all(repos.map((root) => rm(root, { recursive: true, force: true })));
});

describe("sweepPinPaths", () => {
  test("reports a file that is still there as present, under its own name", async () => {
    // Arrange
    const root = await repoWithPlayback("sweep-present");

    // Act
    const swept = await sweepPinPaths(root, ["src/workbench/usePlayback.ts"]);

    // Assert
    expect(swept).toEqual([
      {
        path: "src/workbench/usePlayback.ts",
        resolved: "src/workbench/usePlayback.ts",
        status: "present",
      },
    ]);
  });

  test("follows an unambiguous rename to the file's new name", async () => {
    // Arrange
    const root = await repoWithPlayback("sweep-renamed");
    await git(root, [
      "mv",
      "src/workbench/usePlayback.ts",
      "src/workbench/usePlaybackState.ts",
    ]);
    await git(root, ["commit", "-m", "rename the playback hook"]);

    // Act
    const swept = await sweepPinPaths(root, ["src/workbench/usePlayback.ts"]);

    // Assert: the pin keeps watching the same behaviour under its new name.
    expect(swept[0]).toEqual({
      path: "src/workbench/usePlayback.ts",
      resolved: "src/workbench/usePlaybackState.ts",
      status: "renamed",
    });
  });

  test("follows a rename chain, so two moves in a week do not lose the pin", async () => {
    // Arrange
    const root = await repoWithPlayback("sweep-chain");
    await git(root, [
      "mv",
      "src/workbench/usePlayback.ts",
      "src/workbench/usePlaybackState.ts",
    ]);
    await git(root, ["commit", "-m", "rename once"]);
    // A cross-directory move, which is what this repo's weekly renames
    // actually look like — the 60-file end-to-end rename moved directories.
    await mkdir(join(root, "src", "playback"), { recursive: true });
    await git(root, [
      "mv",
      "src/workbench/usePlaybackState.ts",
      "src/playback/useState.ts",
    ]);
    await git(root, ["commit", "-m", "rename again"]);

    // Act
    const swept = await sweepPinPaths(root, ["src/workbench/usePlayback.ts"]);

    // Assert
    expect(swept[0]?.resolved).toBe("src/playback/useState.ts");
    expect(swept[0]?.status).toBe("renamed");
  });

  test("marks a deleted file missing — a pin on nothing must be loud", async () => {
    // Arrange
    const root = await repoWithPlayback("sweep-missing");
    await git(root, ["rm", "-q", "src/workbench/usePlayback.ts"]);
    await git(root, ["commit", "-m", "drop the playback hook"]);

    // Act
    const swept = await sweepPinPaths(root, ["src/workbench/usePlayback.ts"]);

    // Assert
    expect(swept[0]?.status).toBe("missing");
    expect(swept[0]?.resolved).toBeNull();
  });

  test("sweeps a mixed set in one pass", async () => {
    // Arrange
    const root = await repoWithPlayback("sweep-mixed");
    await git(root, [
      "mv",
      "src/workbench/usePlayback.ts",
      "src/workbench/usePlaybackState.ts",
    ]);
    await git(root, ["commit", "-m", "rename"]);

    // Act
    const swept = await sweepPinPaths(root, [
      "src/workbench/Controls.tsx",
      "src/workbench/usePlayback.ts",
      "src/workbench/never-existed.ts",
    ]);

    // Assert
    expect(swept.map((entry) => entry.status)).toEqual([
      "present",
      "renamed",
      "missing",
    ]);
  });

  test("reports UNKNOWN rather than missing when git cannot answer", async () => {
    // Arrange: a directory that is not a repository. "Missing" here would be
    // a lie that retires somebody's pin; "unknown" is a fact doctor prints.
    const notARepo = await makeRepo("sweep-outside");
    repos.push(notARepo);
    await rm(`${notARepo}/.git`, { recursive: true, force: true });

    // Act
    const swept = await sweepPinPaths(notARepo, ["src/workbench/usePlayback.ts"]);

    // Assert
    expect(swept[0]?.status).toBe("unknown");
    expect(swept[0]?.resolved).toBeNull();
  });

  test("bounds the sweep, and says which paths it did not look at", async () => {
    // Arrange: more paths than one sweep may read. The cap is a bound on the
    // WORK, so the paths past it come back "unknown" — never "present",
    // which would silently vouch for files nobody looked at.
    const root = await repoWithPlayback("sweep-cap");
    const { PIN_SWEEP_MAX_PATHS } = await import("../src/constants.ts");
    const paths = Array.from(
      { length: PIN_SWEEP_MAX_PATHS + 3 },
      (_unused, index) => `src/workbench/f-${String(index)}.ts`,
    );

    // Act
    const swept = await sweepPinPaths(root, paths);

    // Assert
    expect(swept).toHaveLength(paths.length);
    expect(swept.at(-1)?.status).toBe("unknown");
  });
});
