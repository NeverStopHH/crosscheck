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

import { commitsMadeInHeadLog, descendsInHeadLog, isRenamedInHeadLog } from "../src/git/head-history.ts";

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

/** A git dir whose HEAD log holds these moves, each at its own unix second. */
const gitDirAt = async (moves: readonly (readonly [string, string, number, string])[]): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-head-log-at-"));
  cleanups.push(dir);
  await mkdir(join(dir, "logs"), { recursive: true });
  const lines = moves.map(([from, to, at, message]) => `${from} ${to} Dev Name <dev@example.com> ${String(at)} +0200\t${message}`);
  await writeFile(join(dir, "logs", "HEAD"), `${lines.join("\n")}\n`, "utf8");
  return dir;
};

const D = "d".repeat(40);
const E = "e".repeat(40);
const T0 = 1_759_831_200;

describe("the commits a worktree made (review H1)", () => {
  test("are its commit, amend and cherry-pick moves since the instant — never a merge, pull, checkout or reset", async () => {
    const dir = await gitDirAt([
      [A, B, T0 - 60, "commit: before the session"],
      [B, C, T0, "commit: one"],
      [C, D, T0 + 1, "merge feat/other: Merge made by the 'ort' strategy."],
      [D, E, T0 + 2, "checkout: moving from feat/x to main"],
      [E, A, T0 + 3, "pull: Fast-forward"],
      [A, B, T0 + 4, "reset: moving to HEAD~1"],
    ]);
    expect(await commitsMadeInHeadLog(dir, new Date(T0 * 1000))).toEqual([C]);
  });

  test("leave out a commit an amend replaced, and keep the amend and a cherry-pick", async () => {
    const dir = await gitDirAt([
      [A, B, T0, "commit: one"],
      [B, C, T0 + 1, "commit (amend): one, fixed"],
      [C, D, T0 + 2, "cherry-pick: a fix from elsewhere"],
    ]);
    expect(await commitsMadeInHeadLog(dir, new Date(T0 * 1000))).toEqual([C, D]);
  });

  test("are none when the HEAD log is gone", async () => {
    expect(await commitsMadeInHeadLog("/cx-head-log/nowhere", new Date(T0 * 1000))).toEqual([]);
  });
});

describe("a rename, as git records it (review H3)", () => {
  test("is git's own `Branch: renamed` line for exactly those two names", async () => {
    const dir = await gitDirAt([[A, A, T0, "Branch: renamed refs/heads/feat/a to refs/heads/feat/b"]]);
    expect(await isRenamedInHeadLog(dir, "feat/a", "feat/b")).toBe(true);
    expect(await isRenamedInHeadLog(dir, "feat/b", "feat/a")).toBe(false);
    expect(await isRenamedInHeadLog(dir, "feat/a", "feat/c")).toBe(false);
  });

  test("is never a branch that is merely gone", async () => {
    const dir = await gitDirAt([[A, A, T0, "checkout: moving from feat/a to feat/b"]]);
    expect(await isRenamedInHeadLog(dir, "feat/a", "feat/b")).toBe(false);
  });
});
