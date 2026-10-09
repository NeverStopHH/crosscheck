/**
 * `doctor` and `status` count the moments a collision's person may not have
 * been told (batch-2 review, L2 and H2): a rest whose recheck never ran
 * (`rest_unchecked`) and a tripwire answer the budget cut before its output
 * left (`tripwire_cut`). The ledger was written and read by nothing, so a cut
 * collision warning showed in doctor only as a landed-check cut.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { BRIEFING_OMISSION_WINDOW_DAYS } from "@crosscheck/connector-core/constants.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import { recordRestOmission } from "@crosscheck/connector-core/state/rest-omissions.ts";

import { runCli } from "../src/index.ts";
import { collisionOmissionsCheck, collisionOmissionsStatusLines } from "../src/cli/collision-omissions.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const NEWEST = "2026-10-09T07:12:00.000Z";
const WINDOW = `in the last ${String(BRIEFING_OMISSION_WINDOW_DAYS)} days`;

describe("the collision warnings line", () => {
  test("no omission in the window is a PASS that says so, and status prints nothing", () => {
    // Arrange
    const none = { total: 0, byReason: { rest_unchecked: 0, tripwire_cut: 0 }, lastAt: null };

    // Act
    const check = collisionOmissionsCheck(none);

    // Assert
    expect(check.level).toBe("PASS");
    expect(check.name).toBe("collision warnings");
    expect(check.detail).toBe(`none missed ${WINDOW}`);
    expect(collisionOmissionsStatusLines(none)).toEqual([]);
  });

  test("any omission is a WARN naming each reason and the newest, and status prints the same count", () => {
    // Arrange
    const some = { total: 3, byReason: { rest_unchecked: 1, tripwire_cut: 2 }, lastAt: NEWEST };
    const counted =
      `3 possibly not shown ${WINDOW} (2 cut by the edit hook's budget before the line left, ` +
      "1 rest never rechecked), newest 2026-10-09T07:12Z";

    // Act
    const check = collisionOmissionsCheck(some);

    // Assert
    expect(check.level).toBe("WARN");
    expect(check.detail.startsWith(counted)).toBe(true);
    expect(collisionOmissionsStatusLines(some)).toEqual([`collision warnings: ${counted}`]);
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

describe("doctor and status print the count", () => {
  test("a machine with a cut tripwire this week WARNs in doctor and counts in status", async () => {
    // Arrange
    const hubUrl = startQuietHub();
    const repo = await makeRepo("co-counted", { remote: "git@github.com:acme/api.git" });
    const home = await makeHome("co-counted");
    paths.push(repo, home);
    const env = { CROSSCHECK_HOME: home, HOME: home, CROSSCHECK_HUB_URL: hubUrl, CROSSCHECK_API_KEY: "test-key" };
    await recordRestOmission(home, { key: repoKey(hubUrl, REPO_ID), reason: "tripwire_cut", now: new Date() });

    // Act
    const doctor = await runCli(["doctor"], env, repo);
    const status = await runCli(["status"], env, repo);

    // Assert
    const counted = `1 possibly not shown ${WINDOW} (1 cut by the edit hook's budget before the line left)`;
    expect(doctor.stdout).toContain(`WARN  collision warnings  ${counted}`);
    expect(status.stdout).toContain(`collision warnings: ${counted}`);
  });
});
