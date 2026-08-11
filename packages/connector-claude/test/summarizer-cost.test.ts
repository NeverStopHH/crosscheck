/**
 * Cost visibility (DESIGN.md §10 risk 7): the summarizer spends the
 * developer's OWN Claude quota, so `crosscheck status` and `doctor` surface
 * the per-session invocation count and a rough token estimate — marked as
 * an estimate wherever it is printed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runCli } from "../src/index.ts";
import { readSummarizerCost } from "../src/summarizer/cost.ts";
import { writeSessionState } from "../src/state/session-state.ts";
import { makeHome, makeRepo } from "./helpers.ts";

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
  claudeSessionId: string,
  overrides: Record<string, unknown> = {},
): Promise<void> => {
  await writeSessionState(home, {
    claudeSessionId,
    crosscheckSessionId: `cc_${claudeSessionId}`,
    workContextId: `wc_cc_${claudeSessionId}`,
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
    });
    await seedSession(home, repo, "cost-b", {
      summarizerFireCount: 1,
      summarizerEstimatedTokens: 400,
    });
    await seedSession(home, repo, "cost-foreign", {
      repoId: "github.com/acme/other",
      summarizerFireCount: 9,
      summarizerEstimatedTokens: 9000,
    });

    // Act
    const cost = await readSummarizerCost(home, HUB_URL, REPO_ID);

    // Assert
    expect(cost.sessions).toBe(2);
    expect(cost.fires).toBe(3);
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
    });

    const result = await runCli(["status"], env(home), repo);

    expect(result.stdout).toContain("summarizer: 3 runs");
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
