/**
 * DID THE FIX GO INTO WHAT ONLY THE NAMED SESSION TOUCHED (1.0 spec 07 §3.4,
 * corrected) — proof 3's hit or miss, decided on the reader's own clone
 * because the hub holds no repository.
 *
 * A REAL git repository, because every interesting case is a fact about git.
 * What these pin, in order of how quietly each would go wrong:
 *
 *   · a hit needs POSITIVE evidence: the fix changed a file only the named
 *     session touched. The first version scored the pinned files every
 *     candidate touched, and an innocent session scored the same hit as the
 *     one that broke it;
 *   · a fix that changed only pinned files is `not_discriminating`, never a
 *     hit and never a miss;
 *   · a revert is a fix — the range starts where the break was RECORDED, so
 *     the revert is inside it and the breaking change is not;
 *   · renames, non-ASCII names, the bound, and nothing flag-shaped at git.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { PILOT_FIX_DIFF_MAX_FILES } from "../src/constants.ts";
import { scoreFix } from "../src/git/fix-diff.ts";
import { runGit } from "../src/git/git.ts";
import { git, makeRepo, writeRepoFile } from "./helpers.ts";

/** The pin's file — every candidate touched it. */
const PINNED = "src/workbench/usePlayback.ts";
/** A file only the named session touched, outside the pin. */
const OWN = "src/config.ts";
/** A file the named session never touched. */
const ELSEWHERE = "src/other.ts";

let repo: string;

const head = async (): Promise<string> => {
  const sha = await runGit(["rev-parse", "HEAD"], repo);
  if (sha === null) {
    throw new Error("no HEAD");
  }
  return sha;
};

const commitAll = async (message: string): Promise<string> => {
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", message]);
  return head();
};

let version = 0;
/** Changes each file and commits, returning the new commit. */
const change = async (...files: readonly string[]): Promise<string> => {
  version += 1;
  for (const file of files) {
    await writeRepoFile(repo, file, `export const v = ${String(version)};\n`);
  }
  return commitAll(`change ${files.join(", ")}`);
};

const score = (
  brokenCommit: string,
  repairCommit: string,
  namedFiles: readonly string[] = [OWN],
) =>
  scoreFix(repo, {
    brokenCommit,
    repairCommit,
    pinnedFiles: [PINNED],
    namedFiles,
  });

beforeAll(async () => {
  repo = await makeRepo("fix-diff");
  await writeRepoFile(repo, PINNED, "export const play = 1;\n");
  await writeRepoFile(repo, OWN, "export const config = 1;\n");
  await writeRepoFile(repo, ELSEWHERE, "export const other = 1;\n");
  await commitAll("baseline");
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("scoreFix", () => {
  test("a fix that went into what only the named session touched is a hit", async () => {
    // Arrange
    const broken = await head();
    const repaired = await change(OWN);

    // Act & Assert
    expect(await score(broken, repaired)).toBe("hit");
  });

  test("a fix that went entirely elsewhere is a miss", async () => {
    // Arrange
    const broken = await head();
    const repaired = await change(ELSEWHERE);

    // Act & Assert
    expect(await score(broken, repaired)).toBe("miss");
  });

  test("a fix that changed only the pinned file cannot tell candidates apart", async () => {
    // Arrange — every candidate touched the pinned file; this is the case the
    // first version scored as a hit for whoever was named
    const broken = await head();
    const repaired = await change(PINNED);

    // Act & Assert
    expect(await score(broken, repaired)).toBe("not_discriminating");
  });

  test("the pinned file changing too does not hide a hit", async () => {
    // Arrange
    const broken = await head();
    const repaired = await change(PINNED, OWN);

    // Act & Assert
    expect(await score(broken, repaired)).toBe("hit");
  });

  test("a session that touched only the pinned file is a miss when the fix went elsewhere", async () => {
    // Arrange — nothing of its own, and the fix did not touch the pin either
    const broken = await head();
    const repaired = await change(ELSEWHERE);

    // Act & Assert
    expect(await score(broken, repaired, [])).toBe("miss");
  });

  test("a REVERT is a fix, because the range starts where the break was recorded", async () => {
    // Arrange — the breaking change lands on the named session's own file,
    // the break is recorded at that commit, and the fix reverts it
    const breaking = await change(OWN);
    await git(repo, ["revert", "--no-edit", "HEAD"]);
    const repaired = await head();

    // Act & Assert — from the last-working commit this netted to nothing
    expect(await score(breaking, repaired)).toBe("hit");
  });

  test("a fix that RENAMED the named session's file is still a hit", async () => {
    // Arrange — with rename detection, `--name-only` lists only the NEW path
    const broken = await head();
    await git(repo, ["mv", OWN, "src/settings.ts"]);
    const repaired = await commitAll("rename config");

    // Act & Assert
    expect(await score(broken, repaired)).toBe("hit");
    await git(repo, ["mv", "src/settings.ts", OWN]);
    await commitAll("rename back");
  });

  test("a named file with a non-ASCII name is matched as written", async () => {
    // Arrange — git QUOTES such a path in its newline output
    const umlaut = "src/wörkbench/Wiedergabe.ts";
    await writeRepoFile(repo, umlaut, "export const a = 1;\n");
    const broken = await commitAll("add umlaut file");
    const repaired = await change(umlaut);

    // Act & Assert
    expect(await score(broken, repaired, [umlaut])).toBe("hit");
  });

  test("an EMPTY range is its own outcome, not a miss", async () => {
    // Arrange & Act & Assert
    const same = await head();
    expect(await score(same, same)).toBe("empty");
  });

  test("a fix wider than the bound is too broad to score, even with the named file in it", async () => {
    // Arrange
    const broken = await head();
    await writeRepoFile(repo, OWN, "export const config = 99;\n");
    await Promise.all(
      Array.from({ length: PILOT_FIX_DIFF_MAX_FILES }, (_, index) =>
        writeRepoFile(repo, `vendor/drop-${String(index)}.ts`, "x\n"),
      ),
    );
    const repaired = await commitAll("vendored drop plus the fix");

    // Act & Assert
    expect(await score(broken, repaired)).toBe("too_broad");
  });

  test("a fix of exactly the bound is still scored", async () => {
    // Arrange
    const broken = await head();
    await writeRepoFile(repo, OWN, "export const config = 100;\n");
    await Promise.all(
      Array.from({ length: PILOT_FIX_DIFF_MAX_FILES - 1 }, (_, index) =>
        writeRepoFile(repo, `vendor/drop-${String(index)}.ts`, "y\n"),
      ),
    );
    const repaired = await commitAll("exactly the bound");

    // Act & Assert
    expect(await score(broken, repaired)).toBe("hit");
  });

  test("a range this clone does not have is unresolvable, never a miss", async () => {
    // Arrange & Act & Assert
    const repaired = await head();
    expect(await score("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", repaired)).toBe(
      "unresolvable",
    );
  });

  test("a commit id shaped like a flag never reaches git", async () => {
    // Arrange — `--output=<file>` is a real `git diff` option
    const repaired = await head();
    const planted = join(repo, "pwned");

    // Act
    const outcome = await score(`--output=${planted}`, repaired);

    // Assert
    expect(outcome).toBe("unresolvable");
    expect(existsSync(planted)).toBe(false);
  });
});
