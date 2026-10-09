/**
 * THE LANDED-CHANGE PROBE ASKS GIT FAR LESS (batch-2 integration review, M6).
 * About twenty git spawns per edit under load were a third of PreToolUse's
 * budget; five of them did not depend on the file at all.
 *
 *   - The repo state comes from the files git reads for it (HEAD, its ref,
 *     `shallow`, MERGE_HEAD, CHERRY_PICK_HEAD) — the same answer as git's.
 *   - With a cache home, the landing tips, partial clone and the reader's
 *     own address are kept per root under a stamp of the files they depend
 *     on: a second probe asks git none of them, and a fetch or a config
 *     change is seen at once.
 *   - A branch tip as of an instant and a merge base are kept too: they can
 *     never change.
 *   - A caller that injects how git runs is staging git's answers: it is
 *     asked everything, every time, as before.
 *
 * Spawns are counted in-process by wrapping Bun.spawn, so "asked git nothing
 * more" is a count of real git processes, not a stopwatch.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { probeLandedChanges } from "../src/landed-changes/probe.ts";
import type { LandedProbe } from "../src/landed-changes/probe.ts";
import { readRepoStateFromFiles } from "../src/landed-changes/probe-facts.ts";
import { quietGitRunner, readRepoState } from "../src/landed-changes/git-queries.ts";
import type { GitContext } from "../src/landed-changes/git-queries.ts";
import {
  MIKE,
  NICK,
  commitFile,
  gitIn,
  landWithMergeCommit,
  makeLandingRepos,
  readerFetches,
} from "./fixtures/landing-repos.ts";
import type { LandingRepos } from "./fixtures/landing-repos.ts";

const NOW = new Date("2026-09-24T12:00:00Z");
const BERLIN = "Europe/Berlin";
const FILE = "src/lines.ts";
const SEMANTICS_BUDGET_MS = 10_000;
const GIT_TIMEOUT_MS = 5_000;

/** The probe's questions that do not depend on the file. */
const KEY_QUESTIONS: readonly string[] = ["rev-parse", "for-each-ref", "config", "var", "check-mailmap"];

const cleanups: string[] = [];

afterAll(async () => {
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

const realSpawn = Bun.spawn;

afterEach(() => {
  Bun.spawn = realSpawn;
});

/** The git subcommand of an argv, past `git` and its `-c key=value` pins. */
const subcommandOf = (argv: readonly string[]): string => {
  const at = argv.findIndex((part, index) => index > 0 && !part.startsWith("-") && argv[index - 1] !== "-c");
  return at === -1 ? "?" : (argv[at] ?? "?");
};

/** Every git subcommand this process spawns while `work` runs. */
const gitSpawnedBy = async <T,>(work: () => Promise<T>): Promise<{ readonly value: T; readonly asked: readonly string[] }> => {
  const asked: string[] = [];
  Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
    const [first] = args;
    const cmd: readonly string[] = Array.isArray(first) ? first : ((first as { readonly cmd?: readonly string[] }).cmd ?? []);
    if (cmd[0] === "git") {
      asked.push(subcommandOf(cmd));
    }
    return realSpawn(...args);
  }) as typeof Bun.spawn;
  try {
    return { value: await work(), asked };
  } finally {
    Bun.spawn = realSpawn;
  }
};

const repos = async (label: string): Promise<LandingRepos> => {
  const made = await makeLandingRepos(label, ["staging"]);
  cleanups.push(made.base);
  return made;
};

const homeFor = async (label: string): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), `cx-home-${label}-`));
  cleanups.push(home);
  return home;
};

const LANDING = {
  file: FILE,
  content: "export const offset = 2;\n",
  subject: "Fix line offset",
  landing: "staging",
  writtenAt: "2026-09-23T10:00:00Z",
  landedAt: "2026-09-23T11:00:00Z",
} as const;

const probe = (root: string, cacheHome?: string): Promise<LandedProbe> =>
  probeLandedChanges({
    root,
    file: FILE,
    now: NOW,
    timeZone: BERLIN,
    budgetMs: SEMANTICS_BUDGET_MS,
    ...(cacheHome === undefined ? {} : { cacheHome }),
  });

const missingSubjects = (answer: LandedProbe): readonly string[] =>
  (answer.landed?.missing ?? []).map((commit) => commit.subject);

const contextFor = (root: string): GitContext => ({
  root,
  file: FILE,
  run: quietGitRunner(root, GIT_TIMEOUT_MS),
  isCancelled: () => false,
});

describe("the repo state, from the files", () => {
  test("is git's own answer on a branch mid-merge, in a linked worktree and detached", async () => {
    // Arrange
    const r = await repos("pf-state");
    await landWithMergeCommit(r, LANDING);
    await readerFetches(r);
    const worktree = join(r.base, "nick-wt");
    await gitIn(r.reader, ["worktree", "add", "-q", "-b", "nick/wt", worktree, "origin/main"]);
    const detached = join(r.base, "nick-detached");
    await gitIn(r.reader, ["worktree", "add", "-q", "--detach", detached, "origin/main"]);
    await commitFile(r.reader, FILE, "export const offset = 9;\n", "Nick's own offset", { as: NICK });
    await gitIn(r.reader, ["merge", "--no-commit", "origin/staging"], { as: NICK }).catch(() => "conflict");

    // Act
    const roots = [r.reader, worktree, detached];
    const fromFiles = await Promise.all(roots.map((root) => readRepoStateFromFiles(root)));
    const fromGit = await Promise.all(roots.map((root) => readRepoState(contextFor(root))));

    // Assert
    expect(fromFiles).toEqual(fromGit);
    expect(fromFiles[0]?.mergeHeads).toHaveLength(1);
  });
});

describe("with a cache home", () => {
  test("a second probe of the root asks git none of the questions that do not depend on the file — and answers the same", async () => {
    // Arrange
    const r = await repos("pf-hit");
    await landWithMergeCommit(r, LANDING);
    await readerFetches(r);
    const home = await homeFor("pf-hit");
    const first = await probe(r.reader, home);

    // Act
    const second = await gitSpawnedBy(() => probe(r.reader, home));

    // Assert
    expect(missingSubjects(first)).toEqual(["Fix line offset"]);
    expect(missingSubjects(second.value)).toEqual(missingSubjects(first));
    expect(second.asked.filter((sub) => KEY_QUESTIONS.includes(sub))).toEqual([]);
  });

  test("a branch tip as of the window's opening and a merge base are asked once per root", async () => {
    // Arrange
    const r = await repos("pf-memo");
    await landWithMergeCommit(r, LANDING);
    await readerFetches(r);
    const home = await homeFor("pf-memo");
    await probe(r.reader, home);

    // Act
    const second = await gitSpawnedBy(() => probe(r.reader, home));

    // Assert
    expect(second.asked.filter((sub) => sub === "merge-base" || sub === "rev-list")).toEqual([]);
  });

  test("a fetch that moves a landing branch is seen at once", async () => {
    // Arrange
    const r = await repos("pf-fetch");
    await landWithMergeCommit(r, LANDING);
    await readerFetches(r);
    const home = await homeFor("pf-fetch");
    await probe(r.reader, home);
    await landWithMergeCommit(r, {
      ...LANDING,
      content: "export const offset = 3;\n",
      subject: "Offset again",
      writtenAt: "2026-09-24T08:00:00Z",
      landedAt: "2026-09-24T09:00:00Z",
    });
    await readerFetches(r);

    // Act
    const after = await probe(r.reader, home);

    // Assert
    expect(missingSubjects(after)).toEqual(["Offset again", "Fix line offset"]);
  });

  test("a change of the reader's own address is seen at once", async () => {
    // Arrange: Mike's change is missing for Nick — then the clone says it is Mike's
    const r = await repos("pf-self");
    await landWithMergeCommit(r, LANDING);
    await readerFetches(r);
    const home = await homeFor("pf-self");
    const before = await probe(r.reader, home);
    await gitIn(r.reader, ["config", "user.email", MIKE.email]);
    await gitIn(r.reader, ["config", "user.name", MIKE.name]);

    // Act
    const after = await probe(r.reader, home);

    // Assert: the reader's own commits never warn the reader
    expect(missingSubjects(before)).toEqual(["Fix line offset"]);
    expect(missingSubjects(after)).toEqual([]);
  });
});

describe("without a cache home, or with git's answers staged", () => {
  test("a probe with no cache home asks the key questions every time", async () => {
    // Arrange
    const r = await repos("pf-nohome");
    await probe(r.reader);

    // Act
    const second = await gitSpawnedBy(() => probe(r.reader));

    // Assert
    expect(second.asked.filter((sub) => sub === "for-each-ref")).toEqual(["for-each-ref"]);
  });

  test("an injected runner is asked everything — the files never stand in for staged answers", async () => {
    // Arrange
    const r = await repos("pf-injected");
    const home = await homeFor("pf-injected");
    const asked: string[] = [];
    const run = quietGitRunner(r.reader, GIT_TIMEOUT_MS);
    const counting = (args: readonly string[]): Promise<string | null> => {
      asked.push(args[0] ?? "?");
      return run(args);
    };
    const input = { root: r.reader, file: FILE, now: NOW, timeZone: BERLIN, budgetMs: SEMANTICS_BUDGET_MS, cacheHome: home, runGit: counting };

    // Act
    await probeLandedChanges(input);
    await probeLandedChanges(input);

    // Assert
    expect(asked.filter((sub) => sub === "rev-parse")).toHaveLength(2);
    expect(asked.filter((sub) => sub === "var")).toHaveLength(2);
  });
});
