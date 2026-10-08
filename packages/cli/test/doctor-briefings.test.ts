/**
 * `doctor`'s count of briefings this machine did not deliver whole
 * (2026-10-08): the session already said so when it happened
 * (connector-core briefing/omission.ts); this line says how often, so a slow
 * week is a number a person can act on rather than a feeling.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { BRIEFING_OMISSION_WINDOW_DAYS } from "@crosscheck/connector-core/constants.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import { recordBriefingOmission } from "@crosscheck/connector-core/state/briefing-omissions.ts";

import { runCli } from "../src/index.ts";
import { briefingOmissionsCheck } from "../src/cli/doctor-briefings.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const NEWEST = "2026-10-08T09:41:00.000Z";

describe("the briefings line", () => {
  test("no omission in the window is a PASS that says so", () => {
    // Act
    const check = briefingOmissionsCheck({ total: 0, byReason: { budget: 0, error: 0, hub: 0 }, lastAt: null });

    // Assert
    expect(check.level).toBe("PASS");
    expect(check.name).toBe("briefings");
    expect(check.detail).toBe(`none missing or incomplete in the last ${String(BRIEFING_OMISSION_WINDOW_DAYS)} days`);
  });

  test("any omission is a WARN naming each cause it saw and the newest", () => {
    // Act
    const check = briefingOmissionsCheck({ total: 3, byReason: { budget: 2, error: 0, hub: 1 }, lastAt: NEWEST });

    // Assert: only the causes that happened, and where to look next.
    expect(check.level).toBe("WARN");
    expect(check.detail).toBe(
      `3 missing or incomplete in the last ${String(BRIEFING_OMISSION_WINDOW_DAYS)} days ` +
        "(2 cut by the session-start budget, 1 with hub reads unanswered), newest 2026-10-08T09:41Z" +
        " — each session said so when it happened; the hub reachability and latency lines say why",
    );
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

describe("doctor prints the briefings line", () => {
  test("a machine that lost briefings this week WARNs with the count", async () => {
    // Arrange
    const { repo, home, env, key } = await fixture("doctor-briefings");
    await recordBriefingOmission(home, { key, reason: "budget", now: new Date() });
    await recordBriefingOmission(home, { key, reason: "error", now: new Date() });

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert
    expect(result.stdout).toContain(
      `WARN  briefings  2 missing or incomplete in the last ${String(BRIEFING_OMISSION_WINDOW_DAYS)} days (1 cut by the session-start budget, 1 connector error)`,
    );
  });

  test("a clean machine passes it", async () => {
    // Arrange
    const { repo, env } = await fixture("doctor-no-briefings");

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert
    expect(result.stdout).toContain(
      `PASS  briefings  none missing or incomplete in the last ${String(BRIEFING_OMISSION_WINDOW_DAYS)} days`,
    );
  });
});
