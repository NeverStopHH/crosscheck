/**
 * Ghost-check telemetry (VISION.md §3; the finding-#14 lesson): `crosscheck
 * status` prints the free half and the paid half of this feature side by
 * side, and `doctor` carries two checks — one for the model layer, one for
 * the hub query it is gated on.
 *
 * The line under test is really one sentence: "the deterministic notices you
 * were shown, and what the gated call did about them, INCLUDING how often it
 * was skipped". That last number is what stops a quiet team reading as a dead
 * runner, and it is the reason `noOverlap` is a counter of its own rather
 * than a fire that landed nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { DOCTOR_GHOST_SILENT_FIRES_WARN } from "@crosscheck/connector-core/constants.ts";
import {
  formatGhostCost,
  isGhostSilentlyDead,
  readGhostCost,
} from "@crosscheck/connector-claude";
import { writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { runCli } from "../src/index.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

/** Unreachable on purpose: cost lines are local facts, no hub needed. */
const HUB_URL = "http://127.0.0.1:9";
const REPO_ID = "github.com/acme/api";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const env = (home: string): Record<string, string> => ({
  CROSSCHECK_HOME: home,
  HOME: home,
  CROSSCHECK_HUB_URL: HUB_URL,
  CROSSCHECK_API_KEY: "test-key",
  CROSSCHECK_DOCTOR_NO_PROBE: "1",
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

const lineWith = (stdout: string, needle: string): string =>
  stdout.split("\n").find((entry) => entry.includes(needle)) ?? "";

const fixture = async (label: string): Promise<{ home: string; repo: string }> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  return { home, repo };
};

describe("ghost telemetry surfaces", () => {
  test("readGhostCost sums this repo's live sessions and nothing else", async () => {
    const { home, repo } = await fixture("gcost");
    await seedSession(home, repo, "gcost-a", {
      ghostNoticeCount: 2,
      ghostFireCount: 1,
      ghostDraftCount: 1,
    });
    await seedSession(home, repo, "gcost-b", { ghostNoOverlapCount: 1 });
    await seedSession(home, repo, "gcost-c", {
      ghostFireCount: 1,
      ghostFailCount: 1,
      ghostLastFailure: "dropped: secret-like text",
    });
    // Another repo on the same machine must not enter this figure.
    await seedSession(home, repo, "gcost-foreign", {
      repoId: "github.com/acme/other",
      ghostFireCount: 9,
      ghostDraftCount: 9,
    });

    const cost = await readGhostCost(home, HUB_URL, REPO_ID);
    expect(cost.sessions).toBe(3);
    expect(cost.notices).toBe(2);
    expect(cost.fires).toBe(2);
    expect(cost.noOverlap).toBe(1);
    expect(cost.drafts).toBe(1);
    expect(cost.fails).toBe(1);
    expect(cost.lastFailure).toBe("dropped: secret-like text");
  });

  test("the line names the checks it SKIPPED, and never as a failure", () => {
    const quiet = formatGhostCost({
      sessions: 1,
      notices: 0,
      fires: 0,
      noOverlap: 1,
      nones: 0,
      drafts: 0,
      fails: 0,
      lastFailure: null,
    });
    expect(quiet).toContain("1 skipped, nobody to compare");
    expect(quiet).not.toContain("failed");
    // The control: a real failure DOES say so, and quotes the booked reason.
    const broken = formatGhostCost({
      sessions: 1,
      notices: 1,
      fires: 1,
      noOverlap: 0,
      nones: 0,
      drafts: 0,
      fails: 1,
      lastFailure: "dropped: secret-like text",
    });
    expect(broken).toContain("1 failed");
    expect(broken).toContain("dropped: secret-like text");
  });

  test("silently dead means fires that answered nothing, never a quiet team", () => {
    const base = {
      sessions: 1,
      notices: 0,
      noOverlap: 0,
      nones: 0,
      drafts: 0,
      fails: 0,
      lastFailure: null,
    };
    // A team with nobody to compare against is the feature working.
    expect(
      isGhostSilentlyDead({ ...base, fires: 0, noOverlap: 5, notices: 3 }),
    ).toBe(false);
    // One booked failure is enough, whatever the count.
    expect(isGhostSilentlyDead({ ...base, fires: 1, fails: 1 })).toBe(true);
    // Below the threshold a lost run is noise; at it, doctor speaks.
    expect(
      isGhostSilentlyDead({ ...base, fires: DOCTOR_GHOST_SILENT_FIRES_WARN - 1 }),
    ).toBe(false);
    expect(
      isGhostSilentlyDead({ ...base, fires: DOCTOR_GHOST_SILENT_FIRES_WARN }),
    ).toBe(true);
    // And a fire that DID answer is not dead, however many there were.
    expect(
      isGhostSilentlyDead({
        ...base,
        fires: DOCTOR_GHOST_SILENT_FIRES_WARN,
        drafts: 1,
      }),
    ).toBe(false);
  });

  test("status prints the notices and the outcome split", async () => {
    const { home, repo } = await fixture("gstatus");
    await seedSession(home, repo, "gstatus-a", {
      ghostNoticeCount: 1,
      ghostFireCount: 1,
      ghostDraftCount: 1,
    });
    const result = await runCli(["status"], env(home), repo);
    const line = lineWith(result.stdout, "ghost checks:");
    expect(line).toContain("1 overlap notice shown");
    expect(line).toContain("1 check");
    expect(line).toContain("1 drafted");
  });

  test("doctor PASSes a quiet team and WARNs on a booked failure", async () => {
    const quiet = await fixture("gdoctor-quiet");
    await seedSession(quiet.home, quiet.repo, "gq", { ghostNoOverlapCount: 1 });
    const quietRun = await runCli(["doctor"], env(quiet.home), quiet.repo);
    const quietLine = lineWith(quietRun.stdout, "ghost checks");
    expect(quietLine).toContain("PASS");
    expect(quietLine).toContain("skipped, nobody to compare");

    const broken = await fixture("gdoctor-broken");
    await seedSession(broken.home, broken.repo, "gb", {
      ghostFireCount: 1,
      ghostFailCount: 1,
      ghostLastFailure: "dropped: the hub did not answer the overlap query",
    });
    const brokenRun = await runCli(["doctor"], env(broken.home), broken.repo);
    const brokenLine = lineWith(brokenRun.stdout, "ghost checks");
    expect(brokenLine).toContain("WARN");
    expect(brokenLine).toContain("the hub did not answer");
  });

  test("a hub that cannot answer the overlap is 'not measured', not a fault", async () => {
    const { home, repo } = await fixture("goverlap");
    await seedSession(home, repo, "go");
    const result = await runCli(["doctor"], env(home), repo);
    const line = lineWith(result.stdout, "plan overlap");
    // The check EXISTS — an older or unreachable hub is a deployment state,
    // not a fault on this machine, so it reads PASS with the honest words.
    expect(line).toContain("plan overlap");
    expect(line).toContain("PASS");
    expect(line).toContain("not measured");
  });
});
