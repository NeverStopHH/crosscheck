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
import { renderSuspect } from "../src/cli/suspect-render.ts";
import { COVERAGE_EXEMPT_SURFACES } from "@crosscheck/connector-core/coverage/exempt-surfaces.ts";
import { UNKNOWN_COVERAGE } from "@crosscheck/connector-core/http/coverage.ts";
import type { CoverageRecord } from "@crosscheck/connector-core/http/coverage.ts";
import type { SuspectView } from "@crosscheck/connector-core/http/hub.ts";
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

  test("an unreachable hub is a statement about the network, not the hub's age", async () => {
    // Arrange: nothing is listening on this port
    const { repo, env } = await fixture("status-coverage-unreachable", oldHub, {
      unreachable: true,
    });

    // Act
    const result = await runCli(["status"], env, repo);

    // Assert: the same command already prints "(hub unreachable)" and "the hub
    // did not answer" below this line. A third line telling the reader their
    // hub is too old sends them to upgrade something that is simply down —
    // on the one surface AT-9 exists to make self-sufficient.
    expect(result.stdout).toContain("could not reach the hub");
    expect(result.stdout).not.toContain("this hub does not report coverage");
  });

  test("a hub whose report this client cannot read says exactly that", async () => {
    // Arrange: a hub that answers, with no coverage block at all
    const { repo, env } = await fixture("status-coverage-unreadable", oldHub);

    // Act
    const result = await runCli(["status"], env, repo);

    // Assert: true of a hub too old to send one AND of a hub NEWER than this
    // client, whose reasons parse to `hub_did_not_report`. The old sentence
    // named the hub's VERSION, which is one of the four ways to get here.
    expect(result.stdout).toContain("Coverage unknown");
    expect(result.stdout).toContain("no coverage report this client can read");
    expect(result.stdout).not.toContain("could not reach the hub");
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

  test("prints every COV-9 exemption with its reason", async () => {
    // Arrange
    const { repo, env } = await fixture("doctor-exemptions", reported);

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert: an exemption nobody sees is the silent absence AT-10 forbids.
    for (const surface of COVERAGE_EXEMPT_SURFACES) {
      expect(result.stdout).toContain(`PASS  coverage exempt ${surface.name}`);
      expect(result.stdout).toContain(surface.reason);
    }
    expect(COVERAGE_EXEMPT_SURFACES.length).toBeGreaterThan(0);
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

const suspectView = (coverage: CoverageRecord): SuspectView => ({
  outcome: "ranked",
  falsifier: { kind: "recorded_break", at: GAP_ISO, check: "bun test x" },
  scope: {
    kind: "pin",
    pinId: "pin_1",
    surface: "playback",
    files: ["src/player.ts"],
    missingFiles: [],
    rewrittenPaths: 0,
    rewrittenAt: null,
  },
  totals: { sessionsTouching: 2, sessionsScored: 2, windowDays: 14 },
  attribution: "sessions",
  candidates: [],
  coverage,
});

/**
 * §3.5's sixth response. 03 refusal 5 hands the EMPTY-result rule on
 * `no_touch` to the verdict spec — this one only has to carry the field and
 * annotate a positively observed gap, which is AT-9 on the surface where an
 * unqualified answer costs a name.
 */
describe("crosscheck suspect carries the qualifier", () => {
  test("a reaped rung annotates the ranking it rests on", () => {
    // Arrange
    const record: CoverageRecord = {
      repo: "github.com/acme/api",
      computedAt: GAP_ISO,
      scope: { sinceIso: GAP_ISO, paths: ["src/player.ts"] },
      sources: [
        {
          source: "agent_event",
          state: "incomplete",
          reason: "session_reaped",
          gapSince: GAP_ISO,
          observedAt: GAP_ISO,
        },
        { source: "git", state: "complete", reason: "commits_reported", gapSince: null, observedAt: GAP_ISO },
        { source: "ci", state: "unavailable", reason: "no_emitter", gapSince: null, observedAt: null },
        { source: "runtime", state: "unavailable", reason: "out_of_scope_1_0", gapSince: null, observedAt: null },
        { source: "human_edit", state: "unavailable", reason: "no_platform_rung", gapSince: null, observedAt: null },
      ],
    };

    // Act
    const rendered = renderSuspect(suspectView(record), new Date(GAP_ISO));

    // Assert
    expect(rendered).toContain("Coverage incomplete");
    expect(rendered).toContain(GAP_SHOWN);
  });

  test("an un-upgraded hub does not put a caveat on every ranking", () => {
    // Act
    const rendered = renderSuspect(
      suspectView(UNKNOWN_COVERAGE),
      new Date(GAP_ISO),
    );

    // Assert: the soft rule, decision 4 — `unknown` reaches doctor and
    // status every time, so no state is invisible.
    expect(rendered).not.toContain("Coverage");
  });
});
