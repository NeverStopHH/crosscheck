/**
 * `crosscheck status` names the repo's claim count on its hints line (M1).
 *
 * `hint_deliveries` was write-only from the outside — `markHintsPulled` was
 * its only reader and no endpoint exposed the ledger — so "are hints reaching
 * anybody on this repo" had no answer on any surface. The line prints the
 * claim count because `delivered: 0` alone is ambiguous: with claims on the
 * repo it is a ranking problem, and with none it is the structural fact that
 * the selector has nothing to point at.
 *
 * WHICH IMPLEMENTATION THIS GUARDS, after the M1 and #17/#18/#20 rounds were
 * merged: `hintsLine` in cli/status.ts, the #20 line, with M1's claim count
 * ported onto it. Two consequences for the expectations below.
 *
 *   - The line's LOCAL half (delivered from this machine's session states,
 *     candidates seen) is printed whether or not the hub answers, so the old
 *     "an older hub prints no line at all" expectation is now "an older hub
 *     prints the local numbers and no claim count" — a hub that cannot answer
 *     costs the hub half of the line, never the local half.
 *   - `delivered` on the line is the LOCAL seen-set count, not the hub's; the
 *     hub's own delivered/pulled ride inside the window clause.
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

/**
 * The hub's stats body, or null for a hub that predates the route. `claims` is
 * optional because a 0.7.3 hub answers the window WITHOUT it, and telling that
 * apart from `claims: 0` is one of the things this file pins.
 */
interface Stats {
  readonly delivered: number;
  readonly pulled: number;
  readonly claims?: number;
  readonly windowDays: number;
}

const hubWithStats = (stats: Stats | null): string => {
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
  stats: Stats | null,
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

const hintsLineOf = (stdout: string): string =>
  stdout.split("\n").find((line) => line.startsWith("hints:")) ?? "";

describe("crosscheck status hints line", () => {
  test("prints the hub's delivered and pulled and the repo's claim count", async () => {
    // Arrange: three hints shown, one followed, and nothing to point at
    const { repo, env } = await fixture({
      delivered: 3,
      pulled: 1,
      claims: 0,
      windowDays: 7,
    });

    // Act
    const result = await runStatus(env, repo);

    // Assert
    const line = hintsLineOf(result.stdout);
    expect(line).toContain("hub 7d: 3 delivered, 1 pulled");
    expect(line).toContain("claims on this repo 0");
  });

  test("a healthy repo prints its claim count too", async () => {
    // Arrange
    const { repo, env } = await fixture({
      delivered: 9,
      pulled: 4,
      claims: 21,
      windowDays: 7,
    });

    // Act
    const result = await runStatus(env, repo);

    // Assert
    const line = hintsLineOf(result.stdout);
    expect(line).toContain("hub 7d: 9 delivered, 4 pulled");
    expect(line).toContain("claims on this repo 21");
  });

  test("an older hub without the endpoint states no claim count rather than 0", async () => {
    // Arrange
    const { repo, env } = await fixture(null);

    // Act
    const result = await runStatus(env, repo);

    // Assert: a fabricated "0 claims" is the false structural verdict the
    // number exists to prevent, so the clause is absent — while the LOCAL
    // half of the line still prints, which is the #20 fail-open.
    const line = hintsLineOf(result.stdout);
    expect(line).toContain("hints: delivered 0");
    expect(line).toContain("not measured");
    expect(line).not.toContain("claims on this repo");
  });

  test("a hub that answers the window without a claim count states none", async () => {
    // Arrange: the released 0.7.3 shape — delivered/pulled/windowDays, no
    // `claims` field at all. Absent must not read as zero.
    const { repo, env } = await fixture({
      delivered: 2,
      pulled: 1,
      windowDays: 7,
    });

    // Act
    const result = await runStatus(env, repo);

    // Assert
    const line = hintsLineOf(result.stdout);
    expect(line).toContain("hub 7d: 2 delivered, 1 pulled");
    expect(line).not.toContain("claims on this repo");
  });
});
