import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runCli } from "../src/index.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const MS_PER_DAY = 86_400_000;

const startHub = (absencesBody?: unknown): {
  readonly url: string;
  readonly stop: () => void;
} => {
  const now = Date.now();
  const absences = absencesBody ?? {
    ok: true,
    data: {
      absences: [
        {
          kind: "inactive",
          name: "Robin",
          latestCommitAt: new Date(now - 2 * MS_PER_DAY).toISOString(),
          lastSessionAt: new Date(now - 9 * MS_PER_DAY).toISOString(),
          evidenceCollectedAt: new Date(now).toISOString(),
        },
        {
          kind: "unconnected",
          name: "Sam Stranger",
          latestCommitAt: new Date(now - MS_PER_DAY).toISOString(),
          lastSessionAt: null,
          evidenceCollectedAt: new Date(now).toISOString(),
        },
      ],
    },
  };
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/absences") {
        return Promise.resolve(Response.json(absences));
      }
      if (pathname === "/api/presence") {
        return Promise.resolve(
          Response.json({ ok: true, data: { sessions: [] } }),
        );
      }
      return Promise.resolve(
        Response.json({ ok: true, data: {} }),
      );
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => {
      server.stop(true);
    },
  };
};

const paths: string[] = [];
const stops: (() => void)[] = [];

afterEach(async () => {
  for (const stop of stops) {
    stop();
  }
  stops.length = 0;
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

const fixture = async (
  label: string,
  absencesBody?: unknown,
): Promise<{ readonly repo: string; readonly env: Record<string, string> }> => {
  const hub = startHub(absencesBody);
  stops.push(hub.stop);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  return {
    repo,
    env: {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: hub.url,
      CROSSCHECK_API_KEY: "test-key",
    },
  };
};

describe("crosscheck status absence lines", () => {
  test("lists both finding kinds under their own heading", async () => {
    // Arrange
    const { repo, env } = await fixture("status-absences");

    // Act
    const result = await runCli(["status"], env, repo);

    // Assert
    expect(result.stdout).toContain("commit authors without a recent session:");
    expect(result.stdout).toContain(
      "- Robin · last commit 2d ago · last reported session 9d ago",
    );
    // 24h, not "1d": formatAge switches to days at AGE_HOURS_BEFORE_DAYS (48h).
    expect(result.stdout).toContain(
      "- Sam Stranger · last commit 24h ago · no crosscheck account for this author",
    );
  });

  test("prints no absence section when the hub has no endpoint for it", async () => {
    // Arrange
    const { repo, env } = await fixture("status-degrade", { unexpected: true });

    // Act
    const result = await runCli(["status"], env, repo);

    // Assert
    expect(result.stdout).not.toContain("commit authors without a recent session");
  });
});

describe("crosscheck doctor absence check", () => {
  test("warns with counts per kind when the hub reports findings", async () => {
    // Arrange
    const { repo, env } = await fixture("doctor-absences");

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert: counts, never names — `crosscheck status` carries the lines
    expect(result.stdout).toContain("WARN  absence findings");
    expect(result.stdout).toContain("1 hub member");
    expect(result.stdout).toContain("1 without a crosscheck account");
    expect(result.stdout).toContain("crosscheck status");
    expect(result.stdout).not.toContain("Robin");
  });

  test("passes with 'none' when the hub reports no findings", async () => {
    // Arrange
    const { repo, env } = await fixture("doctor-clean", {
      ok: true,
      data: { absences: [] },
    });

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert
    expect(result.stdout).toContain("PASS  absence findings  none");
  });

  test("says 'not measured' when the endpoint is missing, not a warning", async () => {
    // Arrange: unrecognisable envelope = what an older hub's 404 body is
    const { repo, env } = await fixture("doctor-older-hub", {
      unexpected: true,
    });

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert
    expect(result.stdout).toContain("PASS  absence findings  not measured");
  });
});
