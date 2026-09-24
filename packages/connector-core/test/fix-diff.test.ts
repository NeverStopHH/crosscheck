/**
 * DID THE FIX TOUCH WHAT THE ANSWER NAMED (1.0 spec 07 §3.4) — proof 3's hit
 * or miss, decided on the reader's own clone because the hub holds no
 * repository.
 *
 * A REAL git repository, because every interesting case is a fact about git:
 * a rename, a range nobody's clone has, a commit id shaped like a flag. What
 * these pin, in order of how quietly each would go wrong:
 *
 *   · a fix that RENAMED the named file is a hit — with rename detection on,
 *     `--name-only` prints only the new name and the answer is scored wrong;
 *   · a fix past PILOT_FIX_DIFF_MAX_FILES is `too_broad`, never a hit — five
 *     hundred files touch the named one by accident;
 *   · an EMPTY range is not a miss — nothing changed between the two
 *     verifications, so the break was not in the code the answer searched;
 *   · a range this clone cannot resolve is `unresolvable`, never a miss;
 *   · nothing flag-shaped ever reaches git.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { PILOT_FIX_DIFF_MAX_FILES } from "../src/constants.ts";
import { scoreFix } from "../src/git/fix-diff.ts";
import { runGit } from "../src/git/git.ts";
import { git, makeRepo, writeRepoFile } from "./helpers.ts";

const NAMED = "src/workbench/usePlayback.ts";
const OTHER = "src/other.ts";

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

beforeAll(async () => {
  repo = await makeRepo("fix-diff");
  await writeRepoFile(repo, NAMED, "export const play = 1;\n");
  await writeRepoFile(repo, OTHER, "export const other = 1;\n");
  await commitAll("baseline");
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("scoreFix", () => {
  test("a fix that changed a named file is a hit", async () => {
    // Arrange
    const broken = await head();
    await writeRepoFile(repo, NAMED, "export const play = 2;\n");
    const repaired = await commitAll("fix playback");

    // Act
    const outcome = await scoreFix(repo, {
      brokenCommit: broken,
      repairCommit: repaired,
      namedFiles: [NAMED],
    });

    // Assert
    expect(outcome).toBe("hit");
  });

  test("a fix that changed only other files is a miss", async () => {
    // Arrange
    const broken = await head();
    await writeRepoFile(repo, OTHER, "export const other = 2;\n");
    const repaired = await commitAll("fix elsewhere");

    // Act
    const outcome = await scoreFix(repo, {
      brokenCommit: broken,
      repairCommit: repaired,
      namedFiles: [NAMED],
    });

    // Assert
    expect(outcome).toBe("miss");
  });

  test("a fix that RENAMED the named file is still a hit", async () => {
    // Arrange — the fix moved the file the answer named. With rename
    // detection, `--name-only` lists only the NEW path, the named one never
    // appears, and a right answer is scored as wrong.
    const broken = await head();
    await git(repo, ["mv", NAMED, "src/workbench/playback.ts"]);
    const repaired = await commitAll("rename playback");

    // Act
    const outcome = await scoreFix(repo, {
      brokenCommit: broken,
      repairCommit: repaired,
      namedFiles: [NAMED],
    });

    // Assert
    expect(outcome).toBe("hit");
    // Restore the layout for the tests below.
    await git(repo, ["mv", "src/workbench/playback.ts", NAMED]);
    await commitAll("rename back");
  });

  test("a named file with a non-ASCII name is matched as written", async () => {
    // Arrange — git QUOTES such a path in its newline output, and the quoted
    // spelling never equals the pinned one.
    const umlaut = "src/wörkbench/Wiedergabe.ts";
    await writeRepoFile(repo, umlaut, "export const a = 1;\n");
    const broken = await commitAll("add umlaut file");
    await writeRepoFile(repo, umlaut, "export const a = 2;\n");
    const repaired = await commitAll("fix umlaut file");

    // Act
    const outcome = await scoreFix(repo, {
      brokenCommit: broken,
      repairCommit: repaired,
      namedFiles: [umlaut],
    });

    // Assert
    expect(outcome).toBe("hit");
  });

  test("an EMPTY range is its own outcome, not a miss", async () => {
    // Arrange — broken and repaired at the same commit: nothing in history
    // changed between the two verifications, so whatever broke was not in
    // the code the answer searched, and a miss would blame the answer.
    const same = await head();

    // Act
    const outcome = await scoreFix(repo, {
      brokenCommit: same,
      repairCommit: same,
      namedFiles: [NAMED],
    });

    // Assert
    expect(outcome).toBe("empty");
  });

  test("a fix wider than the bound is too broad to score, even when it touched a named file", async () => {
    // Arrange — one past the bound, with the named file among them.
    const broken = await head();
    await writeRepoFile(repo, NAMED, "export const play = 3;\n");
    await Promise.all(
      Array.from({ length: PILOT_FIX_DIFF_MAX_FILES }, (_, index) =>
        writeRepoFile(repo, `vendor/drop-${String(index)}.ts`, "x\n"),
      ),
    );
    const repaired = await commitAll("vendored drop plus the fix");

    // Act
    const outcome = await scoreFix(repo, {
      brokenCommit: broken,
      repairCommit: repaired,
      namedFiles: [NAMED],
    });

    // Assert
    expect(outcome).toBe("too_broad");
  });

  test("a fix of exactly the bound is still scored", async () => {
    // Arrange — the bound is inclusive: PILOT_FIX_DIFF_MAX_FILES files, the
    // named one among them.
    const broken = await head();
    await writeRepoFile(repo, NAMED, "export const play = 4;\n");
    await Promise.all(
      Array.from({ length: PILOT_FIX_DIFF_MAX_FILES - 1 }, (_, index) =>
        writeRepoFile(repo, `vendor/drop-${String(index)}.ts`, "y\n"),
      ),
    );
    const repaired = await commitAll("exactly the bound");

    // Act
    const outcome = await scoreFix(repo, {
      brokenCommit: broken,
      repairCommit: repaired,
      namedFiles: [NAMED],
    });

    // Assert
    expect(outcome).toBe("hit");
  });

  test("a range this clone does not have is unresolvable, never a miss", async () => {
    // Arrange — a teammate's commit that was never fetched here.
    const repaired = await head();

    // Act
    const outcome = await scoreFix(repo, {
      brokenCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      repairCommit: repaired,
      namedFiles: [NAMED],
    });

    // Assert
    expect(outcome).toBe("unresolvable");
  });

  test("a commit id shaped like a flag never reaches git", async () => {
    // Arrange — the ids come off the wire. `--output=<file>` is a real
    // `git diff` option: passed through, git would WRITE a file here and exit
    // 0 with nothing on stdout, which reads as an empty range.
    const repaired = await head();
    const planted = join(repo, "pwned");

    // Act
    const outcome = await scoreFix(repo, {
      brokenCommit: `--output=${planted}`,
      repairCommit: repaired,
      namedFiles: [NAMED],
    });

    // Assert
    expect(outcome).toBe("unresolvable");
    expect(existsSync(planted)).toBe(false);
  });

  test("an answer that named no file cannot be scored at all", async () => {
    // Arrange — nothing to be right or wrong about.
    const same = await head();

    // Act
    const outcome = await scoreFix(repo, {
      brokenCommit: same,
      repairCommit: same,
      namedFiles: [],
    });

    // Assert
    expect(outcome).toBe("unresolvable");
  });
});
