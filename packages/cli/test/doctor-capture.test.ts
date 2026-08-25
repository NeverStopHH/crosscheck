/**
 * Capture and hint health get a number (trial finding M1).
 *
 * `status` printed the spool depth and the cross-repo drop count; nothing
 * anywhere printed how many TARGETS a session had captured. So the
 * cross-worktree drop — a session whose every edit landed outside the repo it
 * registered from, capturing nothing at all — produced `spool: 0 pending, 0
 * dropped`, 24 PASS lines, and not one sentence about the thing that had
 * stopped working. Hints had the same hole from the other side:
 * `hint_deliveries` was write-only, so "are hints reaching anybody" had no
 * answer on any surface.
 *
 * The counters the capture line reads are written by the sibling capture
 * branch. Both halves of that are pinned here: the number when they exist,
 * and the honest "not measured" when they do not.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { captureCheck, hintsCheck, runDoctor } from "../src/cli/doctor.ts";
import { writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";

const paths: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  for (const server of servers) {
    server.stop(true);
  }
  servers.length = 0;
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

/** A hub that answers presence and serves the given hint stats. */
const hubWithStats = (
  stats: { delivered: number; pulled: number; claims: number } | null,
): string => {
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      if (new URL(request.url).pathname === "/api/hints/stats") {
        return stats === null
          ? Response.json(
              { ok: false, error: { code: "not_found", message: "unknown route" } },
              { status: 404 },
            )
          : Response.json({ ok: true, data: stats });
      }
      return Response.json({ ok: true, data: { sessions: [] } });
    },
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

const doctorEnv = (home: string, hubUrl: string) => ({
  CROSSCHECK_HOME: home,
  HOME: home,
  CROSSCHECK_HUB_URL: hubUrl,
  CROSSCHECK_API_KEY: "test-key",
});

describe("captureCheck", () => {
  test("fires with no targets is the cross-worktree drop, and it WARNs", () => {
    // Arrange + Act
    const result = captureCheck({
      measured: true,
      fires: 7,
      targets: 0,
      sessions: 1,
    });

    // Assert
    expect(result.level).toBe("WARN");
    expect(result.detail).toContain("7 edit-tool fires -> 0 targets");
    expect(result.detail).toContain("worktree");
  });

  test("fires with targets passes with both numbers", () => {
    // Arrange + Act
    const result = captureCheck({
      measured: true,
      fires: 7,
      targets: 4,
      sessions: 2,
    });

    // Assert
    expect(result.level).toBe("PASS");
    expect(result.detail).toContain("7 edit-tool fires -> 4 targets");
  });

  test("no counter anywhere says so instead of printing a fabricated zero", () => {
    // Arrange + Act
    const result = captureCheck({
      measured: false,
      fires: 0,
      targets: 0,
      sessions: 1,
    });

    // Assert
    expect(result.level).toBe("PASS");
    expect(result.detail).toContain("not measured");
  });
});

describe("hintsCheck", () => {
  test("zero claims beside a live session names the structural fact and WARNs", () => {
    // Arrange + Act
    const result = hintsCheck(
      { ok: true, stats: { delivered: 0, pulled: 0, claims: 0 } },
      true,
    );

    // Assert
    expect(result.level).toBe("WARN");
    expect(result.detail).toContain("hints cannot fire");
    expect(result.detail).toContain("0 claims");
  });

  test("zero claims on a machine with no session is a fresh team, not a defect", () => {
    // Arrange + Act
    const result = hintsCheck(
      { ok: true, stats: { delivered: 0, pulled: 0, claims: 0 } },
      false,
    );

    // Assert: a warning that greets every new install is one nobody reads
    expect(result.level).toBe("PASS");
    expect(result.detail).toContain("0 claims on this repo");
  });

  test("an older hub without the endpoint is a PASS, never a WARN", () => {
    // Arrange + Act
    const result = hintsCheck({ ok: false, reason: "absent" }, true);

    // Assert
    expect(result.level).toBe("PASS");
    expect(result.detail).toContain("not available on this hub");
  });

  test("a rejected key says not measured, never 'not available on this hub'", () => {
    // Arrange + Act: the whole point of M3 was a PASS that claimed something
    // false under `FAIL hub reachable invalid api key`. A 401 means the
    // endpoint was never asked, not that the hub lacks it.
    const result = hintsCheck({ ok: false, reason: "unmeasured" }, true);

    // Assert
    expect(result.level).toBe("PASS");
    expect(result.detail).toBe("not measured");
    expect(result.detail).not.toContain("not available on this hub");
  });

  test("a healthy repo prints delivered, pulled and claims", () => {
    // Arrange + Act
    const result = hintsCheck(
      { ok: true, stats: { delivered: 5, pulled: 2, claims: 11 } },
      true,
    );

    // Assert
    expect(result.level).toBe("PASS");
    expect(result.detail).toContain("5 delivered (2 pulled), 11 claims");
  });
});

describe("runDoctor carries both lines", () => {
  test("seven fires and no targets WARN, beside a 0-claim hub", async () => {
    // Arrange
    const repo = await makeRepo("doctor-capture", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("doctor-capture");
    paths.push(repo, home);
    const hubUrl = hubWithStats({ delivered: 0, pulled: 0, claims: 0 });
    await seedSession(home, repo, hubUrl, "cap-a", {
      seenTargets: [],
      editToolFires: 7,
    });

    // Act
    const result = await runDoctor(
      doctorEnv(home, hubUrl),
      repo,
      async () => null,
    );

    // Assert
    expect(result.stdout).toContain("WARN  capture  7 edit-tool fires -> 0 targets");
    expect(result.stdout).toContain("WARN  hints  0 delivered (0 pulled), 0 claims");
    expect(result.stdout).toContain("hints cannot fire");
  });

  test("an old hub degrades to 'not available', and no counters to 'not measured'", async () => {
    // Arrange
    const repo = await makeRepo("doctor-capture-old", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("doctor-capture-old");
    paths.push(repo, home);
    const hubUrl = hubWithStats(null);
    await seedSession(home, repo, hubUrl, "cap-b", { seenTargets: [] });

    // Act
    const result = await runDoctor(
      doctorEnv(home, hubUrl),
      repo,
      async () => null,
    );

    // Assert: an old hub is not a defect of this install (§R6)
    expect(result.stdout).toContain("PASS  hints  not available on this hub");
    expect(result.stdout).toContain("PASS  capture  not measured");
  });
});
