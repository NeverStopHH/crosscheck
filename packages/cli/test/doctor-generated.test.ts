/**
 * The doctor line for the generated-target rule: how many captured targets
 * each signal labelled generated — kept out of overlap — and how many could
 * not be classified and stayed ordinary. Driven through `runDoctor`, so the
 * line is proven WIRED and fed by the same session scan as `capture`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runDoctor } from "../src/cli/doctor.ts";
import { generatedTargetsCheck } from "../src/cli/doctor-generated.ts";
import { writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import type { CaptureHealth } from "@crosscheck/connector-core/state/capture-health.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";
import { serveLoopback } from "../../connector-core/test/fixtures/loopback-serve.ts";

const REPO_ID = "github.com/acme/api";

const paths: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  for (const server of servers) {
    server.stop(true);
  }
  servers.length = 0;
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

/** A hub that answers every route with an empty success. */
const quietHub = (): string => {
  const server = serveLoopback({
    port: 0,
    fetch: () => Response.json({ ok: true, data: { sessions: [], workContexts: [] } }),
  });
  servers.push(server);
  return `http://127.0.0.1:${String(server.port)}`;
};

const seedSession = async (
  home: string,
  repo: string,
  hubUrl: string,
  hostSessionKey: string,
  overrides: Record<string, unknown>,
): Promise<void> => {
  const nowIso = new Date().toISOString();
  await writeSessionState(home, {
    hostSessionKey,
    crosscheckSessionId: `cc_${hostSessionKey}`,
    workContextId: `wc_cc_${hostSessionKey}`,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl,
    developerId: "dev_self",
    startedAt: nowIso,
    lastHeartbeatAt: nowIso,
    ...overrides,
  });
};

const doctorLine = async (seed: (home: string, repo: string, hubUrl: string) => Promise<void>): Promise<string> => {
  const repo = await makeRepo("doctor-generated", { remote: "git@github.com:acme/api.git" });
  const home = await makeHome("doctor-generated");
  paths.push(repo, home);
  const hubUrl = quietHub();
  await seed(home, repo, hubUrl);
  const result = await runDoctor(
    { CROSSCHECK_HOME: home, HOME: home, CROSSCHECK_HUB_URL: hubUrl, CROSSCHECK_API_KEY: "test-key" },
    repo,
    async () => null,
  );
  return result.stdout.split("\n").find((line) => line.includes("generated targets")) ?? "";
};

describe("doctor: generated targets kept out of overlap, by signal", () => {
  test("the counts of every open session here, by signal, with the unknowns named", async () => {
    // Act
    const line = await doctorLine(async (home, repo, hubUrl) => {
      await seedSession(home, repo, hubUrl, "gen-1", {
        generatedTargets: { path: 3, attribute: 1, header: 0, unknown: 2 },
      });
      await seedSession(home, repo, hubUrl, "gen-2", {
        generatedTargets: { path: 1, attribute: 0, header: 1, unknown: 0 },
      });
    });

    // Assert
    expect(line).toContain("PASS");
    expect(line).toContain("6 targets labelled generated and kept out of overlap");
    expect(line).toContain("path 4 · attribute 1 · header 1");
    expect(line).toContain("2 could not be classified (git or the file did not answer) and count as ordinary");
  });

  test("a state file written before the counters existed is NOT measured, never a zero", async () => {
    // Act
    const line = await doctorLine(async (home, repo, hubUrl) => {
      await seedSession(home, repo, hubUrl, "gen-old", {});
    });

    // Assert
    expect(line).toContain("not measured (1 open session here started before this count existed)");
    expect(line).not.toContain("0 targets labelled generated");
  });

  test("no open session of this repo says so", () => {
    // Arrange
    const health: CaptureHealth = {
      sessions: [],
      idleSessions: 0,
      statesTotal: 0,
      statesRead: 0,
      statesCap: 200,
      statesUnparsed: 0,
      fires: 0,
      targets: 0,
      outsideDrops: 0,
      lastTargetAt: null,
      hintsDelivered: 0,
      hintCandidatesSeen: 0,
      flooredPrompts: 0,
      harnessTurns: 0,
      quietCalls: 0,
    };

    // Act
    const check = generatedTargetsCheck(health);

    // Assert
    expect(check.level).toBe("PASS");
    expect(check.detail).toContain("no open session of this repo");
  });
});
