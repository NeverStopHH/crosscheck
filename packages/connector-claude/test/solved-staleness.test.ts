/**
 * The solved tree's staleness check (honest presentation): have the files a
 * solved diagnosis referenced changed on the default branch since it was
 * recorded? Three honest answers — changed, unchanged, unknown — and every
 * failure lands on "unknown", never on a confident guess.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { checkSolvedFileDrift } from "../src/git/solved-staleness.ts";
import { git, makeRepo } from "./helpers.ts";

const HOUR_MS = 3_600_000;

/** A repo whose origin/main has one tracked file, with a known history. */
const makeOriginRepo = async (): Promise<string> => {
  const root = await makeRepo("staleness");
  await git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return root;
};

const commitFileChange = async (
  root: string,
  file: string,
  committedAtIso?: string,
): Promise<void> => {
  await writeFile(join(root, file), `// touched ${Date.now()}\n`, "utf8");
  await git(root, ["add", "."]);
  if (committedAtIso === undefined) {
    await git(root, ["commit", "-q", "-m", `touch ${file}`]);
  } else {
    // --since filters on COMMITTER date, so the committer date is what the
    // fixture must control; the helper's env has no slot for it, hence -c.
    const proc = Bun.spawn({
      cmd: ["git", "commit", "-q", "-m", `touch ${file}`],
      cwd: root,
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_DATE: committedAtIso,
        GIT_COMMITTER_DATE: committedAtIso,
      },
    });
    if ((await proc.exited) !== 0) {
      throw new Error(`dated commit of ${file} failed`);
    }
  }
  await git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
};

describe("checkSolvedFileDrift", () => {
  test("a referenced file committed after the diagnosis reads as changed", async () => {
    // Arrange: diagnosis an hour ago, README touched on origin/main now.
    const root = await makeOriginRepo();
    const sinceIso = new Date(Date.now() - HOUR_MS).toISOString();
    await commitFileChange(root, "README.md");

    // Act
    const state = await checkSolvedFileDrift(
      root,
      "origin/main",
      ["README.md"],
      sinceIso,
    );

    // Assert
    expect(state).toBe("changed");
  });

  test("untouched referenced files read as unchanged", async () => {
    // Arrange: the diagnosis postdates every commit touching the file.
    const root = await makeOriginRepo();
    const sinceIso = new Date(Date.now() + HOUR_MS).toISOString();

    // Act
    const state = await checkSolvedFileDrift(
      root,
      "origin/main",
      ["README.md"],
      sinceIso,
    );

    // Assert
    expect(state).toBe("unchanged");
  });

  test("a change to an unrelated file does not read as changed", async () => {
    // Arrange: the diagnosis postdates the initial commit (which touched
    // README.md), and the only LATER commit touches a different file — a
    // broken pathspec would count it and report "changed".
    const root = await makeOriginRepo();
    const sinceIso = new Date(Date.now() + HOUR_MS).toISOString();
    await commitFileChange(
      root,
      "other.ts",
      new Date(Date.now() + 2 * HOUR_MS).toISOString(),
    );

    // Act
    const state = await checkSolvedFileDrift(
      root,
      "origin/main",
      ["README.md"],
      sinceIso,
    );

    // Assert
    expect(state).toBe("unchanged");
  });

  test("outside a repo the answer is unknown, not a guess", async () => {
    // Act
    const state = await checkSolvedFileDrift(
      tmpdir(),
      "origin/main",
      ["README.md"],
      new Date().toISOString(),
    );

    // Assert
    expect(state).toBe("unknown");
  });

  test("no usable paths means unknown — there is nothing to vouch for", async () => {
    // Arrange: flag-shaped entries are dropped before git ever runs.
    const root = await makeOriginRepo();

    // Act
    const state = await checkSolvedFileDrift(
      root,
      "origin/main",
      ["--all", ""],
      new Date().toISOString(),
    );

    // Assert
    expect(state).toBe("unknown");
  });
});
