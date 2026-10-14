/**
 * The doctor line for the generated-target rule: how many captured targets
 * each signal kept out of overlap as mechanically generated and
 * non-authoritative, how many counted anyway as authoritative, how many could
 * not be classified and stayed ordinary — and the repo's own
 * `authoritativeGenerated` declaration. Driven through `runDoctor`, so the
 * line is proven WIRED and fed by the same session scan as `capture`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runDoctor } from "../src/cli/doctor.ts";
import { generatedTargetsCheck } from "../src/cli/doctor-generated.ts";
import { NO_AUTHORITATIVE_GENERATED } from "@crosscheck/connector-core/capture/authoritative-generated.ts";
import { MAX_AUTHORITATIVE_GENERATED_GLOBS } from "@crosscheck/connector-core/constants.ts";
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

describe("doctor: mechanically generated, non-authoritative targets kept out of overlap, by signal", () => {
  test("the counts of every open session here, by signal, with the authoritative and the unknowns named", async () => {
    // Act
    const line = await doctorLine(async (home, repo, hubUrl) => {
      await seedSession(home, repo, hubUrl, "gen-1", {
        generatedTargets: { path: 3, attribute: 1, header: 0, authoritative: 2, unknown: 2 },
      });
      await seedSession(home, repo, hubUrl, "gen-2", {
        // Written before the authoritative count existed: it reads as 0.
        generatedTargets: { path: 1, attribute: 0, header: 1, unknown: 0 },
      });
    });

    // Assert
    expect(line).toContain("PASS");
    expect(line).toContain("6 mechanically generated, non-authoritative targets kept out of overlap");
    expect(line).toContain("path 4 · attribute 1 · header 1");
    expect(line).toContain("2 counted anyway as authoritative (declared in authoritativeGenerated, or a schema or migration)");
    expect(line).toContain("2 could not be classified (git or the file did not answer) and count as ordinary");
    expect(line).toContain("this repo declares no authoritativeGenerated globs");
  });

  test("a state file written before the counters existed is NOT measured, never a zero", async () => {
    // Act
    const line = await doctorLine(async (home, repo, hubUrl) => {
      await seedSession(home, repo, hubUrl, "gen-old", {});
    });

    // Assert
    expect(line).toContain("not measured (1 open session here started before this count existed)");
    expect(line).not.toContain("0 mechanically generated");
  });

  test("a declaration the connector cannot fully honour is a WARN that names the first refusal and the cap", async () => {
    // Arrange: one absolute entry, and more valid globs than the cap allows.
    const many = Array.from({ length: MAX_AUTHORITATIVE_GENERATED_GLOBS + 3 }, (_unused, index) => `clients/c${String(index)}/**`);
    const line = await doctorLine(async (home, repo, hubUrl) => {
      await writeFile(
        join(repo, ".crosscheck.json"),
        `${JSON.stringify({ hubUrl, authoritativeGenerated: ["/etc/openapi.json", ...many] })}\n`,
        "utf8",
      );
      await seedSession(home, repo, hubUrl, "gen-declared", {
        generatedTargets: { path: 0, attribute: 0, header: 0, authoritative: 1, unknown: 0 },
      });
    });

    // Assert
    expect(line).toContain("WARN");
    expect(line).toContain(`authoritativeGenerated: ${String(MAX_AUTHORITATIVE_GENERATED_GLOBS)} globs honoured`);
    expect(line).toContain("1 entry refused («/etc/openapi.json»: absolute — globs are repo-relative)");
    expect(line).toContain(`3 globs past the cap of ${String(MAX_AUTHORITATIVE_GENERATED_GLOBS)} ignored`);
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
    const check = generatedTargetsCheck(health, NO_AUTHORITATIVE_GENERATED);

    // Assert
    expect(check.level).toBe("PASS");
    expect(check.detail).toContain("no open session of this repo");
  });
});
