/**
 * Derived-intent telemetry surfaces (trial finding #16; the finding-#14
 * lesson): `crosscheck status` prints the fires and their outcome split,
 * `doctor` carries an `intent capture` check that WARNs on any booked
 * failure and on two silent fires — never a PASS-only counter.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { DOCTOR_INTENT_SILENT_FIRES_WARN } from "@crosscheck/connector-core/constants.ts";
import { runCli } from "../src/index.ts";
import { formatIntentCost, isIntentSilentlyDead, readIntentCost } from "@crosscheck/connector-claude";
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

const doctorLine = (stdout: string): string =>
  stdout.split("\n").find((entry) => entry.includes("intent capture")) ?? "";

describe("intent telemetry surfaces", () => {
  test("readIntentCost sums this repo's live sessions and nothing else", async () => {
    const repo = await makeRepo("icost", { remote: "git@github.com:acme/api.git" });
    const home = await makeHome("icost");
    paths.push(repo, home);
    await seedSession(home, repo, "icost-a", { intentFireCount: 1, intentSetCount: 1 });
    await seedSession(home, repo, "icost-b", { intentFireCount: 1, intentNoneCount: 1 });
    await seedSession(home, repo, "icost-c", {
      intentFireCount: 1,
      intentFailCount: 1,
      intentLastFailure: "dropped: secret-like text",
    });
    await seedSession(home, repo, "icost-foreign", {
      repoId: "github.com/acme/other",
      intentFireCount: 9,
      intentSetCount: 9,
    });

    const cost = await readIntentCost(home, HUB_URL, REPO_ID);

    expect(cost.sessions).toBe(3);
    expect(cost.fires).toBe(3);
    expect(cost.nones).toBe(1);
    expect(cost.sets).toBe(1);
    expect(cost.fails).toBe(1);
    expect(cost.lastFailure).toBe("dropped: secret-like text");
  });

  test("formatIntentCost is the one spelling; no live sessions reads as exactly that", () => {
    expect(
      formatIntentCost({ sessions: 2, fires: 2, nones: 1, sets: 1, fails: 0, lastFailure: null }),
    ).toBe("2 fires (1 NONE, 1 set) across 2 live sessions");
    expect(
      formatIntentCost({
        sessions: 1,
        fires: 1,
        nones: 0,
        sets: 0,
        fails: 1,
        lastFailure: "timed out after 60 s",
      }),
    ).toBe('1 fire (0 NONE, 0 set, 1 failed: last "timed out after 60 s") across 1 live session');
    expect(
      formatIntentCost({ sessions: 0, fires: 0, nones: 0, sets: 0, fails: 0, lastFailure: null }),
    ).toBe("no live sessions");
  });

  test("status prints the intent line beside the summarizer line", async () => {
    const repo = await makeRepo("icost-status", { remote: "git@github.com:acme/api.git" });
    const home = await makeHome("icost-status");
    paths.push(repo, home);
    await seedSession(home, repo, "icost-status-a", { intentFireCount: 1, intentSetCount: 1 });

    const result = await runCli(["status"], env(home), repo);

    expect(result.stdout).toContain("summarizer:");
    expect(result.stdout).toContain("intent: 1 fire (0 NONE, 1 set) across 1 live session");
  });

  test("doctor PASSes an intent capture that answered (a set or a NONE)", async () => {
    const repo = await makeRepo("icost-doctor", { remote: "git@github.com:acme/api.git" });
    const home = await makeHome("icost-doctor");
    paths.push(repo, home);
    await seedSession(home, repo, "icost-doctor-a", { intentFireCount: 1, intentSetCount: 1 });
    await seedSession(home, repo, "icost-doctor-b", { intentFireCount: 1, intentNoneCount: 1 });

    const result = await runCli(["doctor"], env(home), repo);

    expect(doctorLine(result.stdout)).toContain("PASS  intent capture");
    expect(doctorLine(result.stdout)).toContain("2 fires (1 NONE, 1 set)");
  });

  test("doctor WARNs on ANY booked failure, naming the reason", async () => {
    const repo = await makeRepo("icost-fail", { remote: "git@github.com:acme/api.git" });
    const home = await makeHome("icost-fail");
    paths.push(repo, home);
    await seedSession(home, repo, "icost-fail-a", {
      intentFireCount: 1,
      intentFailCount: 1,
      intentLastFailure: "exit 1: Not logged in Please run /login",
    });

    const result = await runCli(["doctor"], env(home), repo);

    const line = doctorLine(result.stdout);
    expect(line).toContain("WARN  intent capture");
    expect(line).toContain('1 failed: last "exit 1: Not logged in Please run /login"');
    expect(line).toContain("see the summarizer runner check");
  });

  test(`doctor WARNs once ${String(DOCTOR_INTENT_SILENT_FIRES_WARN)} fires landed neither a NONE nor an intent`, async () => {
    const repo = await makeRepo("icost-silent", { remote: "git@github.com:acme/api.git" });
    const home = await makeHome("icost-silent");
    paths.push(repo, home);
    await seedSession(home, repo, "icost-silent-a", { intentFireCount: 1 });
    await seedSession(home, repo, "icost-silent-b", { intentFireCount: 1 });

    const result = await runCli(["doctor"], env(home), repo);

    expect(doctorLine(result.stdout)).toContain("WARN  intent capture");
    expect(doctorLine(result.stdout)).toContain("2 fires (0 NONE, 0 set)");
  });

  // Boundary pin, green on main by design: the WARN does not over-reach.
  test("boundary pin: one silent fire is noise, not news; at the threshold one answer is enough", async () => {
    expect(
      isIntentSilentlyDead({ sessions: 1, fires: 1, nones: 0, sets: 0, fails: 0, lastFailure: null }),
    ).toBe(false);
    expect(
      isIntentSilentlyDead({ sessions: 2, fires: 2, nones: 1, sets: 0, fails: 0, lastFailure: null }),
    ).toBe(false);
    expect(
      isIntentSilentlyDead({ sessions: 2, fires: 2, nones: 0, sets: 0, fails: 0, lastFailure: null }),
    ).toBe(true);
    expect(
      isIntentSilentlyDead({ sessions: 1, fires: 1, nones: 0, sets: 0, fails: 1, lastFailure: "x" }),
    ).toBe(true);
  });
});
