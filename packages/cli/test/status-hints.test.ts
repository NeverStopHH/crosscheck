/**
 * `crosscheck status` gets a hints line (trial finding M1).
 *
 * `hint_deliveries` was write-only from the outside — `markHintsPulled` was
 * its only reader and no endpoint exposed the ledger — so "are hints reaching
 * anybody on this repo" had no answer on any surface. The line prints all
 * three numbers because `delivered: 0` alone is ambiguous: with claims on the
 * repo it is a ranking problem, and with none it is the structural fact that
 * the selector has nothing to point at.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runStatus } from "../src/cli/status.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

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

const hubWithStats = (
  stats: { delivered: number; pulled: number; claims: number } | null,
): string => {
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/hints/stats") {
        return stats === null
          ? Response.json(
              { ok: false, error: { code: "not_found", message: "unknown route" } },
              { status: 404 },
            )
          : Response.json({ ok: true, data: stats });
      }
      if (pathname === "/api/settings") {
        return Response.json({
          ok: true,
          data: { presenceOptOut: false, mutes: [], emails: [] },
        });
      }
      return Response.json({ ok: true, data: { sessions: [], absences: [] } });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${String(server.port)}`;
};

const fixture = async (
  stats: { delivered: number; pulled: number; claims: number } | null,
): Promise<{ readonly repo: string; readonly env: Record<string, string> }> => {
  const repo = await makeRepo("status-hints", {
    remote: "git@github.com:acme/api.git",
  });
  const home = await makeHome("status-hints");
  paths.push(repo, home);
  const hubUrl = hubWithStats(stats);
  return {
    repo,
    env: {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: "test-key",
    },
  };
};

describe("crosscheck status hints line", () => {
  test("prints delivered, pulled and the repo's claim count", async () => {
    // Arrange: three hints shown, one followed, and nothing to point at
    const { repo, env } = await fixture({ delivered: 3, pulled: 1, claims: 0 });

    // Act
    const result = await runStatus(env, repo);

    // Assert
    expect(result.stdout).toContain(
      "hints: delivered 3 (pulled 1) · claims on this repo 0",
    );
  });

  test("a healthy repo prints its claim count too", async () => {
    // Arrange
    const { repo, env } = await fixture({ delivered: 9, pulled: 4, claims: 21 });

    // Act
    const result = await runStatus(env, repo);

    // Assert
    expect(result.stdout).toContain(
      "hints: delivered 9 (pulled 4) · claims on this repo 21",
    );
  });

  test("an older hub without the endpoint prints no line at all", async () => {
    // Arrange
    const { repo, env } = await fixture(null);

    // Act
    const result = await runStatus(env, repo);

    // Assert: the same fail-open the absence and privacy sections use
    expect(result.stdout).not.toContain("hints:");
  });
});
