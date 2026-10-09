/**
 * A LANDED-CHANGE CHECK CUT SHORT IS NEVER PASSED OFF AS SILENCE (2026-10-08).
 *
 * The flake hunt's finding: under load the probe's deadline ended it before
 * any landing branch answered, the hook stopped nothing and recorded nothing,
 * and the reader edited a teammate's landed change with nothing saying a
 * check had not finished. The probe now says WHY it could not say all it
 * would have (`cutShort`), and the hook books that in a local ledger of the
 * briefing omissions' shape, which `doctor` and `status` count.
 *
 * Deterministic: the git runner is injected, and a "slow" call is one held on
 * a promise the test itself releases — no wall clock decides who wins but the
 * probe's own deadline against a call that cannot answer before it.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import {
  BRIEFING_OMISSION_WINDOW_DAYS,
  LANDED_GIT_TIMEOUT_MS,
  MAX_BRIEFING_OMISSION_LEDGER_BYTES,
} from "../src/constants.ts";
import { quietGitRunner } from "../src/landed-changes/git-queries.ts";
import type { GitRunner } from "../src/landed-changes/git-queries.ts";
import { probeLandedChanges } from "../src/landed-changes/probe.ts";
import type { LandedProbeInput } from "../src/landed-changes/probe.ts";
import {
  bookLandedProbeCut,
  landedProbeCutsPath,
  readLandedProbeCuts,
  recordLandedProbeCut,
} from "../src/state/landed-probe-cuts.ts";
import { SessionStateSchema, readSessionState, writeSessionState } from "../src/state/session-state.ts";
import { makeHome } from "./helpers.ts";
import { KEN, gitIn, landWithSquash, makeLandingRepos, readerFetches } from "./fixtures/landing-repos.ts";
import type { LandingRepos } from "./fixtures/landing-repos.ts";

const NOW = new Date("2026-09-24T12:00:00Z");
const BERLIN = "Europe/Berlin";
const FILE = "src/lines.ts";
/** Room for honest git when nothing is held: no deadline in this file is meant to win then. */
const SEMANTICS_BUDGET_MS = 10_000;
/** The deadline a held call is up against: it cannot answer before it. */
const CUT_BUDGET_MS = 50;
const KEY = "hub-a__github.com-acme-api";
const OTHER_KEY = "hub-a__github.com-acme-web";
const MS_PER_DAY = 86_400_000;

const cleanups: string[] = [];
const releases: (() => void)[] = [];

afterEach(() => {
  for (const release of releases) {
    release();
  }
  releases.length = 0;
});

afterAll(async () => {
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

const repos = async (label: string): Promise<LandingRepos> => {
  const made = await makeLandingRepos(label);
  cleanups.push(made.base);
  return made;
};

const home = async (label: string): Promise<string> => {
  const made = await makeHome(label);
  cleanups.push(made);
  return made;
};

const probe = (root: string, overrides: Partial<LandedProbeInput> = {}) =>
  probeLandedChanges({ root, file: FILE, now: NOW, timeZone: BERLIN, budgetMs: SEMANTICS_BUDGET_MS, ...overrides });

/**
 * The real quiet runner, except that a call `isHeld` names waits on a gate
 * only the test opens (after its assertions, in afterEach) — and one
 * `isFailed` names answers nothing at all.
 */
const runnerFor = (
  root: string,
  rule: { readonly isHeld?: (args: readonly string[]) => boolean; readonly isFailed?: (args: readonly string[]) => boolean },
): GitRunner => {
  const real = quietGitRunner(root, LANDED_GIT_TIMEOUT_MS);
  const gate = new Promise<void>((resolve) => {
    releases.push(resolve);
  });
  return async (args) => {
    if (rule.isFailed?.(args) === true) {
      return null;
    }
    if (rule.isHeld?.(args) === true) {
      await gate;
    }
    return real(args);
  };
};

const isMissingWalk = (args: readonly string[]): boolean => args[0] === "log" && args.includes("--left-only");

const kenLandsOnStaging = async (r: LandingRepos): Promise<void> => {
  await landWithSquash(r, {
    file: FILE,
    content: "export const offset = 2;\n",
    subject: "Ken on staging",
    landing: "staging",
    landedAt: "2026-06-02T10:00:00Z",
    author: KEN,
  });
  await readerFetches(r);
};

describe("the probe says when it was cut short", () => {
  test("a deadline that wins before any landing branch answers is a deadline cut", async () => {
    // Arrange — Ken's change is missing; every missing walk is held
    const r = await repos("cut-deadline");
    await kenLandsOnStaging(r);
    const held = runnerFor(r.reader, { isHeld: isMissingWalk });

    // Act
    const probed = await probe(r.reader, { runGit: held, budgetMs: CUT_BUDGET_MS });

    // Assert — nothing it could stop for, and it says why
    expect(probed.cutShort).toBe("deadline");
    expect(probed.landed?.missing ?? []).toEqual([]);
    expect(probed.landed?.cleanKey ?? null).toBeNull();
  });

  test("a deadline that wins before even the repo is read is a deadline cut too", async () => {
    // Arrange — every git call is held, identity included
    const r = await repos("cut-before-refs");
    const held = runnerFor(r.reader, { isHeld: () => true });

    // Act
    const probed = await probe(r.reader, { runGit: held, budgetMs: CUT_BUDGET_MS });

    // Assert — no answer at all, and not passed off as "nothing to know here"
    expect(probed.landed).toBeNull();
    expect(probed.cutShort).toBe("deadline");
  });

  test("a finished probe with a branch git did not answer for is an unanswered cut", async () => {
    // Arrange — the staging walk fails; main answers
    const r = await repos("cut-unanswered");
    await kenLandsOnStaging(r);
    const stagingTip = await gitIn(r.reader, ["rev-parse", "refs/remotes/origin/staging"]);
    const failing = runnerFor(r.reader, {
      isFailed: (args) => isMissingWalk(args) && args.some((arg) => arg.startsWith(`${stagingTip}...`)),
    });

    // Act
    const probed = await probe(r.reader, { runGit: failing });

    // Assert
    expect(probed.cutShort).toBe("unanswered");
    expect(probed.landed?.unchecked).toEqual(["staging"]);
  });

  test("a probe that answered for every branch was not cut, found or not", async () => {
    // Arrange
    const quiet = await repos("cut-none-quiet");
    const found = await repos("cut-none-found");
    await kenLandsOnStaging(found);

    // Act
    const [nothing, missing] = await Promise.all([probe(quiet.reader), probe(found.reader)]);

    // Assert
    expect(nothing.cutShort).toBeNull();
    expect(nothing.landed?.cleanKey).not.toBeNull();
    expect(missing.cutShort).toBeNull();
    expect(missing.landed?.missing.map((c) => c.subject)).toEqual(["Ken on staging"]);
  });

  test("a clone that cannot know is not a cut: the probe answered", async () => {
    // Arrange — not a git repository at all
    const notARepo = await home("cut-not-a-repo");

    // Act
    const probed = await probe(notARepo);

    // Assert
    expect(probed.landed).toBeNull();
    expect(probed.cutShort).toBeNull();
  });
});

describe("the cut-checks ledger", () => {
  test("counts this repo's cuts by reason, and the newest", async () => {
    // Arrange
    const h = await home("cuts-count");
    await recordLandedProbeCut(h, { key: KEY, reason: "deadline", now: new Date(NOW.getTime() - 3_600_000) });
    await recordLandedProbeCut(h, { key: KEY, reason: "deadline", now: new Date(NOW.getTime() - 60_000) });
    await recordLandedProbeCut(h, { key: KEY, reason: "budget", now: new Date(NOW.getTime() - 30_000) });
    await recordLandedProbeCut(h, { key: KEY, reason: "unanswered", now: NOW });

    // Act
    const counts = await readLandedProbeCuts(h, KEY, NOW);

    // Assert
    expect(counts.total).toBe(4);
    expect(counts.byReason).toEqual({ deadline: 2, unanswered: 1, budget: 1 });
    expect(counts.lastAt).toBe(NOW.toISOString());
  });

  test("a cut is booked in the session and the ledger once per tool call, however many writers see it", async () => {
    // Arrange — the handler and the runner can both see one call's cut
    const h = await home("cuts-book");
    await writeSessionState(
      h,
      SessionStateSchema.parse({
        hostSessionKey: "s-book",
        crosscheckSessionId: "cc_s-book",
        workContextId: "wc_cc_s-book",
        repoId: "github.com/acme/api",
        repoRoot: "/tmp/repo",
        hubUrl: "http://127.0.0.1:1",
        developerId: "dev_1",
        startedAt: NOW.toISOString(),
      }),
    );
    const booking = { home: h, sessionId: "s-book", key: KEY, now: NOW } as const;

    // Act — the same call twice (handler, then runner), then another call
    await bookLandedProbeCut({ ...booking, toolUseId: "toolu_a", reason: "deadline" });
    await bookLandedProbeCut({ ...booking, toolUseId: "toolu_a", reason: "budget" });
    await bookLandedProbeCut({ ...booking, toolUseId: "toolu_b", reason: "budget" });

    // Assert
    expect((await readSessionState(h, "s-book"))?.landedProbeCuts).toBe(2);
    const counts = await readLandedProbeCuts(h, KEY, NOW);
    expect(counts.total).toBe(2);
    expect(counts.byReason).toEqual({ deadline: 1, unanswered: 0, budget: 1 });
  });

  test("the runner's booking returns only once the handler's booking of the same call is on disk (review batch 2, L6)", async () => {
    // Arrange — the handler's booking still in flight when the race resolves
    const h = await home("cuts-door");
    await writeSessionState(
      h,
      SessionStateSchema.parse({
        hostSessionKey: "s-door",
        crosscheckSessionId: "cc_s-door",
        workContextId: "wc_cc_s-door",
        repoId: "github.com/acme/api",
        repoRoot: "/tmp/repo",
        hubUrl: "http://127.0.0.1:1",
        developerId: "dev_1",
        startedAt: NOW.toISOString(),
      }),
    );
    const booking = { home: h, sessionId: "s-door", toolUseId: "toolu_door", key: KEY, now: NOW } as const;
    const handler = bookLandedProbeCut({ ...booking, reason: "deadline" });

    // Act — the runner books the same call; the binary exits right after it returns
    await bookLandedProbeCut({ ...booking, reason: "budget" });
    const whenRunnerReturns = await readLandedProbeCuts(h, KEY, NOW);
    const countWhenRunnerReturns = (await readSessionState(h, "s-door"))?.landedProbeCuts;
    await handler;

    // Assert — on disk already, and once
    expect(whenRunnerReturns.byReason).toEqual({ deadline: 1, unanswered: 0, budget: 0 });
    expect(countWhenRunnerReturns).toBe(1);
  });

  test("another repo's cut is not this repo's, and one older than the window stopped counting", async () => {
    // Arrange
    const h = await home("cuts-scope");
    const outside = new Date(NOW.getTime() - (BRIEFING_OMISSION_WINDOW_DAYS + 1) * MS_PER_DAY);
    await recordLandedProbeCut(h, { key: OTHER_KEY, reason: "deadline", now: NOW });
    await recordLandedProbeCut(h, { key: KEY, reason: "deadline", now: outside });

    // Act + Assert
    expect((await readLandedProbeCuts(h, KEY, NOW)).total).toBe(0);
  });

  test("the cuts are their own file, beside the briefing omissions, and a full one rotates instead of growing", async () => {
    // Arrange
    const h = await home("cuts-cap");
    const path = landedProbeCutsPath(h);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, "x".repeat(MAX_BRIEFING_OMISSION_LEDGER_BYTES));

    // Act
    await recordLandedProbeCut(h, { key: KEY, reason: "deadline", now: NOW });

    // Assert: the full file moved aside whole, and the cut started a new one
    // (review batch 2, M7, test/omission-ledger-rotation.test.ts).
    expect(path.endsWith("landed-probe-cuts.jsonl")).toBe(true);
    expect((await stat(`${path}.1`)).size).toBe(MAX_BRIEFING_OMISSION_LEDGER_BYTES);
    expect((await stat(path)).size).toBeLessThan(MAX_BRIEFING_OMISSION_LEDGER_BYTES);
  });
});
