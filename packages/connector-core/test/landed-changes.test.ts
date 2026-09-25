/**
 * WHICH TEAMMATE CHANGES TO A FILE HAVE LANDED, AND DOES THIS CHECKOUT HAVE THEM?
 *
 * The question the live tripwire cannot ask: a teammate finished, merged
 * into `staging`, and left. Their session is over, so nobody is "active" on
 * the file — and the reader, on a branch cut from `main` before that merge,
 * is about to edit it (docs/1.0/landed-changes.md).
 *
 * The reader's own clone answers it, from commits, trusting nobody:
 *
 *   - MISSING, at any age: reachable from a landing branch, not from HEAD,
 *     and not patch-equivalent to anything HEAD has. No clock — a merged
 *     feature branch keeps its original dates, so a date filter would hide
 *     precisely the changes ancestry sees.
 *   - RECENT AND PRESENT: landed on the landing branch's first-parent line
 *     within two working days, and an ancestor of HEAD. Attributed to the
 *     commits the merge brought in — the person who clicked "merge" is often
 *     a reviewer, not the author.
 *   - The reader's own commits never warn the reader.
 *
 * Every test runs real git on real clones (fixtures/landing-repos.ts).
 * 2026-09-24 is a Thursday.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findLandedChanges } from "../src/landed-changes/probe.ts";
import {
  KEN,
  MIKE,
  NICK,
  commitFile,
  gitIn,
  landWithMergeCommit,
  landWithSquash,
  makeLandingRepos,
  readerFetches,
} from "./fixtures/landing-repos.ts";
import type { LandingRepos } from "./fixtures/landing-repos.ts";

const NOW = new Date("2026-09-24T12:00:00Z");
const BERLIN = "Europe/Berlin";
const FILE = "src/lines.ts";

const cleanups: string[] = [];

afterAll(async () => {
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

const repos = async (label: string, landing: readonly string[] = ["staging"]): Promise<LandingRepos> => {
  const made = await makeLandingRepos(label, landing);
  cleanups.push(made.base);
  return made;
};

/**
 * A generous deadline: these tests pin WHAT the probe answers, and a loaded
 * machine must not turn that into a race. The deadline itself has its own test.
 */
const SEMANTICS_BUDGET_MS = 10_000;

const find = (root: string, file: string = FILE) =>
  findLandedChanges({ root, file, now: NOW, timeZone: BERLIN, budgetMs: SEMANTICS_BUDGET_MS });

const OLD_LANDING = {
  file: FILE,
  content: "export const offset = 2;\n",
  subject: "Fix line offset",
  landing: "staging",
  writtenAt: "2026-06-01T10:00:00Z",
  landedAt: "2026-06-02T10:00:00Z",
} as const;

describe("a teammate's landed change the reader's checkout does not contain", () => {
  test("is missing however old it is, with who wrote it and where it landed", async () => {
    // Arrange — merged into staging back in June; Nick's branch is cut from main
    const r = await repos("missing-old");
    await landWithMergeCommit(r, OLD_LANDING);
    await readerFetches(r);

    // Act
    const changes = await find(r.reader);

    // Assert
    expect(changes?.missing.map((c) => [c.subject, c.authorName, c.branches])).toEqual([
      ["Fix line offset", "Mike", ["staging"]],
    ]);
    expect(changes?.recent).toEqual([]);
  });

  test("is not missing once it reached the reader by cherry-pick", async () => {
    // Arrange — Nick picked Mike's commit, then kept working on the file, so
    // the two files differ and only the patch identity says "already here"
    const r = await repos("cherry-picked");
    const sha = await landWithMergeCommit(r, OLD_LANDING);
    await readerFetches(r);
    await gitIn(r.reader, ["cherry-pick", sha], { as: NICK });
    await commitFile(r.reader, FILE, "export const offset = 2;\nexport const extra = 1;\n", "More work", {
      as: NICK,
    });

    // Act
    const changes = await find(r.reader);

    // Assert
    expect(changes?.missing).toEqual([]);
  });

  test("is listed once when it is missing from two landing branches", async () => {
    // Arrange — landed on staging, then staging promoted into main
    const r = await repos("two-branches");
    await landWithMergeCommit(r, OLD_LANDING);
    await gitIn(r.teammate, ["push", "-q", "origin", "staging:main"]);
    await readerFetches(r);

    // Act
    const changes = await find(r.reader);

    // Assert
    expect(changes?.missing.map((c) => c.branches)).toEqual([["main", "staging"]]);
  });

  test("never includes the reader's own commits", async () => {
    // Arrange — Nick landed a change of his own from another branch
    const r = await repos("own-commit");
    await gitIn(r.reader, ["checkout", "-q", "-b", "nick/other", "origin/main"]);
    await commitFile(r.reader, FILE, "export const offset = 9;\n", "My own change", { as: NICK });
    await gitIn(r.reader, ["push", "-q", "origin", "HEAD:staging"]);
    await gitIn(r.reader, ["checkout", "-q", "nick/work"]);
    await readerFetches(r);

    // Act
    const changes = await find(r.reader);

    // Assert
    expect(changes?.missing).toEqual([]);
  });

  test("a teammate commit the reader has, but that never landed, is not listed", async () => {
    // Arrange — Nick merged Mike's unfinished branch directly; staging never
    // got it, but staging did get a different change to the same file
    const r = await repos("not-landed");
    await gitIn(r.teammate, ["checkout", "-q", "-b", "mike/wip", "origin/main"]);
    await commitFile(r.teammate, FILE, "export const offset = 7;\n", "Work in progress", { as: MIKE });
    await gitIn(r.teammate, ["push", "-q", "origin", "mike/wip"]);
    await landWithMergeCommit(r, OLD_LANDING);
    await readerFetches(r);
    await gitIn(r.reader, ["merge", "-q", "--no-edit", "origin/mike/wip"], { as: NICK });

    // Act
    const changes = await find(r.reader);

    // Assert — the landed change, and only that
    expect(changes?.missing.map((c) => c.subject)).toEqual(["Fix line offset"]);
  });

  test("one that landed yesterday but is not in the checkout is missing, not recent", async () => {
    // Arrange
    const r = await repos("missing-recent");
    await landWithMergeCommit(r, {
      ...OLD_LANDING,
      writtenAt: "2026-09-22T10:00:00Z",
      landedAt: "2026-09-23T15:00:00Z",
    });
    await readerFetches(r);

    // Act
    const changes = await find(r.reader);

    // Assert
    expect(changes?.missing.map((c) => c.subject)).toEqual(["Fix line offset"]);
    expect(changes?.recent).toEqual([]);
  });

  test("touching another file is not a change to this one", async () => {
    // Arrange
    const r = await repos("other-file");
    await landWithMergeCommit(r, {
      ...OLD_LANDING,
      file: "src/other.ts",
      content: "export const other = 1;\n",
      subject: "Other work",
    });
    await readerFetches(r);

    // Act
    const changes = await find(r.reader);

    // Assert
    expect(changes?.missing).toEqual([]);
    expect(changes?.recent).toEqual([]);
  });
});

describe("a teammate's landed change the reader already has", () => {
  test("is recent when it landed within two working days, credited to its author, not the merger", async () => {
    // Arrange — Mike wrote it on the 10th, Ken merged it on Wednesday the 23rd,
    // and Nick has since merged staging into his branch
    const r = await repos("recent-present");
    await landWithMergeCommit(r, {
      ...OLD_LANDING,
      writtenAt: "2026-09-10T10:00:00Z",
      landedAt: "2026-09-23T15:00:00Z",
      merger: KEN,
    });
    await readerFetches(r);
    await gitIn(r.reader, ["merge", "-q", "--no-edit", "origin/staging"], { as: NICK });

    // Act
    const changes = await find(r.reader);

    // Assert
    expect(changes?.missing).toEqual([]);
    expect(changes?.recent.map((c) => [c.subject, c.authorName, c.branches])).toEqual([
      ["Fix line offset", "Mike", ["staging"]],
    ]);
    expect(changes?.recent[0]?.landedAt?.toISOString()).toBe("2026-09-23T15:00:00.000Z");
  });

  test("counts from when it landed, not from when it was written", async () => {
    // Arrange — written Tuesday, merged Wednesday afternoon
    const r = await repos("landed-not-written");
    await landWithMergeCommit(r, {
      ...OLD_LANDING,
      writtenAt: "2026-09-22T10:00:00Z",
      landedAt: "2026-09-23T15:00:00Z",
    });
    await readerFetches(r);
    await gitIn(r.reader, ["merge", "-q", "--no-edit", "origin/staging"], { as: NICK });

    // Act
    const changes = await find(r.reader);

    // Assert
    expect(changes?.recent[0]?.landedAt?.toISOString()).toBe("2026-09-23T15:00:00.000Z");
  });

  test("is ordinary history once it landed more than two working days ago", async () => {
    // Arrange — landed on Friday the 18th: Monday to Thursday is four working days
    const r = await repos("old-present");
    await landWithMergeCommit(r, {
      ...OLD_LANDING,
      writtenAt: "2026-09-17T10:00:00Z",
      landedAt: "2026-09-18T15:00:00Z",
    });
    await readerFetches(r);
    await gitIn(r.reader, ["merge", "-q", "--no-edit", "origin/staging"], { as: NICK });

    // Act
    const changes = await find(r.reader);

    // Assert
    expect(changes?.missing).toEqual([]);
    expect(changes?.recent).toEqual([]);
  });

  test("a squash that landed yesterday is recent, credited to the squash's author", async () => {
    // Arrange
    const r = await repos("squash-present");
    await landWithSquash(r, {
      file: FILE,
      content: "export const offset = 3;\n",
      subject: "Defensive line offset (#12)",
      landing: "staging",
      landedAt: "2026-09-23T09:00:00Z",
    });
    await readerFetches(r);
    await gitIn(r.reader, ["merge", "-q", "--no-edit", "origin/staging"], { as: NICK });

    // Act
    const changes = await find(r.reader);

    // Assert
    expect(changes?.recent.map((c) => [c.subject, c.authorName])).toEqual([
      ["Defensive line offset (#12)", MIKE.name],
    ]);
  });
});

describe("when git cannot answer", () => {
  test("a directory that is not a repository yields no answer, not an empty one", async () => {
    // Arrange
    const plain = await mkdtemp(join(tmpdir(), "cx-not-a-repo-"));
    cleanups.push(plain);

    // Act
    const changes = await find(plain);

    // Assert — null is "unknown"; an empty result would claim "nothing landed"
    expect(changes).toBeNull();
  });

  test("a probe past its deadline before anything is known answers unknown", async () => {
    // Arrange — a real missing change, and no time at all to find it
    const r = await repos("deadline");
    await landWithMergeCommit(r, OLD_LANDING);
    await readerFetches(r);

    // Act
    const changes = await findLandedChanges({ root: r.reader, file: FILE, now: NOW, timeZone: BERLIN, budgetMs: 0 });

    // Assert
    expect(changes).toBeNull();
  });
});
