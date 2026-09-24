/**
 * THE LANDED-CHANGE PROBE IN THE CLONES AND FLOWS REAL TEAMS HAVE.
 *
 * Every case here was found by an independent review running real git
 * against the first version of the probe, and every one of them was wrong
 * there. They share one standard: a stop the reader cannot trust teaches
 * them to click through all stops, and a stop that stays silent about work
 * the reader is missing is the failure this feature exists to prevent.
 *
 *   - A shallow clone's boundary commit "touches" every path; the probe must
 *     answer "unknown", not "every file changed yesterday".
 *   - A release merge (staging into main) or a back-merge (main into staging)
 *     re-lands old work on a second landing branch; that work landed when it
 *     FIRST arrived anywhere, not today.
 *   - While the reader resolves a merge, the commits being merged are not
 *     "missing"; they are arriving.
 *   - The reader's own commits must not use up the probe's reach and hide a
 *     teammate's change behind them.
 *   - A file whose content already equals the landing branch's, or on which
 *     the landing branch made no net change (a change and its revert), has
 *     nothing an edit could undo.
 *   - A blobless partial clone must not fetch from the network inside a hook.
 *
 * Real git throughout (fixtures/landing-repos.ts). 2026-09-24 is a Thursday.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { MAX_LANDED_COMMITS_SCANNED } from "../src/constants.ts";
import { findLandedChanges } from "../src/landed-changes/probe.ts";
import type { LandedChanges } from "../src/landed-changes/probe.ts";
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
const ORIGINAL_CONTENT = "export const offset = 1;\n";
/** Nothing to say — whatever the cache key. */
const expectNothing = (changes: LandedChanges | null): void => {
  expect(changes?.missing).toEqual([]);
  expect(changes?.recent).toEqual([]);
};

const cleanups: string[] = [];

afterAll(async () => {
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

const repos = async (label: string): Promise<LandingRepos> => {
  const made = await makeLandingRepos(label);
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

const JUNE_LANDING = {
  file: FILE,
  content: "export const offset = 2;\n",
  subject: "Fix line offset",
  landing: "staging",
  writtenAt: "2026-06-01T10:00:00Z",
  landedAt: "2026-06-02T10:00:00Z",
} as const;

/** Mike merges `from` into `into` with a merge commit dated `at`. */
const mergeOnOrigin = async (r: LandingRepos, from: string, into: string, at: string): Promise<void> => {
  await gitIn(r.teammate, ["fetch", "-q", "origin"]);
  await gitIn(r.teammate, ["checkout", "-q", "-B", into, `origin/${into}`]);
  await gitIn(r.teammate, ["merge", "-q", "--no-ff", "-m", `Merge ${from} into ${into}`, `origin/${from}`], {
    as: MIKE,
    date: at,
  });
  await gitIn(r.teammate, ["push", "-q", "origin", into]);
};

describe("clones the probe cannot read honestly", () => {
  test("a shallow clone answers unknown, never 'every file changed recently'", async () => {
    // Arrange — the tip of main never touched README.md
    const r = await repos("shallow");
    await landWithSquash(r, { ...JUNE_LANDING, landing: "main", landedAt: "2026-09-23T09:00:00Z" });
    const shallow = join(r.base, "shallow");
    await gitIn(r.base, ["clone", "-q", "--depth", "1", "--no-single-branch", `file://${r.origin}`, shallow]);

    // Act
    const changes = await find(shallow, "README.md");

    // Assert
    expect(changes).toBeNull();
  });

  test("a blobless partial clone is probed without fetching anything", async () => {
    // Arrange — both sides touched the file, which is what makes patch ids need blobs
    const r = await repos("partial");
    await gitIn(r.origin, ["config", "uploadpack.allowFilter", "true"]);
    const partial = join(r.base, "partial");
    await gitIn(r.base, ["clone", "-q", "--filter=blob:none", `file://${r.origin}`, partial]);
    await gitIn(partial, ["config", "user.email", NICK.email]);
    await gitIn(partial, ["checkout", "-q", "-b", "nick/work", "origin/main"]);
    await commitFile(partial, FILE, "export const offset = 5;\n", "Nick's offset", { as: NICK });
    await landWithMergeCommit(r, JUNE_LANDING);
    await gitIn(partial, ["fetch", "-q", "origin"]);
    const missingObjects = async (): Promise<number> =>
      (await gitIn(partial, ["rev-list", "--objects", "--all", "--missing=print"]))
        .split("\n")
        .filter((line) => line.startsWith("?")).length;
    const before = await missingObjects();

    // Act
    const changes = await find(partial);

    // Assert — the teammate's change is still found, and nothing was fetched
    expect(changes?.missing.map((c) => c.subject)).toEqual(["Fix line offset"]);
    expect(await missingObjects()).toBe(before);
  });
});

describe("work that landed twice, or is arriving", () => {
  test("a release merge of staging into main does not make June's change recent", async () => {
    // Arrange — Ken's change landed on staging in June; staging was released
    // into main yesterday; Nick's branch is cut from main after the release
    const r = await repos("promotion");
    await landWithMergeCommit(r, { ...JUNE_LANDING, author: KEN, subject: "Ken change" });
    // A later June change moves the file on, so Ken's commit no longer
    // carries any branch's old content: only "landed before" can drop it
    await landWithMergeCommit(r, {
      ...JUNE_LANDING,
      content: "export const offset = 3;\n",
      subject: "Mike follow-up",
      writtenAt: "2026-06-04T10:00:00Z",
      landedAt: "2026-06-05T10:00:00Z",
    });
    await mergeOnOrigin(r, "staging", "main", "2026-09-23T15:00:00Z");
    await readerFetches(r);
    await gitIn(r.reader, ["checkout", "-q", "-B", "nick/after-release", "origin/main"]);

    // Act
    const changes = await find(r.reader);

    // Assert
    expectNothing(changes);
  });

  test("a back-merge of main into staging does not make June's hotfix recent", async () => {
    // Arrange
    const r = await repos("back-merge");
    await landWithMergeCommit(r, { ...JUNE_LANDING, landing: "main", author: KEN, subject: "Hotfix" });
    await mergeOnOrigin(r, "main", "staging", "2026-09-23T15:00:00Z");
    await readerFetches(r);
    await gitIn(r.reader, ["checkout", "-q", "-B", "nick/on-staging", "origin/staging"]);

    // Act
    const changes = await find(r.reader);

    // Assert
    expectNothing(changes);
  });

  test("while the reader resolves a merge, the commits being merged are not missing", async () => {
    // Arrange — both changed the same line, so merging staging conflicts
    const r = await repos("conflict");
    await commitFile(r.reader, FILE, "export const offset = 5;\n", "Nick's offset", { as: NICK });
    await landWithMergeCommit(r, JUNE_LANDING);
    await readerFetches(r);
    await gitIn(r.reader, ["merge", "--no-edit", "origin/staging"], { as: NICK }).catch(() => undefined);
    expect(await gitIn(r.reader, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).toMatch(/^[0-9a-f]{40}$/);

    // Act
    const changes = await find(r.reader);

    // Assert
    expect(changes?.missing).toEqual([]);
  });
});

describe("work that landed twice, or is arriving — what must still be said", () => {
  test("a release that also carries genuinely new work still reports that work", async () => {
    // Arrange — Ken's change landed in June; Mike's landed on Tuesday; both
    // reached main in yesterday's release; Nick's branch is cut after it
    const r = await repos("release-new");
    await landWithMergeCommit(r, { ...JUNE_LANDING, author: KEN, subject: "Ken change" });
    await landWithMergeCommit(r, {
      ...JUNE_LANDING,
      content: "export const offset = 3;\n",
      subject: "Mike new",
      writtenAt: "2026-09-21T10:00:00Z",
      landedAt: "2026-09-22T10:00:00Z",
    });
    await mergeOnOrigin(r, "staging", "main", "2026-09-23T15:00:00Z");
    await readerFetches(r);
    await gitIn(r.reader, ["checkout", "-q", "-B", "nick/after-release", "origin/main"]);

    // Act
    const changes = await find(r.reader);

    // Assert
    expect(changes?.recent.map((c) => c.subject)).toEqual(["Mike new"]);
  });

  test("a change released days after it landed is not recent", async () => {
    // Arrange — Ken's change landed on staging on Friday the 18th (four
    // working days ago), inside a week but outside the window; staging was
    // released into main yesterday
    const r = await repos("release-late");
    await landWithMergeCommit(r, {
      ...JUNE_LANDING,
      author: KEN,
      subject: "Ken change",
      writtenAt: "2026-09-17T10:00:00Z",
      landedAt: "2026-09-18T10:00:00Z",
    });
    await mergeOnOrigin(r, "staging", "main", "2026-09-23T15:00:00Z");
    await readerFetches(r);
    await gitIn(r.reader, ["checkout", "-q", "-B", "nick/after-release", "origin/main"]);

    // Act
    const changes = await find(r.reader);

    // Assert
    expect(changes?.recent).toEqual([]);
  });

  test("a squash release of old work is not recent", async () => {
    // Arrange — June's staging content squashed into main yesterday
    const r = await repos("squash-release");
    await landWithMergeCommit(r, { ...JUNE_LANDING, author: KEN, subject: "Ken change" });
    await gitIn(r.teammate, ["fetch", "-q", "origin"]);
    await gitIn(r.teammate, ["checkout", "-q", "-B", "main", "origin/main"]);
    await gitIn(r.teammate, ["merge", "-q", "--squash", "origin/staging"]);
    await gitIn(r.teammate, ["commit", "-q", "-m", "Release 2026-09-23"], { as: KEN, date: "2026-09-23T15:00:00Z" });
    await gitIn(r.teammate, ["push", "-q", "origin", "main"]);
    await readerFetches(r);
    await gitIn(r.reader, ["checkout", "-q", "-B", "nick/after-release", "origin/main"]);

    // Act
    const changes = await find(r.reader);

    // Assert
    expect(changes?.recent).toEqual([]);
  });

  test("a cherry-pick in progress hides only the commit being picked, not what came before it", async () => {
    // Arrange — staging has Ken's T1 then Mike's T2; Nick picks T2 and conflicts
    const r = await repos("pick-in-progress");
    await commitFile(r.reader, FILE, "export const offset = 5;\n", "Nick's offset", { as: NICK });
    await landWithSquash(r, { ...JUNE_LANDING, subject: "T1", author: KEN });
    const t2 = await landWithSquash(r, {
      ...JUNE_LANDING,
      content: "export const offset = 3;\n",
      subject: "T2",
      landedAt: "2026-06-03T10:00:00Z",
    });
    await readerFetches(r);
    await gitIn(r.reader, ["cherry-pick", t2], { as: NICK }).catch(() => undefined);
    expect(await gitIn(r.reader, ["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"])).toBe(t2);

    // Act
    const changes = await find(r.reader);

    // Assert — Nick does not get T1 from this pick
    expect(changes?.missing.map((c) => c.subject)).toEqual(["T1"]);
  });
});

describe("the reader's own work", () => {
  test("never hides a teammate's missing change behind the reader's own commits", async () => {
    // Arrange — Nick landed six commits of his own on top of Mike's change
    const r = await repos("own-cap");
    await landWithMergeCommit(r, JUNE_LANDING);
    await readerFetches(r);
    await gitIn(r.reader, ["checkout", "-q", "-b", "nick/other", "origin/staging"]);
    for (const n of [1, 2, 3, 4, 5, 6]) {
      await commitFile(r.reader, FILE, `export const offset = ${String(10 + n)};\n`, `Own change ${String(n)}`, {
        as: NICK,
      });
    }
    await gitIn(r.reader, ["push", "-q", "origin", "HEAD:staging"]);
    await gitIn(r.reader, ["checkout", "-q", "nick/work"]);
    await readerFetches(r);

    // Act
    const changes = await find(r.reader);

    // Assert
    expect(changes?.missing.map((c) => c.subject)).toEqual(["Fix line offset"]);
  });
});

describe("the reader's identity", () => {
  test("is recognised through the repo's .mailmap, like every author in the log", async () => {
    // Arrange — Nick's clone still says his old address; the team maps it
    const r = await repos("mailmap");
    await gitIn(r.reader, ["config", "user.email", "nick@old.example"]);
    await writeFile(join(r.reader, ".mailmap"), "Nick <nick@example.com> <nick@old.example>\n");
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
});

describe("nothing an edit could undo", () => {
  test("a stacked branch whose base was squash-merged already has that content", async () => {
    // Arrange — Nick built on Mike's two commits; Mike's PR landed on main as one squash
    const r = await repos("stacked");
    await gitIn(r.teammate, ["checkout", "-q", "-b", "mike/base", "origin/main"]);
    await commitFile(r.teammate, FILE, "export const offset = 2;\n", "Base part 1", { as: MIKE });
    await commitFile(r.teammate, FILE, "export const offset = 3;\n", "Base part 2", { as: MIKE });
    await gitIn(r.teammate, ["push", "-q", "origin", "mike/base"]);
    await readerFetches(r);
    await gitIn(r.reader, ["checkout", "-q", "-B", "nick/stacked", "origin/mike/base"]);
    await gitIn(r.teammate, ["checkout", "-q", "-B", "main", "origin/main"]);
    await gitIn(r.teammate, ["merge", "-q", "--squash", "mike/base"]);
    await gitIn(r.teammate, ["commit", "-q", "-m", "Base PR (#1)"], { as: MIKE, date: "2026-09-23T09:00:00Z" });
    await gitIn(r.teammate, ["push", "-q", "origin", "main"]);
    await readerFetches(r);

    // Act
    const changes = await find(r.reader);

    // Assert
    expect(changes?.missing).toEqual([]);
  });

  test("a change and its revert on the landing branch add up to nothing missing", async () => {
    // Arrange — Nick changed the file too, so it differs from staging's; what
    // matters is that staging made no net change since Nick's branch point
    const r = await repos("revert-pair");
    await commitFile(r.reader, FILE, "export const offset = 5;\n", "Nick's offset", { as: NICK });
    await landWithSquash(r, { ...JUNE_LANDING, content: "export const offset = 9;\n", subject: "Try offset 9" });
    await landWithSquash(r, {
      ...JUNE_LANDING,
      content: ORIGINAL_CONTENT,
      subject: 'Revert "Try offset 9"',
      landedAt: "2026-06-03T10:00:00Z",
    });
    await readerFetches(r);

    // Act
    const changes = await find(r.reader);

    // Assert
    expect(changes?.missing).toEqual([]);
  });
});

describe("reverts the reader would bring back — the dangerous direction", () => {
  test("a revert of the PR the reader stacked on is missing", async () => {
    // Arrange — Nick builds on Mike's two-commit PR; the PR lands on staging
    // as one squash, and Ken reverts it. Merging Nick's branch would bring it back.
    const r = await repos("stacked-revert");
    await gitIn(r.teammate, ["checkout", "-q", "-b", "mike/base", "origin/main"]);
    await commitFile(r.teammate, FILE, "export const offset = 2;\n", "Base part 1", { as: MIKE });
    await commitFile(r.teammate, FILE, "export const offset = 3;\n", "Base part 2", { as: MIKE });
    await gitIn(r.teammate, ["push", "-q", "origin", "mike/base"]);
    await readerFetches(r);
    await gitIn(r.reader, ["checkout", "-q", "-B", "nick/stacked", "origin/mike/base"]);
    await gitIn(r.teammate, ["checkout", "-q", "-B", "staging", "origin/staging"]);
    await gitIn(r.teammate, ["merge", "-q", "--squash", "mike/base"]);
    await gitIn(r.teammate, ["commit", "-q", "-m", "Base PR (#1)"], { as: MIKE, date: "2026-06-01T10:00:00Z" });
    await commitFile(r.teammate, FILE, ORIGINAL_CONTENT, 'Revert "Base PR (#1)"', {
      as: KEN,
      date: "2026-06-02T10:00:00Z",
    });
    await gitIn(r.teammate, ["push", "-q", "origin", "staging"]);
    await readerFetches(r);

    // Act
    const changes = await find(r.reader);

    // Assert
    expect(changes?.missing.map((c) => c.subject)).toContain('Revert "Base PR (#1)"');
  });

  test("a revert of a fix the reader cherry-picked is missing", async () => {
    // Arrange — Nick picked Mike's fix; staging then reverted it
    const r = await repos("picked-revert");
    const fix = await landWithSquash(r, { ...JUNE_LANDING, subject: "Mike fix" });
    await readerFetches(r);
    await gitIn(r.reader, ["cherry-pick", fix], { as: NICK });
    await landWithSquash(r, {
      ...JUNE_LANDING,
      content: ORIGINAL_CONTENT,
      subject: 'Revert "Mike fix"',
      author: KEN,
      landedAt: "2026-06-03T10:00:00Z",
    });
    await readerFetches(r);

    // Act
    const changes = await find(r.reader);

    // Assert
    expect(changes?.missing.map((c) => c.subject)).toEqual(['Revert "Mike fix"']);
  });
});

describe("what the probe reports", () => {
  test("a clean answer's key moves when a landing branch does", async () => {
    // Arrange
    const r = await repos("cache-key");
    const before = await find(r.reader);

    // Act — staging moves with work on ANOTHER file, and Nick fetches it
    await landWithMergeCommit(r, { ...JUNE_LANDING, file: "src/other.ts", subject: "Other work" });
    await readerFetches(r);
    const after = await find(r.reader);

    // Assert — both still say nothing about this file, under different keys
    expect(before?.cleanKey).toMatch(/\S/);
    expect(after?.cleanKey).toMatch(/\S/);
    expect(after?.cleanKey).not.toBe(before?.cleanKey);
  });

  test("an answer with something to say carries no key", async () => {
    // Arrange
    const r = await repos("key-only-clean");
    await landWithMergeCommit(r, JUNE_LANDING);
    await readerFetches(r);

    // Act
    const changes = await find(r.reader);

    // Assert
    expect(changes?.missing).toHaveLength(1);
    expect(changes?.cleanKey).toBeNull();
  });

  test("a key the caller already knows as clean is answered as nothing, with that key", async () => {
    // Arrange
    const r = await repos("cache-hit");
    const first = await find(r.reader);

    // Act
    const second = await findLandedChanges({
      root: r.reader,
      file: FILE,
      now: NOW,
      timeZone: BERLIN,
      budgetMs: SEMANTICS_BUDGET_MS,
      knownCleanKeys: [first?.cleanKey ?? "none"],
    });

    // Assert
    expect(second).toEqual(first);
  });

  test("a subject carrying the field separator is still reported, not dropped", async () => {
    // Arrange
    const r = await repos("separator");
    await landWithSquash(r, { ...JUNE_LANDING, subject: "Fix\x1foffset" });
    await readerFetches(r);

    // Act
    const changes = await find(r.reader);

    // Assert
    expect(changes?.missing).toHaveLength(1);
  });

  test("a file whose name starts with a colon is a file, not pathspec magic", async () => {
    // Arrange — a teammate's change to ":colon.ts" the reader lacks
    const r = await repos("colon-name");
    await landWithSquash(r, { ...JUNE_LANDING, file: ":colon.ts", subject: "Colon change" });
    await readerFetches(r);

    // Act
    const changes = await find(r.reader, ":colon.ts");

    // Assert
    expect(changes?.missing.map((c) => c.subject)).toEqual(["Colon change"]);
  });

  test("says when there are more missing changes than it looked at", async () => {
    // Arrange — more commits to the file on staging than one probe reads
    const r = await repos("many");
    await gitIn(r.teammate, ["checkout", "-q", "-B", "staging", "origin/staging"]);
    for (const n of Array.from({ length: MAX_LANDED_COMMITS_SCANNED + 1 }, (_, index) => index + 1)) {
      await commitFile(r.teammate, FILE, `export const offset = ${String(100 + n)};\n`, `Step ${String(n)}`, {
        as: MIKE,
      });
    }
    await gitIn(r.teammate, ["push", "-q", "origin", "staging"]);
    await readerFetches(r);

    // Act
    const changes = await find(r.reader);

    // Assert
    expect(changes?.missing).toHaveLength(MAX_LANDED_COMMITS_SCANNED);
    expect(changes?.moreMissing).toBe(true);
  });
});
