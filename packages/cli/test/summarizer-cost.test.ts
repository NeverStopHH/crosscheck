/**
 * Cost visibility (DESIGN.md §10 risk 7): the summarizer spends the
 * developer's OWN Claude quota, so `crosscheck status` and `doctor` surface
 * the per-session invocation count and a rough token estimate — marked as
 * an estimate wherever it is printed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runCli } from "../src/index.ts";
import { readSummarizerCost } from "@crosscheck/connector-claude";
import { writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import {
  UNREADABLE_EMPTY,
  UNREADABLE_SHAPE,
} from "@crosscheck/connector-core/derive/summarizer/gate.ts";
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

  test("status names the refused answers and why (M16 / A3-4)", async () => {
    // A refusal is not a NONE and not a failure: the model answered and the
    // quota was spent, and before it was booked the line said nothing at all.
    const repo = await makeRepo("cost-refused", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("cost-refused");
    paths.push(repo, home);
    await seedSession(home, repo, "cost-refused-a", {
      summarizerFireCount: 3,
      summarizerEstimatedTokens: 1200,
      summarizerNoneCount: 1,
      summarizerRejectCount: 2,
      summarizerNoSliceCount: 0,
      summarizerLastNoSlice: null,
      summarizerLastRejection:
        "role-play: the answer narrated the next step instead of a conclusion",
    });

    const result = await runCli(["status"], env(home), repo);

    expect(result.stdout).toContain("2 refused");
    expect(result.stdout).toContain("role-play");
  });

  test("doctor WARNs when every answer is refused and nothing lands", async () => {
    // The remedy differs from a dead runner's, so the WARN is its own: the
    // runner probe would PASS here and send the reader to the wrong check.
    const repo = await makeRepo("cost-refused-doctor", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("cost-refused-doctor");
    paths.push(repo, home);
    await seedSession(home, repo, "cost-refused-doctor-a", {
      summarizerFireCount: 2,
      summarizerEstimatedTokens: 900,
      summarizerRejectCount: 2,
      summarizerNoSliceCount: 0,
      summarizerLastNoSlice: null,
      summarizerLastRejection:
        "echo: the answer repeated the instructions it was given",
    });

    const result = await runCli(["doctor"], env(home), repo);

    expect(result.stdout).toContain("WARN  summarizer cost");
    expect(result.stdout).toContain("every answer was refused");
    // And it does NOT claim the runner never spoke — that is the other WARN.
    expect(result.stdout).not.toContain("runs fired, none answered");
  });

  test("status names the unreadable answers and why", async () => {
    // The outcome a machine running a model other than Claude reaches first,
    // and the one this product booked NOWHERE until the foreign-model
    // contract test went looking: the model answered, the quota was spent,
    // and the only trace was the fires-minus-outcomes remainder.
    const repo = await makeRepo("cost-unreadable", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("cost-unreadable");
    paths.push(repo, home);
    await seedSession(home, repo, "cost-unreadable-a", {
      summarizerFireCount: 3,
      summarizerEstimatedTokens: 1200,
      summarizerNoneCount: 1,
      summarizerUnreadableCount: 2,
      summarizerLastUnreadable: UNREADABLE_SHAPE,
    });

    const result = await runCli(["status"], env(home), repo);

    expect(result.stdout).toContain("2 unreadable");
    expect(result.stdout).toContain("neither claim JSON nor NONE");
  });

  test("doctor WARNs on unreadable answers WITHOUT blaming the runner", async () => {
    // The binary ran and exited 0, so the runner probe PASSes: pointing the
    // reader at it would send them to a healthy binary. This WARN names the
    // model and the contract instead.
    const repo = await makeRepo("cost-unreadable-doctor", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("cost-unreadable-doctor");
    paths.push(repo, home);
    await seedSession(home, repo, "cost-unreadable-doctor-a", {
      summarizerFireCount: 2,
      summarizerEstimatedTokens: 900,
      summarizerUnreadableCount: 2,
      summarizerLastUnreadable: UNREADABLE_EMPTY,
    });

    const result = await runCli(["doctor"], env(home), repo);

    expect(result.stdout).toContain("WARN  summarizer cost");
    expect(result.stdout).toContain("nothing it said fitted the output contract");
    expect(result.stdout).toContain("FOREIGN-MODELS.md");
    // And it does NOT send the reader to the runner check: that is the other
    // WARN, for a binary that never spoke at all.
    expect(result.stdout).not.toContain("runs fired, none answered");
  });

  test("one unreadable answer beside a kept draft stays a PASS", async () => {
    // The threshold's control: a model wanders off-format now and then, and
    // a WARN that fires on that is one people learn to skip.
    const repo = await makeRepo("cost-unreadable-ok", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("cost-unreadable-ok");
    paths.push(repo, home);
    await seedSession(home, repo, "cost-unreadable-ok-a", {
      summarizerFireCount: 2,
      summarizerEstimatedTokens: 900,
      summarizerDraftCount: 1,
      summarizerUnreadableCount: 1,
      summarizerLastUnreadable: UNREADABLE_SHAPE,
    });

    const result = await runCli(["doctor"], env(home), repo);

    expect(result.stdout).toContain("PASS  summarizer cost");
  });

  test("one refusal beside a kept draft stays a PASS", async () => {
    // The control on the threshold: an echoed draft refused once, with a real
    // draft kept, is the guards working — nagging there is how a WARN stops
    // being read.
    const repo = await makeRepo("cost-refused-ok", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("cost-refused-ok");
    paths.push(repo, home);
    await seedSession(home, repo, "cost-refused-ok-a", {
      summarizerFireCount: 2,
      summarizerEstimatedTokens: 900,
      summarizerDraftCount: 1,
      summarizerRejectCount: 1,
      summarizerNoSliceCount: 0,
      summarizerLastNoSlice: null,
      summarizerLastRejection:
        "echo: the answer was a teammate hint this repo had already delivered",
    });

    const result = await runCli(["doctor"], env(home), repo);

    expect(result.stdout).toContain("PASS  summarizer cost");
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
