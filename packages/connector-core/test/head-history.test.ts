/**
 * "DOES THIS COMMIT DESCEND FROM THAT ONE", FROM THE HEAD LOG ALONE
 * (git/head-history.ts). The topic rules ask it; a wrong yes folds two pieces
 * of work into one topic, so every move that is not on top of the previous
 * commit must read as no descent. The real-git half is test/topic-rules.test.ts;
 * this file writes the reflog lines git writes for the moves a test repo cannot
 * cheaply make — a rebasing pull, a sequencer step.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { descendsInHeadLog } from "../src/git/head-history.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const cleanups: string[] = [];

afterAll(async () => {
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

/** A git dir whose HEAD log holds exactly these moves, in git's own line format. */
const gitDirWith = async (moves: readonly (readonly [string, string, string])[]): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-head-log-"));
  cleanups.push(dir);
  await mkdir(join(dir, "logs"), { recursive: true });
  const lines = moves.map(([from, to, message]) => `${from} ${to} Dev <dev@example.com> 1759831200 +0000\t${message}`);
  await writeFile(join(dir, "logs", "HEAD"), `${lines.join("\n")}\n`, "utf8");
  return dir;
};

describe("descent read off the HEAD log", () => {
  test("a chain of commits, a fast-forward pull and a cherry-pick descend", async () => {
    const dir = await gitDirWith([
      [A, B, "commit: one"],
      [B, C, "pull: Fast-forward"],
    ]);
    expect(await descendsInHeadLog(dir, A, C)).toBe(true);
    const picked = await gitDirWith([[A, B, "cherry-pick: fix the importer"]]);
    expect(await descendsInHeadLog(picked, A, B)).toBe(true);
  });

  test("a rebasing pull and a rebase never descend", async () => {
    const pulled = await gitDirWith([
      [A, B, "pull --rebase (start): checkout origin/main"],
      [B, C, "pull --rebase (pick): one"],
    ]);
    const rebased = await gitDirWith([[A, B, "rebase (start): checkout main"]]);
    expect(await descendsInHeadLog(pulled, A, C)).toBe(false);
    expect(await descendsInHeadLog(rebased, A, B)).toBe(false);
  });

  test("an amend, a reset and a checkout never descend; the same commit always does", async () => {
    const dir = await gitDirWith([
      [A, B, "commit (amend): one"],
      [B, C, "reset: moving to HEAD~1"],
      [A, C, "checkout: moving from main to feat/x"],
    ]);
    expect(await descendsInHeadLog(dir, A, B)).toBe(false);
    expect(await descendsInHeadLog(dir, A, C)).toBe(false);
    expect(await descendsInHeadLog(dir, C, C)).toBe(true);
  });

  test("a git dir with no HEAD log answers no descent", async () => {
    expect(await descendsInHeadLog("/cx-head-log/nowhere", A, B)).toBe(false);
  });
});
