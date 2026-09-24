/**
 * AN ANSWER THE PROBE COULD NOT FINISH IS NEVER PASSED OFF AS "NOTHING".
 *
 * The landed-change stop fails open by design, and a verifier found three
 * ways that openness quietly became a false "nothing landed" — each hiding a
 * change the reader was missing:
 *
 *   - one landing branch git could not answer for silenced what every other
 *     branch knew;
 *   - a recent half that failed or ran out of time looked exactly like
 *     "nothing" and was cached for the rest of the day;
 *   - the cache key said "a merge is in progress" without saying WHICH, so a
 *     clean answer during one merge was reused during another.
 *
 * So: a branch that cannot answer is named (`unchecked`), the others still
 * speak; only a COMPLETE answer carries a cache key; and the key names every
 * input the answer depends on. The git runner is injected so a single call
 * can be failed or delayed deterministically, and counted.
 *
 * 2026-09-24 is a Thursday.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { LANDED_GIT_TIMEOUT_MS, MAX_LANDED_COMMITS_SCANNED } from "../src/constants.ts";
import { quietGitRunner } from "../src/landed-changes/git-queries.ts";
import type { GitRunner } from "../src/landed-changes/git-queries.ts";
import { findLandedChanges } from "../src/landed-changes/probe.ts";
import type { LandedProbeInput } from "../src/landed-changes/probe.ts";
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
const SEMANTICS_BUDGET_MS = 10_000;

const cleanups: string[] = [];

afterAll(async () => {
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

const repos = async (label: string): Promise<LandingRepos> => {
  const made = await makeLandingRepos(label);
  cleanups.push(made.base);
  return made;
};

const probe = (root: string, overrides: Partial<LandedProbeInput> = {}) =>
  findLandedChanges({ root, file: FILE, now: NOW, timeZone: BERLIN, budgetMs: SEMANTICS_BUDGET_MS, ...overrides });

/** The real quiet runner, with `rule` deciding per call: pass, fail, or delay (ms). */
const runnerFor = (
  root: string,
  rule: (args: readonly string[]) => "pass" | "fail" | number,
  seen: string[][] = [],
): GitRunner => {
  const real = quietGitRunner(root, LANDED_GIT_TIMEOUT_MS);
  return async (args) => {
    seen.push([...args]);
    const verdict = rule(args);
    if (verdict === "fail") {
      return null;
    }
    if (typeof verdict === "number") {
      await Bun.sleep(verdict);
    }
    return real(args);
  };
};

const isRecentWalk = (args: readonly string[]): boolean => args[0] === "log" && args.includes("--first-parent");

const JUNE_LANDING = {
  file: FILE,
  content: "export const offset = 2;\n",
  subject: "Fix line offset",
  landing: "staging",
  writtenAt: "2026-06-01T10:00:00Z",
  landedAt: "2026-06-02T10:00:00Z",
} as const;

describe("a landing branch git cannot answer for", () => {
  test("is named, and the other branches still say what they know", async () => {
    // Arrange — Ken's change is missing via main; staging's query will fail
    const r = await repos("unchecked");
    await landWithSquash(r, { ...JUNE_LANDING, landing: "main", author: KEN, subject: "Ken on main" });
    await readerFetches(r);
    const stagingTip = await gitIn(r.reader, ["rev-parse", "refs/remotes/origin/staging"]);
    const failStaging = runnerFor(r.reader, (args) =>
      args.includes("--left-only") && args.some((arg) => arg.startsWith(`${stagingTip}...`)) ? "fail" : "pass",
    );

    // Act
    const changes = await probe(r.reader, { runGit: failStaging });

    // Assert
    expect(changes?.missing.map((c) => c.subject)).toEqual(["Ken on main"]);
    expect(changes?.unchecked).toEqual(["staging"]);
    expect(changes?.key).toBeNull();
  });
});

describe("a recent half that could not finish", () => {
  test("a failed recent walk leaves the answer uncacheable", async () => {
    // Arrange — nothing is missing; the first-parent walk fails
    const r = await repos("recent-fails");
    const failRecent = runnerFor(r.reader, (args) => (isRecentWalk(args) ? "fail" : "pass"));

    // Act
    const changes = await probe(r.reader, { runGit: failRecent });

    // Assert — "nothing" it may say; cacheable it is not
    expect(changes?.missing).toEqual([]);
    expect(changes?.key).toBeNull();
  });

  test("past the deadline, the missing half is kept, and it carries no key", async () => {
    // Arrange — a real missing change; the recent walk is slow
    const r = await repos("deadline-half");
    await landWithMergeCommit(r, JUNE_LANDING);
    await readerFetches(r);
    const slowRecent = runnerFor(r.reader, (args) => (isRecentWalk(args) ? 2_000 : "pass"));

    // Act
    const changes = await probe(r.reader, { runGit: slowRecent, budgetMs: 800 });

    // Assert
    expect(changes?.missing.map((c) => c.subject)).toEqual(["Fix line offset"]);
    expect(changes?.key).toBeNull();
  });
});

describe("the cache key", () => {
  test("a known clean key skips the walk: no history is read", async () => {
    // Arrange
    const r = await repos("cache-counted");
    const first = await probe(r.reader);
    const seen: string[][] = [];

    // Act
    const second = await probe(r.reader, {
      knownCleanKeys: [first?.key ?? "none"],
      runGit: runnerFor(r.reader, () => "pass", seen),
    });

    // Assert — the same answer, and not one `git log`
    expect(first?.key).toMatch(/\S/);
    expect(second).toEqual(first);
    expect(seen.filter((args) => args[0] === "log")).toEqual([]);
  });

  test("names WHICH merge is in progress, not just that one is", async () => {
    // Arrange — two branches to merge; only the first carries Mike's commit
    const r = await repos("merge-key");
    await landWithMergeCommit(r, JUNE_LANDING);
    await readerFetches(r);
    await gitIn(r.reader, ["branch", "carrier", "origin/staging"]);
    await gitIn(r.reader, ["checkout", "-q", "-b", "other", "origin/main"]);
    await commitFile(r.reader, "src/other.ts", "export const other = 1;\n", "Other work", { as: NICK });
    await gitIn(r.reader, ["checkout", "-q", "nick/work"]);

    // Act — merge the carrier, then abort and merge the other
    await gitIn(r.reader, ["merge", "--no-commit", "--no-ff", "carrier"], { as: NICK });
    const duringCarrier = await probe(r.reader);
    await gitIn(r.reader, ["merge", "--abort"]);
    await gitIn(r.reader, ["merge", "--no-commit", "--no-ff", "other"], { as: NICK });
    const duringOther = await probe(r.reader, { knownCleanKeys: [duringCarrier?.key ?? "none"] });
    await gitIn(r.reader, ["merge", "--abort"]);

    // Assert — the carrier brings Mike's commit; the other merge does not
    expect(duringCarrier?.missing).toEqual([]);
    expect(duringOther?.key).not.toBe(duringCarrier?.key);
    expect(duringOther?.missing.map((c) => c.subject)).toEqual(["Fix line offset"]);
  });

  test("moves with the reader's identity and with the reader's day", async () => {
    // Arrange
    const r = await repos("key-inputs");
    const base = await probe(r.reader);

    // Act
    await gitIn(r.reader, ["config", "user.email", "nick@other.example"]);
    const otherIdentity = await probe(r.reader);
    const nextDay = await probe(r.reader, { now: new Date("2026-09-25T12:00:00Z") });

    // Assert
    expect(otherIdentity?.key).not.toBe(base?.key);
    expect(nextDay?.key).not.toBe(otherIdentity?.key);
  });
});

describe("the limit, while a merge is arriving", () => {
  test("a limit spent on arriving commits leaves the branch unchecked, never clean", async () => {
    // Arrange — Mike's branch, being merged, brings more commits to the file
    // than one probe reads: whatever lies past the limit, nobody looked at it
    const r = await repos("capped-merge");
    await landWithSquash(r, { ...JUNE_LANDING, author: KEN, subject: "Ken change" });
    await gitIn(r.teammate, ["checkout", "-q", "-B", "mike/many", "origin/staging"]);
    for (const n of Array.from({ length: MAX_LANDED_COMMITS_SCANNED + 1 }, (_, index) => index + 1)) {
      await commitFile(r.teammate, FILE, `export const offset = ${String(100 + n)};\n`, `Step ${String(n)}`, {
        as: MIKE,
      });
    }
    await gitIn(r.teammate, ["push", "-q", "origin", "mike/many"]);
    await gitIn(r.teammate, ["checkout", "-q", "-B", "staging", "origin/staging"]);
    await gitIn(r.teammate, ["merge", "-q", "--no-ff", "-m", "Merge mike/many", "mike/many"], { as: MIKE });
    await gitIn(r.teammate, ["push", "-q", "origin", "staging"]);
    await readerFetches(r);
    await gitIn(r.reader, ["merge", "--no-commit", "--no-ff", "origin/mike/many"], { as: NICK });

    // Act
    const changes = await probe(r.reader);
    await gitIn(r.reader, ["merge", "--abort"]);

    // Assert
    expect(changes?.unchecked).toEqual(["staging"]);
    expect(changes?.key).toBeNull();
  });
});

describe("recent reverts and identities", () => {
  test("a revert on staging of work main never got is recent, not a re-landing", async () => {
    // Arrange — X landed on staging in June; Ken reverted it yesterday; main
    // never had X, so the revert's content equals main's old content
    const r = await repos("revert-recent");
    await landWithSquash(r, { ...JUNE_LANDING, subject: "X" });
    await landWithSquash(r, {
      ...JUNE_LANDING,
      content: ORIGINAL_CONTENT,
      subject: 'Revert "X"',
      author: KEN,
      landedAt: "2026-09-23T09:00:00Z",
    });
    await readerFetches(r);
    await gitIn(r.reader, ["checkout", "-q", "-B", "nick/on-staging", "origin/staging"]);

    // Act
    const changes = await probe(r.reader);

    // Assert
    expect(changes?.recent.map((c) => c.subject)).toEqual(['Revert "X"']);
  });

  test("a .mailmap entry keyed on name AND email still recognises the reader", async () => {
    // Arrange — the entry maps "Old Nick <nick@old.example>" only
    const r = await repos("mailmap-name");
    await gitIn(r.reader, ["config", "user.name", "Old Nick"]);
    await gitIn(r.reader, ["config", "user.email", "nick@old.example"]);
    await writeFile(join(r.reader, ".mailmap"), "Nick <nick@example.com> Old Nick <nick@old.example>\n");
    await gitIn(r.reader, ["checkout", "-q", "-b", "nick/other", "origin/main"]);
    await commitFile(r.reader, FILE, "export const offset = 9;\n", "My own change", { as: NICK });
    await gitIn(r.reader, ["push", "-q", "origin", "HEAD:staging"]);
    await gitIn(r.reader, ["checkout", "-q", "nick/work"]);
    await readerFetches(r);

    // Act
    const changes = await probe(r.reader);

    // Assert
    expect(changes?.missing).toEqual([]);
  });
});
