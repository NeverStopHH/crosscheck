/**
 * `doctor` and `status` count the pre-edit landed-change checks this machine
 * had cut short (2026-10-08): each session was told once, at its next prompt
 * (connector-core briefing/omission.ts `landedProbeCutsLine`); these lines
 * say how often, so a slow week is a number a person can act on.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { BRIEFING_OMISSION_WINDOW_DAYS } from "@crosscheck/connector-core/constants.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import { recordLandedProbeCut } from "@crosscheck/connector-core/state/landed-probe-cuts.ts";

import { runCli } from "../src/index.ts";
import { landedProbeCutsCheck, landedProbeCutsStatusLines } from "../src/cli/landed-probe-cuts.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const NEWEST = "2026-10-08T09:41:00.000Z";
const WINDOW = `in the last ${String(BRIEFING_OMISSION_WINDOW_DAYS)} days`;

describe("the landed-change checks line", () => {
  test("no cut in the window is a PASS that says so, and status prints nothing", () => {
    // Arrange
    const none = { total: 0, byReason: { deadline: 0, unanswered: 0, budget: 0 }, lastAt: null };

    // Act
    const check = landedProbeCutsCheck(none);

    // Assert
    expect(check.level).toBe("PASS");
    expect(check.name).toBe("landed-change checks");
    expect(check.detail).toBe(`none cut short ${WINDOW}`);
    expect(landedProbeCutsStatusLines(none)).toEqual([]);
  });

  test("any cut is a WARN naming each reason it saw and the newest, and status prints the same count", () => {
    // Arrange
    const some = { total: 4, byReason: { deadline: 2, unanswered: 1, budget: 1 }, lastAt: NEWEST };
    const counted =
      `4 cut short ${WINDOW} (2 ended by the check's deadline, 1 with a landing branch git did not answer for, ` +
      "1 ended with the edit hook's budget), newest 2026-10-08T09:41Z";

    // Act
    const check = landedProbeCutsCheck(some);

    // Assert
    expect(check.level).toBe("WARN");
    expect(check.detail.startsWith(counted)).toBe(true);
    expect(landedProbeCutsStatusLines(some)).toEqual([`landed-change checks: ${counted}`]);
  });
});

const stops: (() => void)[] = [];
const paths: string[] = [];

afterEach(async () => {
  for (const stop of stops) {
    stop();
  }
  stops.length = 0;
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

/** A hub that answers every read with an empty ok envelope, bound where its URL points. */
const startQuietHub = (): string => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json({ ok: true, data: {} }),
  });
  stops.push(() => {
    server.stop(true);
  });
  return `http://127.0.0.1:${String(server.port)}`;
};

const fixture = async (
  label: string,
): Promise<{ readonly repo: string; readonly home: string; readonly env: Record<string, string>; readonly key: string }> => {
  const hubUrl = startQuietHub();
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  return {
    repo,
    home,
    key: repoKey(hubUrl, REPO_ID),
    env: { CROSSCHECK_HOME: home, HOME: home, CROSSCHECK_HUB_URL: hubUrl, CROSSCHECK_API_KEY: "test-key" },
  };
};

describe("doctor and status print the count", () => {
  test("a machine with cut checks this week WARNs in doctor and counts in status", async () => {
    // Arrange
    const { repo, home, env, key } = await fixture("cuts-counted");
    await recordLandedProbeCut(home, { key, reason: "deadline", now: new Date() });
    await recordLandedProbeCut(home, { key, reason: "deadline", now: new Date() });

    // Act
    const doctor = await runCli(["doctor"], env, repo);
    const status = await runCli(["status"], env, repo);

    // Assert
    expect(doctor.stdout).toContain(
      `WARN  landed-change checks  2 cut short ${WINDOW} (2 ended by the check's deadline)`,
    );
    expect(status.stdout).toContain(`landed-change checks: 2 cut short ${WINDOW} (2 ended by the check's deadline)`);
  });

  test("a clean machine passes doctor and prints no status line", async () => {
    // Arrange
    const { repo, env } = await fixture("cuts-none");

    // Act
    const doctor = await runCli(["doctor"], env, repo);
    const status = await runCli(["status"], env, repo);

    // Assert
    expect(doctor.stdout).toContain(`PASS  landed-change checks  none cut short ${WINDOW}`);
    expect(status.stdout).not.toContain("landed-change checks");
  });
});
