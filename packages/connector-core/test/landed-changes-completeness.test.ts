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

/**
 * For the cases that build dozens of real commits or a dozen merges before
 * they ask anything: seconds of honest git, which a loaded suite can stretch
 * past bun's five-second default. The probe's own deadline is what these
 * tests measure where timing matters; this only bounds the setup.
 */
const HEAVY_SETUP_MS = 60_000;

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
    expect(changes?.cleanKey).toBeNull();
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
    expect(changes?.cleanKey).toBeNull();
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
    expect(changes?.cleanKey).toBeNull();
  });
});

describe("every recent-half failure keeps the answer uncacheable", () => {
  /** Mike's change landed yesterday by merge, and Nick has merged staging since. */
  const recentPresent = async (label: string): Promise<LandingRepos> => {
    const r = await repos(label);
    await landWithMergeCommit(r, {
      ...JUNE_LANDING,
      writtenAt: "2026-09-22T10:00:00Z",
      landedAt: "2026-09-23T15:00:00Z",
    });
    await readerFetches(r);
    await gitIn(r.reader, ["merge", "-q", "--no-edit", "origin/staging"], { as: NICK });
    return r;
  };

  test("when the old tip cannot be read", async () => {
    const r = await repos("tip-fails");
    const failTip = runnerFor(r.reader, (args) => (args[0] === "rev-list" && args[1] === "-1" ? "fail" : "pass"));

    const changes = await probe(r.reader, { runGit: failTip });

    expect(changes?.cleanKey).toBeNull();
  });

  test("when what a merge brought in cannot be read", async () => {
    const r = await recentPresent("merge-side-fails");
    const failSide = runnerFor(r.reader, (args) =>
      args[0] === "log" && args.includes("--no-merges") && !args.includes("--left-only") && !args.includes("--format=%aE")
        ? "fail"
        : "pass",
    );

    const changes = await probe(r.reader, { runGit: failSide });

    expect(changes?.missing).toEqual([]);
    expect(changes?.cleanKey).toBeNull();
  });

  test("when whether the reader has it cannot be read", async () => {
    const r = await recentPresent("presence-fails");
    const head = await gitIn(r.reader, ["rev-parse", "HEAD"]);
    const failPresence = runnerFor(r.reader, (args) =>
      args[0] === "rev-list" && args[1] === "--count" && args[3] === `^${head}` ? "fail" : "pass",
    );

    const changes = await probe(r.reader, { runGit: failPresence });

    expect(changes?.missing).toEqual([]);
    expect(changes?.cleanKey).toBeNull();
  });

  test("when the reader's own commits filled the limit and nothing else was seen", async () => {
    // Arrange — Nick landed more of his own commits than one probe reads
    const r = await repos("own-filled-limit");
    await gitIn(r.reader, ["checkout", "-q", "-b", "nick/other", "origin/staging"]);
    for (const n of Array.from({ length: MAX_LANDED_COMMITS_SCANNED + 1 }, (_, index) => index + 1)) {
      await commitFile(r.reader, FILE, `export const offset = ${String(100 + n)};\n`, `Own ${String(n)}`, {
        as: NICK,
        date: `2026-06-01T10:${String(n).padStart(2, "0")}:00Z`,
      });
    }
    await gitIn(r.reader, ["push", "-q", "origin", "HEAD:staging"]);
    await gitIn(r.reader, ["checkout", "-q", "nick/work"]);
    await readerFetches(r);

    // Act
    const changes = await probe(r.reader);

    // Assert — nothing of a teammate's in reach, and that is not "clean"
    expect(changes?.missing).toEqual([]);
    expect(changes?.moreMissing).toBe(true);
    expect(changes?.cleanKey).toBeNull();
  }, HEAVY_SETUP_MS);
});

/** A dozen merge landings on the file yesterday, all in Nick's checkout. */
const dozenLandings = async (label: string): Promise<LandingRepos> => {
  const r = await repos(label);
  for (const n of Array.from({ length: 12 }, (_, index) => index + 1)) {
    await landWithMergeCommit(r, {
      ...JUNE_LANDING,
      content: `export const offset = ${String(200 + n)};\n`,
      subject: `Landing ${String(n)}`,
      writtenAt: `2026-09-22T10:${String(n).padStart(2, "0")}:00Z`,
      landedAt: `2026-09-23T10:${String(n).padStart(2, "0")}:00Z`,
    });
  }
  await readerFetches(r);
  await gitIn(r.reader, ["merge", "-q", "--no-edit", "origin/staging"], { as: NICK });
  return r;
};

describe("certainty and limits", () => {
  test("nothing to undo is certain, whatever the limit: clean, not 'possibly more'", async () => {
    // Arrange — Mike's 51 commits landed; Nick has their content by squash
    const r = await repos("moot-capped");
    await gitIn(r.teammate, ["checkout", "-q", "-B", "staging", "origin/staging"]);
    for (const n of Array.from({ length: MAX_LANDED_COMMITS_SCANNED + 1 }, (_, index) => index + 1)) {
      await commitFile(r.teammate, FILE, `export const offset = ${String(100 + n)};\n`, `Mike ${String(n)}`, {
        as: MIKE,
        date: minute("2026-06-01", n),
      });
    }
    await gitIn(r.teammate, ["push", "-q", "origin", "staging"]);
    await readerFetches(r);
    await gitIn(r.reader, ["merge", "-q", "--squash", "origin/staging"]);
    await gitIn(r.reader, ["commit", "-q", "-m", "Take staging"], { as: NICK });

    // Act
    const changes = await probe(r.reader);

    // Assert
    expect(changes?.missing).toEqual([]);
    expect(changes?.moreMissing).toBe(false);
    expect(changes?.cleanKey).toMatch(/\S/);
  }, HEAVY_SETUP_MS);

  test("a recent walk that reached its limit is not complete, even with nothing to say", async () => {
    // Arrange — Nick's own 51 commits landed by merge yesterday, and he has them
    const r = await repos("recent-capped-own");
    await gitIn(r.reader, ["checkout", "-q", "-b", "nick/many", "origin/main"]);
    for (const n of Array.from({ length: MAX_LANDED_COMMITS_SCANNED + 1 }, (_, index) => index + 1)) {
      await commitFile(r.reader, FILE, `export const offset = ${String(100 + n)};\n`, `Own ${String(n)}`, {
        as: NICK,
        date: minute("2026-09-22", n),
      });
    }
    await gitIn(r.reader, ["push", "-q", "origin", "nick/many"]);
    await gitIn(r.teammate, ["fetch", "-q", "origin"]);
    await gitIn(r.teammate, ["checkout", "-q", "-B", "staging", "origin/staging"]);
    await gitIn(r.teammate, ["merge", "-q", "--no-ff", "-m", "Merge nick/many", "origin/nick/many"], {
      as: MIKE,
      date: "2026-09-23T10:00:00Z",
    });
    await gitIn(r.teammate, ["push", "-q", "origin", "staging"]);
    await readerFetches(r);
    await gitIn(r.reader, ["checkout", "-q", "-B", "nick/on-staging", "origin/staging"]);

    // Act
    const changes = await probe(r.reader);

    // Assert — the reader's own work is never news; a capped walk is never "clean"
    expect(changes?.recent).toEqual([]);
    expect(changes?.cleanKey).toBeNull();
  }, HEAVY_SETUP_MS);

  test("no git call starts once the deadline has passed, not even one already queued", async () => {
    // Arrange — a dozen merge landings: their merge sides are asked at once.
    // Each waits at a gate that opens only after the probe has given up, so
    // exactly eight hold the slots and four wait in the queue at the deadline.
    const r = await dozenLandings("deadline-queue");
    const gate = Promise.withResolvers<void>();
    const mergeSidesStarted = { count: 0 };
    const isMergeSide = (args: readonly string[]): boolean =>
      args[0] === "log" && args.includes("--no-merges") && !args.includes("--left-only") && !args.includes("--format=%aE");
    const real = quietGitRunner(r.reader, LANDED_GIT_TIMEOUT_MS);
    const gated: GitRunner = async (args) => {
      if (isMergeSide(args)) {
        mergeSidesStarted.count += 1;
        await gate.promise;
      }
      return real(args);
    };

    // Act — the probe gives up at its deadline; then the gate opens
    await probe(r.reader, { runGit: gated, budgetMs: 1_500 });
    gate.resolve();
    await Bun.sleep(500);

    // Assert — the queue was reached, and nothing queued started past the deadline
    expect(mergeSidesStarted.count).toBe(8);
  }, HEAVY_SETUP_MS);
});

describe("a recent walk at git's limit", () => {
  test("fifty-one landings on the first-parent line in the window: not complete, never clean", async () => {
    // Arrange — Nick's own 51 commits pushed straight onto staging yesterday;
    // own work is never news, but the walk that saw it hit its limit
    const r = await repos("landings-at-limit");
    await gitIn(r.reader, ["checkout", "-q", "-b", "nick/straight", "origin/staging"]);
    for (const n of Array.from({ length: MAX_LANDED_COMMITS_SCANNED + 1 }, (_, index) => index + 1)) {
      await commitFile(r.reader, FILE, `export const offset = ${String(300 + n)};\n`, `Own ${String(n)}`, {
        as: NICK,
        date: minute("2026-09-23", n),
      });
    }
    await gitIn(r.reader, ["push", "-q", "origin", "HEAD:staging"]);
    await readerFetches(r);

    // Act
    const changes = await probe(r.reader);

    // Assert
    expect(changes?.recent).toEqual([]);
    expect(changes?.missing).toEqual([]);
    expect(changes?.cleanKey).toBeNull();
  }, HEAVY_SETUP_MS);
});

describe("the git processes one probe runs", () => {
  test("never more than eight at once, however many landings there are", async () => {
    // Arrange — a dozen merge landings on the file yesterday, all in Nick's checkout
    const r = await dozenLandings("semaphore");
    const real = quietGitRunner(r.reader, LANDED_GIT_TIMEOUT_MS);
    const concurrency = { active: 0, peak: 0 };
    const counting: GitRunner = async (args) => {
      concurrency.active += 1;
      concurrency.peak = Math.max(concurrency.peak, concurrency.active);
      try {
        await Bun.sleep(20);
        return await real(args);
      } finally {
        concurrency.active -= 1;
      }
    };

    // Act
    const changes = await probe(r.reader, { runGit: counting });

    // Assert
    expect(changes?.recent.length).toBeGreaterThan(0);
    expect(concurrency.peak).toBeLessThanOrEqual(8);
    expect(concurrency.peak).toBeGreaterThan(1);
  }, HEAVY_SETUP_MS);
});

describe("the cache key", () => {
  test("a known clean key skips the walk: no history is read", async () => {
    // Arrange
    const r = await repos("cache-counted");
    const first = await probe(r.reader);
    const seen: string[][] = [];

    // Act
    const second = await probe(r.reader, {
      knownCleanKeys: [first?.cleanKey ?? "none"],
      runGit: runnerFor(r.reader, () => "pass", seen),
    });

    // Assert — the same answer, and not one `git log`
    expect(first?.cleanKey).toMatch(/\S/);
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
    const duringOther = await probe(r.reader, { knownCleanKeys: [duringCarrier?.cleanKey ?? "none"] });
    await gitIn(r.reader, ["merge", "--abort"]);

    // Assert — the carrier brings Mike's commit; the other merge does not
    expect(duringCarrier?.missing).toEqual([]);
    expect(duringOther?.cleanKey).not.toBe(duringCarrier?.cleanKey);
    expect(duringOther?.missing.map((c) => c.subject)).toEqual(["Fix line offset"]);
  });

  test("moves with a cherry-pick in progress and with .mailmap", async () => {
    // Arrange — Nick and Mike changed src/other.ts differently
    const r = await repos("key-pick-mailmap");
    await gitIn(r.teammate, ["checkout", "-q", "-b", "mike/other", "origin/main"]);
    const theirs = await commitFile(r.teammate, "src/other.ts", "export const other = 2;\n", "Mike other", { as: MIKE });
    await gitIn(r.teammate, ["push", "-q", "origin", "mike/other"]);
    await commitFile(r.reader, "src/other.ts", "export const other = 5;\n", "Nick other", { as: NICK });
    await readerFetches(r);
    const before = await probe(r.reader);

    // Act — a conflicting pick of another file, then a .mailmap
    await gitIn(r.reader, ["cherry-pick", theirs], { as: NICK }).catch(() => undefined);
    const duringPick = await probe(r.reader);
    await gitIn(r.reader, ["cherry-pick", "--abort"]);
    await writeFile(join(r.reader, ".mailmap"), "Mike <mike@example.com> <mike@old.example>\n");
    const withMailmap = await probe(r.reader);

    // Assert — all three say nothing about src/lines.ts, under three keys
    expect(new Set([before?.cleanKey, duringPick?.cleanKey, withMailmap?.cleanKey]).size).toBe(3);
    expect(duringPick?.cleanKey).toMatch(/\S/);
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
    expect(otherIdentity?.cleanKey).not.toBe(base?.cleanKey);
    expect(nextDay?.cleanKey).not.toBe(otherIdentity?.cleanKey);
  });
});

describe("the limit, while a merge is arriving", () => {
  test("a limit spent on arriving commits is asked again, and what arrives is not missing", async () => {
    // Arrange — Mike's branch, being merged, brings more commits to the file
    // than one probe reads, Ken's among them: git is asked again past them
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
    // Landed in June: this test is about the missing half, not the recent one
    await gitIn(r.teammate, ["merge", "-q", "--no-ff", "-m", "Merge mike/many", "mike/many"], {
      as: MIKE,
      date: "2026-06-10T10:00:00Z",
    });
    await gitIn(r.teammate, ["push", "-q", "origin", "staging"]);
    await readerFetches(r);
    await gitIn(r.reader, ["merge", "--no-commit", "--no-ff", "origin/mike/many"], { as: NICK });

    // Act
    const changes = await probe(r.reader);
    await gitIn(r.reader, ["merge", "--abort"]);

    // Assert — everything on staging arrives with this merge: nothing missing,
    // every branch checked, and the answer is complete
    expect(changes?.missing).toEqual([]);
    expect(changes?.unchecked).toEqual([]);
    expect(changes?.cleanKey).toMatch(/\S/);
  }, HEAVY_SETUP_MS);
});

/** Two lines far enough apart that changes to each merge without conflict. */
const twoLines = (top: number, bottom: number): string =>
  `export const top = ${String(top)};\n// a\n// b\n// c\n// d\n// e\nexport const bottom = ${String(bottom)};\n`;

const minute = (base: string, n: number): string => `${base}T10:${String(n).padStart(2, "0")}:00Z`;

/**
 * Nick merging Mike's branch, which brings 51 commits to the file and fills
 * the limit, while Ken's 40 older commits stay missing. The merge is left in
 * progress; the caller aborts it.
 */
const mergeThatFillsTheLimit = async (label: string): Promise<LandingRepos> => {
  const r = await repos(label);
  // Both lines exist on main and staging before anyone branches
  await landWithSquash(r, { file: FILE, content: twoLines(0, 0), subject: "Two lines", landing: "main", landedAt: "2026-05-01T10:00:00Z" });
  await gitIn(r.teammate, ["push", "-q", "origin", "main:staging"]);
  await readerFetches(r);
  await gitIn(r.reader, ["checkout", "-q", "-B", "nick/work", "origin/main"]);
  // Ken changes the top line forty times on staging, in June
  await gitIn(r.teammate, ["checkout", "-q", "-B", "staging", "origin/staging"]);
  for (const n of Array.from({ length: 40 }, (_, index) => index + 1)) {
    await commitFile(r.teammate, FILE, twoLines(n, 0), `Ken ${String(n)}`, { as: KEN, date: minute("2026-06-01", n) });
  }
  await gitIn(r.teammate, ["push", "-q", "origin", "staging"]);
  // Mike changes the bottom line fifty-one times, in July, and it lands too
  await gitIn(r.teammate, ["checkout", "-q", "-B", "mike/many", "origin/main"]);
  for (const n of Array.from({ length: MAX_LANDED_COMMITS_SCANNED + 1 }, (_, index) => index + 1)) {
    await commitFile(r.teammate, FILE, twoLines(0, n), `Mike ${String(n)}`, { as: MIKE, date: minute("2026-07-01", n) });
  }
  await gitIn(r.teammate, ["push", "-q", "origin", "mike/many"]);
  await gitIn(r.teammate, ["checkout", "-q", "-B", "staging", "origin/staging"]);
  await gitIn(r.teammate, ["merge", "-q", "--no-ff", "-m", "Merge mike/many", "mike/many"], { as: MIKE, date: "2026-07-02T10:00:00Z" });
  await gitIn(r.teammate, ["push", "-q", "origin", "staging"]);
  await readerFetches(r);
  // Nick merges Mike's branch: Mike's commits arrive, Ken's do not
  await gitIn(r.reader, ["merge", "--no-commit", "--no-ff", "origin/mike/many"], { as: NICK });
  return r;
};

/** Fifty-five of Ken's commits missing; Nick is picking the newest, in conflict. */
const pickAmongMany = async (label: string): Promise<{ readonly r: LandingRepos; readonly newest: string }> => {
  const r = await repos(label);
  await commitFile(r.reader, FILE, "export const offset = 5;\n", "Nick's offset", { as: NICK });
  await gitIn(r.teammate, ["checkout", "-q", "-B", "staging", "origin/staging"]);
  for (const n of Array.from({ length: 55 }, (_, index) => index + 1)) {
    await commitFile(r.teammate, FILE, `export const offset = ${String(100 + n)};\n`, `Ken ${String(n)}`, {
      as: KEN,
      date: minute("2026-06-01", n),
    });
  }
  await gitIn(r.teammate, ["push", "-q", "origin", "staging"]);
  await readerFetches(r);
  const newest = await gitIn(r.reader, ["rev-parse", "refs/remotes/origin/staging"]);
  await gitIn(r.reader, ["cherry-pick", newest], { as: NICK }).catch(() => undefined);
  return { r, newest };
};

/** The second, narrower missing question askPastArriving puts to git. */
const isSecondMissingQuery = (args: readonly string[]): boolean =>
  args.includes("--left-only") &&
  (args.some((arg) => arg.startsWith("^")) || args.includes(`--max-count=${String(MAX_LANDED_COMMITS_SCANNED + 1)}`));

describe("the limit, never at the cost of what is certainly missing", () => {
  test("a merge that fills the limit still leaves Ken's missing commits reported", async () => {
    // Arrange
    const r = await mergeThatFillsTheLimit("cap-merge-keeps");

    // Act
    const changes = await probe(r.reader);
    await gitIn(r.reader, ["merge", "--abort"]);

    // Assert
    expect(changes?.missing.filter((c) => c.subject.startsWith("Ken"))).toHaveLength(40);
    expect(changes?.missing.filter((c) => c.subject.startsWith("Mike"))).toEqual([]);
    expect(changes?.unchecked).toEqual([]);
  }, HEAVY_SETUP_MS);

  test("a cherry-pick of one of many missing commits still reports the rest", async () => {
    // Arrange
    const { r, newest } = await pickAmongMany("cap-pick-keeps");

    // Act
    const changes = await probe(r.reader);

    // Assert — the rest are said, as a floor, and the branch was checked
    expect(changes?.missing).toHaveLength(MAX_LANDED_COMMITS_SCANNED);
    expect(changes?.missing.map((c) => c.sha)).not.toContain(newest);
    expect(changes?.moreMissing).toBe(true);
    expect(changes?.unchecked).toEqual([]);
  }, HEAVY_SETUP_MS);

  test("when the second question fails, what is certainly missing is still said, as a floor", async () => {
    // Arrange — the first question saw 49 of Ken's commits besides the picked one
    const { r, newest } = await pickAmongMany("second-fails-floor");
    const failSecond = runnerFor(r.reader, (args) => (isSecondMissingQuery(args) ? "fail" : "pass"));

    // Act
    const changes = await probe(r.reader, { runGit: failSecond });

    // Assert
    expect(changes?.missing).toHaveLength(MAX_LANDED_COMMITS_SCANNED - 1);
    expect(changes?.missing.map((c) => c.sha)).not.toContain(newest);
    expect(changes?.moreMissing).toBe(true);
    expect(changes?.unchecked).toEqual([]);
    expect(changes?.cleanKey).toBeNull();
  }, HEAVY_SETUP_MS);

  test("when the second question fails and nothing was certain, the branch is named unchecked", async () => {
    // Arrange — every commit the first question saw is arriving with the merge
    const r = await mergeThatFillsTheLimit("second-fails-empty");
    const failSecond = runnerFor(r.reader, (args) => (isSecondMissingQuery(args) ? "fail" : "pass"));

    // Act
    const changes = await probe(r.reader, { runGit: failSecond });
    await gitIn(r.reader, ["merge", "--abort"]);

    // Assert — never a silent "possibly more" under nobody's name
    expect(changes?.unchecked).toEqual(["staging"]);
    expect(changes?.cleanKey).toBeNull();
  }, HEAVY_SETUP_MS);
});

describe("the team's branch order", () => {
  test("a change on two branches is listed in the team's order, whichever answers first", async () => {
    // Arrange — landed on staging, promoted to main; main's question is slowed
    // so staging always answers first
    const r = await repos("branch-order");
    await landWithMergeCommit(r, JUNE_LANDING);
    await gitIn(r.teammate, ["push", "-q", "origin", "staging:main"]);
    // staging moves on (another file), so the two tips — and questions — differ
    await landWithSquash(r, { ...JUNE_LANDING, file: "src/other.ts", subject: "Other work", landedAt: "2026-06-05T10:00:00Z" });
    await readerFetches(r);
    const mainTip = await gitIn(r.reader, ["rev-parse", "refs/remotes/origin/main"]);
    const slowMain = runnerFor(r.reader, (args) =>
      args.includes("--left-only") && args.some((arg) => arg.startsWith(`${mainTip}...`)) ? 300 : "pass",
    );

    // Act
    const changes = await probe(r.reader, { runGit: slowMain });

    // Assert
    expect(changes?.missing.map((c) => c.branches)).toEqual([["main", "staging"]]);
  });
});

describe("a slow landing branch", () => {
  test("past the deadline, it is named unchecked and the others still say what they know", async () => {
    // Arrange — Ken's change is missing via main; staging's question is slow
    const r = await repos("slow-branch");
    await landWithSquash(r, { ...JUNE_LANDING, landing: "main", author: KEN, subject: "Ken on main" });
    await readerFetches(r);
    const stagingTip = await gitIn(r.reader, ["rev-parse", "refs/remotes/origin/staging"]);
    const slowStaging = runnerFor(r.reader, (args) =>
      args.includes("--left-only") && args.some((arg) => arg.startsWith(`${stagingTip}...`)) ? 2_000 : "pass",
    );

    // Act
    const changes = await probe(r.reader, { runGit: slowStaging, budgetMs: 800 });

    // Assert
    expect(changes?.missing.map((c) => c.subject)).toEqual(["Ken on main"]);
    expect(changes?.unchecked).toEqual(["staging"]);
    expect(changes?.cleanKey).toBeNull();
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

  test("a revert whose ancestry cannot be read is still said, not taken as a re-landing", async () => {
    // Arrange — the revert-recent case, with the ancestry question failing
    const r = await repos("ancestry-unknown");
    await landWithSquash(r, { ...JUNE_LANDING, subject: "X" });
    const revert = await landWithSquash(r, {
      ...JUNE_LANDING,
      content: ORIGINAL_CONTENT,
      subject: 'Revert "X"',
      author: KEN,
      landedAt: "2026-09-23T09:00:00Z",
    });
    await readerFetches(r);
    await gitIn(r.reader, ["checkout", "-q", "-B", "nick/on-staging", "origin/staging"]);
    // Only "is this old tip an ancestor of the revert?" — Nick's HEAD IS the
    // revert, so the presence question has the same `^revert` and must pass
    const failAncestry = runnerFor(r.reader, (args) =>
      args[0] === "rev-list" && args[1] === "--count" && args[2] !== revert && args[3] === `^${revert}`
        ? "fail"
        : "pass",
    );

    // Act
    const changes = await probe(r.reader, { runGit: failAncestry });

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
