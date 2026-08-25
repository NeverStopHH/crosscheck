/**
 * Cost visibility (DESIGN.md §10 risk 7): the summarizer spends the
 * developer's OWN Claude quota, so `crosscheck status` and `doctor` surface
 * the per-session invocation count and a rough token estimate — marked as
 * an estimate wherever it is printed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm, utimes } from "node:fs/promises";
import { join } from "node:path";

import { runCli } from "../src/index.ts";
import {
  formatSummarizerCost,
  isSummarizerSilentlyDead,
  readSummarizerCost,
} from "@crosscheck/connector-claude";
import { writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

/** Unreachable on purpose: cost lines are local facts, no hub needed. */
const HUB_URL = "http://127.0.0.1:9";
const REPO_ID = "github.com/acme/api";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const env = (home: string) => ({
  CROSSCHECK_HOME: home,
  HOME: home,
  CROSSCHECK_HUB_URL: HUB_URL,
  CROSSCHECK_API_KEY: "test-key",
});

const seedSession = async (
  home: string,
  repoRoot: string,
  hostSessionKey: string,
  overrides: Record<string, unknown> = {},
): Promise<void> => {
  await writeSessionState(home, {
    hostSessionKey,
    crosscheckSessionId: `cc_${hostSessionKey}`,
    workContextId: `wc_cc_${hostSessionKey}`,
    repoId: REPO_ID,
    repoRoot,
    hubUrl: HUB_URL,
    developerId: "dev_self",
    startedAt: new Date().toISOString(),
    ...overrides,
  });
};

describe("summarizer cost surfaces", () => {
  test("readSummarizerCost sums this repo's live sessions and nothing else", async () => {
    // Arrange: two live sessions on this repo, one on a foreign repo
    const repo = await makeRepo("cost", { remote: "git@github.com:acme/api.git" });
    const home = await makeHome("cost");
    paths.push(repo, home);
    await seedSession(home, repo, "cost-a", {
      summarizerFireCount: 2,
      summarizerEstimatedTokens: 800,
      summarizerNoneCount: 1,
      summarizerDraftCount: 1,
    });
    await seedSession(home, repo, "cost-b", {
      summarizerFireCount: 1,
      summarizerEstimatedTokens: 400,
      summarizerNoneCount: 1,
    });
    await seedSession(home, repo, "cost-foreign", {
      repoId: "github.com/acme/other",
      summarizerFireCount: 9,
      summarizerEstimatedTokens: 9000,
      summarizerNoneCount: 9,
      summarizerDraftCount: 9,
    });

    // Act
    const cost = await readSummarizerCost(home, HUB_URL, REPO_ID);

    // Assert — fires/NONEs/drafts are the trial's signal-to-noise counters
    expect(cost.sessions).toBe(2);
    expect(cost.fires).toBe(3);
    expect(cost.nones).toBe(2);
    expect(cost.drafts).toBe(1);
    expect(cost.estimatedTokens).toBe(1200);
  });

  test("status prints the count and the token figure marked as an estimate", async () => {
    const repo = await makeRepo("cost-status", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("cost-status");
    paths.push(repo, home);
    await seedSession(home, repo, "cost-status-a", {
      summarizerFireCount: 3,
      summarizerEstimatedTokens: 1200,
      summarizerNoneCount: 2,
      summarizerDraftCount: 1,
    });

    const result = await runCli(["status"], env(home), repo);

    expect(result.stdout).toContain("summarizer: 3 runs");
    expect(result.stdout).toContain("(2 NONE, 1 draft)");
    expect(result.stdout).toContain("~1200 tokens (estimate)");
  });

  test("doctor carries a summarizer cost check, PASS and marked estimate", async () => {
    const repo = await makeRepo("cost-doctor", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("cost-doctor");
    paths.push(repo, home);
    await seedSession(home, repo, "cost-doctor-a", {
      summarizerFireCount: 2,
      summarizerEstimatedTokens: 640,
    });

    const result = await runCli(["doctor"], env(home), repo);

    expect(result.stdout).toContain("PASS  summarizer cost");
    expect(result.stdout).toContain("2 runs");
    expect(result.stdout).toContain("(estimate)");
  });

  test("readSummarizerCost sums the runner's failures and carries one booked reason", async () => {
    // Arrange: two sessions lost runs; one of them booked why
    const repo = await makeRepo("cost-fails", { remote: "git@github.com:acme/api.git" });
    const home = await makeHome("cost-fails");
    paths.push(repo, home);
    await seedSession(home, repo, "cost-fails-a", {
      summarizerFireCount: 2,
      summarizerFailCount: 2,
      summarizerLastFailure: "exit 1: Not logged in Please run /login",
    });
    await seedSession(home, repo, "cost-fails-b", {
      summarizerFireCount: 1,
      summarizerFailCount: 1,
    });

    // Act
    const cost = await readSummarizerCost(home, HUB_URL, REPO_ID);

    // Assert
    expect(cost.fails).toBe(3);
    expect(cost.lastFailure).toBe("exit 1: Not logged in Please run /login");
  });

  test("status prints the fail count and the last booked reason beside NONE and drafts", async () => {
    const repo = await makeRepo("cost-fails-status", { remote: "git@github.com:acme/api.git" });
    const home = await makeHome("cost-fails-status");
    paths.push(repo, home);
    await seedSession(home, repo, "cost-fails-status-a", {
      summarizerFireCount: 3,
      summarizerFailCount: 3,
      summarizerLastFailure: "exit 1: Not logged in Please run /login",
    });

    const result = await runCli(["status"], env(home), repo);

    expect(result.stdout).toContain(
      'summarizer: 3 runs (0 NONE, 0 drafts, 3 failed: last "exit 1: Not logged in Please run /login")',
    );
  });

  test("doctor WARNs when fires reach the threshold and not one answered — the finding-#14 signature", async () => {
    // Arrange: three fires, no NONE, no draft — the trial's "17 runs (0 NONE, 0 drafts)"
    const repo = await makeRepo("cost-silent", { remote: "git@github.com:acme/api.git" });
    const home = await makeHome("cost-silent");
    paths.push(repo, home);
    await seedSession(home, repo, "cost-silent-a", {
      summarizerFireCount: 3,
      summarizerEstimatedTokens: 900,
    });

    // Act
    const result = await runCli(["doctor"], env(home), repo);

    // Assert: the line is WARN, names the remainder, points at the probe —
    // and asserts nothing about the runner's CURRENT health: fires booked
    // before a fix or a login stay in live state files until SessionEnd, so
    // this line can sit right above a PASSing runner probe and must not
    // contradict it ("the runner is failing" did).
    const line = result.stdout.split("\n").find((entry) => entry.includes("summarizer cost")) ?? "";
    expect(line).toContain("WARN  summarizer cost");
    expect(line).toContain("3 runs fired, none answered — see the summarizer runner check");
    expect(line).not.toContain("is failing");
  });

  // BOUNDARY PIN, green on main by design (main always printed PASS here):
  // it proves the WARN above does not over-reach, not that the WARN exists —
  // the mutation "doctor calls a summarizer that never answers healthy" is
  // caught by the WARN test, never by this one.
  test("boundary pin: doctor stays PASS below the threshold, and at it when even one run answered", async () => {
    const repo = await makeRepo("cost-not-silent", { remote: "git@github.com:acme/api.git" });
    const home = await makeHome("cost-not-silent");
    paths.push(repo, home);
    // Below the threshold: two fires, nothing answered — noise, not news.
    await seedSession(home, repo, "cost-not-silent-a", { summarizerFireCount: 2 });
    const below = await runCli(["doctor"], env(home), repo);
    expect(below.stdout).toContain("PASS  summarizer cost");
    // At the threshold with one NONE: the runner demonstrably works.
    await seedSession(home, repo, "cost-not-silent-a", {
      summarizerFireCount: 3,
      summarizerNoneCount: 1,
    });
    const answered = await runCli(["doctor"], env(home), repo);
    expect(answered.stdout).toContain("PASS  summarizer cost");
  });

  test("no live sessions reads as exactly that, not as zero cost forever", async () => {
    const repo = await makeRepo("cost-none", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("cost-none");
    paths.push(repo, home);

    const result = await runCli(["status"], env(home), repo);

    expect(result.stdout).toContain("summarizer: no live sessions");
  });
});

/**
 * ── M5: which files the scan reads, and what it calls them ────────────────
 *
 * `readSummarizerCost` took `readdir` order — neither alphabetical nor
 * chronological on bun — sliced the first 50 and reduced. On the trial machine
 * that read an arbitrary half of 100 files and printed
 * `13 runs (1 NONE, 2 drafts) … across 50 live sessions`, where the full set
 * said 27/3/3; every one of those "live sessions" was a state file, and 75 of
 * them belonged to sessions killed hours or days earlier.
 */
describe("summarizer cost reads the newest sessions, and says how many", () => {
  /** Backdates a state file so mtime order is ours, not the writer's. */
  const backdate = async (
    home: string,
    hostSessionKey: string,
    ageMs: number,
  ): Promise<void> => {
    const when = new Date(Date.now() - ageMs);
    await utimes(join(home, "sessions", `${hostSessionKey}.json`), when, when);
  };

  test("with 60 files, the 50 NEWEST are read and the fires in them are counted", async () => {
    // Arrange: 60 sessions. The ten NEWEST carry every fire; the fifty oldest
    // carry none, and are backdated so that ANY order-blind slice of 50 that
    // is not mtime-sorted can miss the fires entirely.
    const repo = await makeRepo("cost-order", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("cost-order");
    paths.push(repo, home);
    for (let index = 0; index < 60; index += 1) {
      const carriesFires = index >= 50;
      await seedSession(home, repo, `zzz-old-${String(index).padStart(3, "0")}`, {
        lastHeartbeatAt: new Date().toISOString(),
        ...(carriesFires
          ? { summarizerFireCount: 2, summarizerNoneCount: 2, summarizerEstimatedTokens: 100 }
          : {}),
      });
    }
    // Older files first by mtime; the fire-carrying ten are the newest.
    for (let index = 0; index < 60; index += 1) {
      await backdate(
        home,
        `zzz-old-${String(index).padStart(3, "0")}`,
        (60 - index) * 60_000,
      );
    }

    // Act
    const cost = await readSummarizerCost(home, HUB_URL, REPO_ID);

    // Assert: all twenty fires of the ten newest files are in the total, and
    // the line says it read fifty of sixty rather than implying all of them.
    expect(cost.filesSeen).toBe(60);
    expect(cost.filesRead).toBe(50);
    expect(cost.fires).toBe(20);
    expect(formatSummarizerCost(cost)).toContain("50 of 60 session state files");
  });

  test("sessions that stopped heartbeating are skipped and counted, not called live", async () => {
    // Arrange: three state files whose sessions died 26 hours ago
    const repo = await makeRepo("cost-zombie", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("cost-zombie");
    paths.push(repo, home);
    const deadAgeMs = 26 * 60 * 60 * 1000;
    const dead = new Date(Date.now() - deadAgeMs).toISOString();
    for (const id of ["dead-1", "dead-2", "dead-3"]) {
      await seedSession(home, repo, id, {
        startedAt: dead,
        lastHeartbeatAt: dead,
        summarizerFireCount: 4,
      });
      // The FILE is 26 hours old too. Silence is measured off the newest of the
      // heartbeat, the start and the file's own mtime (state/session-scan.ts),
      // because every writer of a state file is one of that session's hooks —
      // so a file written a moment ago belongs to a session that is running.
      await backdate(home, id, deadAgeMs);
    }

    // Act
    const cost = await readSummarizerCost(home, HUB_URL, REPO_ID);

    // Assert: zero live sessions, and the corpses are a number rather than
    // silence — on the pre-fix tree this read "3 live sessions".
    expect(cost.sessions).toBe(0);
    expect(cost.staleSkipped).toBe(3);
    const line = formatSummarizerCost(cost);
    expect(line).toContain("3 stale skipped");
    expect(line).not.toContain("3 live sessions");
  });

  test("unparsed answers are their own number, not part of the failure count", async () => {
    // Arrange
    const repo = await makeRepo("cost-unparsed", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("cost-unparsed");
    paths.push(repo, home);
    await seedSession(home, repo, "unparsed-a", {
      lastHeartbeatAt: new Date().toISOString(),
      summarizerFireCount: 3,
      summarizerNoneCount: 1,
      summarizerUnparsedCount: 2,
    });

    // Act
    const cost = await readSummarizerCost(home, HUB_URL, REPO_ID);

    // Assert
    expect(cost.unparsedAnswers).toBe(2);
    expect(cost.fails).toBe(0);
    expect(formatSummarizerCost(cost)).toContain("2 unparsed");
  });

  test("mostly-dead: more than half the fires unexplained, above the sample floor", () => {
    // Arrange: the trial's own shape — 27 fires, 6 explained, 21 vanished
    const trial = {
      sessions: 1,
      filesSeen: 100,
      filesRead: 50,
      staleSkipped: 0,
      parseFailures: 0,
      unparsedAnswers: 0,
      intentFires: 0,
      fires: 27,
      nones: 3,
      drafts: 3,
      fails: 0,
      lastFailure: null,
      estimatedTokens: 0,
    };

    // Act + Assert
    expect(isSummarizerSilentlyDead(trial)).toBe(true);
    // And the sample floor: the same RATIO on three fires is not evidence,
    // because a draft dropped by the echo/secret/contract gates books nothing.
    expect(
      isSummarizerSilentlyDead({ ...trial, fires: 3, nones: 1, drafts: 0 }),
    ).toBe(false);
  });

  test("an intent counter is silent at zero and printed above it", async () => {
    // Arrange: the additive field feat/session-intent will write
    const repo = await makeRepo("cost-intent", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("cost-intent");
    paths.push(repo, home);
    await seedSession(home, repo, "intent-a", {
      lastHeartbeatAt: new Date().toISOString(),
      summarizerFireCount: 1,
      summarizerNoneCount: 1,
    });

    // Act
    const quiet = await readSummarizerCost(home, HUB_URL, REPO_ID);

    // Assert
    expect(formatSummarizerCost(quiet)).not.toContain("intent");
    expect(
      formatSummarizerCost({ ...quiet, intentFires: 4 }),
    ).toContain("4 intent captures");
  });
});
