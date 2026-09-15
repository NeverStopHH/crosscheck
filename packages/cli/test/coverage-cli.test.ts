/**
 * AT-9 on the two surfaces a person actually reads: `crosscheck status` and
 * `crosscheck doctor`.
 *
 * "Fails if a person has to run doctor to learn that an answer was based on
 * partial observation" — so `status` carries the qualifier too, and it
 * carries it unconditionally: a human asked, and "we do not know how far we
 * saw" is the answer they need most.
 *
 * COV-5's printed refusals live here as well. A rung that cannot exist is
 * only honest if somebody can read the refusal; one nobody sees is the silent
 * absence AT-10 forbids.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runCli } from "../src/index.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const GAP_ISO = "2026-09-05T08:13:00.000Z";
const GAP_SHOWN = "2026-09-05T08:13Z";

const coverageBlock = (
  agentState: string,
  agentReason: string,
): Record<string, unknown> => ({
  repo: "github.com/acme/api",
  computedAt: new Date().toISOString(),
  scope: { sinceIso: GAP_ISO },
  sources: [
    {
      source: "agent_event",
      state: agentState,
      reason: agentReason,
      gapSince: agentState === "incomplete" ? GAP_ISO : null,
      observedAt: GAP_ISO,
    },
    {
      source: "git",
      state: "complete",
      reason: "commits_reported",
      gapSince: null,
      observedAt: GAP_ISO,
    },
    { source: "ci", state: "unavailable", reason: "no_emitter", gapSince: null, observedAt: null },
    { source: "runtime", state: "unavailable", reason: "out_of_scope_1_0", gapSince: null, observedAt: null },
    { source: "human_edit", state: "unavailable", reason: "no_platform_rung", gapSince: null, observedAt: null },
  ],
});

const startHub = (
  body: unknown,
): { readonly url: string; readonly stop: () => void } => {
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/absences") {
        return Promise.resolve(Response.json(body));
      }
      if (pathname === "/api/presence") {
        return Promise.resolve(
          Response.json({ ok: true, data: { sessions: [] } }),
        );
      }
      return Promise.resolve(Response.json({ ok: true, data: {} }));
    },
  });
  return {
    url: `http://127.0.0.1:${String(server.port)}`,
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
  body: unknown,
  options: { readonly unreachable?: boolean } = {},
): Promise<{ readonly repo: string; readonly env: Record<string, string> }> => {
  const hub = startHub(body);
  stops.push(hub.stop);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  const url = options.unreachable === true ? "http://127.0.0.1:1" : hub.url;
  return {
    repo,
    env: {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: url,
      CROSSCHECK_API_KEY: "test-key",
    },
  };
};

const reported = { ok: true, data: { absences: [], coverage: coverageBlock("incomplete", "session_reaped") } };
const watched = { ok: true, data: { absences: [], coverage: coverageBlock("complete", "sessions_reported") } };
const oldHub = { ok: true, data: { absences: [] } };

describe("crosscheck status carries the qualifier — AT-9", () => {
  test("a reaped rung prints the instant observation stopped", async () => {
    // Arrange
    const { repo, env } = await fixture("status-coverage", reported);

    // Act
    const result = await runCli(["status"], env, repo);

    // Assert
    expect(result.stdout).toContain("coverage: Coverage incomplete");
    expect(result.stdout).toContain(GAP_SHOWN);
  });

  test("an un-upgraded hub still says so rather than saying nothing", async () => {
    // Arrange
    const { repo, env } = await fixture("status-old-hub", oldHub);

    // Act
    const result = await runCli(["status"], env, repo);

    // Assert: a person asked. "We cannot tell" is the answer they need most,
    // and an omitted line would read as "all clear".
    expect(result.stdout).toContain("coverage: Coverage unknown");
  });

  test("no percentage reaches the line", async () => {
    // Arrange
    const { repo, env } = await fixture("status-no-percent", reported);

    // Act
    const result = await runCli(["status"], env, repo);
    const line = result.stdout
      .split("\n")
      .find((entry) => entry.startsWith("coverage: "));

    // Assert
    expect(line).toBeDefined();
    expect(line?.includes("%")).toBe(false);
  });
});

describe("crosscheck doctor: the coverage check and COV-5's refusals", () => {
  test("warns and names the gap when a readable rung is incomplete", async () => {
    // Arrange
    const { repo, env } = await fixture("doctor-coverage-warn", reported);

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert
    expect(result.stdout).toContain("WARN  coverage");
    expect(result.stdout).toContain(GAP_SHOWN);
    expect(result.stdout).toContain("agent_event incomplete");
  });

  test("passes and still names every readable rung when nothing is missing", async () => {
    // Arrange
    const { repo, env } = await fixture("doctor-coverage-pass", watched);

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert
    expect(result.stdout).toContain("PASS  coverage");
    expect(result.stdout).toContain("agent_event complete");
    expect(result.stdout).toContain("git complete");
  });

  test.each([
    ["ci", "no_emitter"],
    ["runtime", "out_of_scope_1_0"],
    ["human_edit", "no_platform_rung"],
  ] as const)("prints the %s refusal by name", async (source, reason) => {
    // Arrange
    const { repo, env } = await fixture(`doctor-refuse-${source}`, reported);

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert
    expect(result.stdout).toContain(`PASS  coverage ${source}`);
    expect(result.stdout).toContain(reason);
  });

  test("prints the commit-range refusal, with or without a hub", async () => {
    // Arrange
    const { repo, env } = await fixture("doctor-range-refusal", oldHub);

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert: §3.4. AT-1's example sentence names commits; 1.0 cannot, and
    // the refusal is printed rather than left as an absence somebody plans on.
    expect(result.stdout).toContain("PASS  coverage range");
    expect(result.stdout).toContain("commit_evidence");
  });

  test("a hub too old to answer is 'not measured' and a PASS", async () => {
    // Arrange
    const { repo, env } = await fixture("doctor-coverage-old", oldHub);

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert: an older hub says nothing about THIS install's health, and a
    // warning nobody can act on teaches people to ignore doctor.
    expect(result.stdout).toContain("PASS  coverage  not measured");
  });

  test("a hub that could not be REACHED is a WARN, not a green", async () => {
    // Arrange
    const { repo, env } = await fixture("doctor-coverage-unreachable", oldHub, {
      unreachable: true,
    });

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert: #50's ladder — coverage unknown is not coverage fine, and a
    // green meaning "could not check" is worse than no check at all.
    expect(result.stdout).toContain("WARN  coverage");
    expect(result.stdout).toContain("could not reach");
  });
});
