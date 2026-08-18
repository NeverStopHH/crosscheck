/**
 * doctor's two latency-aware lines: the effective timeout with its SOURCE, and
 * a fresh distance measurement with a WARN when the two are too close for
 * comfort (LATENCY_FLAP_WARN_RATIO). The measurement is injected — network
 * timing never decides a test — while the reachability probe talks to a local
 * Bun.serve hub or a refused port, doctor.test.ts's own pattern.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runDoctor } from "../src/cli/doctor.ts";
import type { MeasureLatency } from "../src/cli/doctor.ts";
import { MEASURED_TIMEOUT_SOURCE } from "../src/config/config.ts";
import { makeHome, makeRepo } from "./helpers.ts";

/** Refuses connections: the latency line must say "not measured", not a number. */
const DEAD_HUB_URL = "http://127.0.0.1:9";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const fixture = async (): Promise<{ readonly repo: string; readonly home: string }> => {
  const repo = await makeRepo("doctor-latency", {
    remote: "git@github.com:acme/api.git",
  });
  const home = await makeHome("doctor-latency");
  paths.push(repo, home);
  return { repo, home };
};

const acceptingHub = (): ReturnType<typeof Bun.serve> =>
  Bun.serve({
    port: 0,
    fetch: () => Response.json({ ok: true, data: { sessions: [] } }),
  });

const doctorEnv = (home: string, hubUrl: string, extra: Record<string, string> = {}) => ({
  CROSSCHECK_HOME: home,
  HOME: home,
  CROSSCHECK_HUB_URL: hubUrl,
  CROSSCHECK_API_KEY: "test-key",
  ...extra,
});

const measuredAt =
  (medianRttMs: number): MeasureLatency =>
  () =>
    Promise.resolve({ medianRttMs, samples: 5 });

describe("crosscheck doctor hub latency check", () => {
  test("warns when the hub is within the flap margin of the effective timeout", async () => {
    // Arrange: the incident — 500 ms away on the 400 ms default
    const { repo, home } = await fixture();
    const server = acceptingHub();

    // Act
    const result = await runDoctor(
      doctorEnv(home, `http://127.0.0.1:${server.port}`),
      repo,
      measuredAt(500),
    );
    server.stop(true);

    // Assert: the numbers, the consequence, and both remedies in one line —
    // including the honest half: hooks fail open, so the tight in-session
    // surfaces go silent rather than slow.
    expect(result.stdout).toContain("WARN  hub latency");
    expect(result.stdout).toContain("hub is 500 ms away, timeout 400 ms");
    expect(result.stdout).toContain("may flap");
    expect(result.stdout).toContain("crosscheck login");
    expect(result.stdout).toContain("CROSSCHECK_TIMEOUT_MS");
  });

  test("passes with the same numbers shown when the margin holds", async () => {
    // Arrange: 100 ms away on the 400 ms default — 2x100 stays under 400
    const { repo, home } = await fixture();
    const server = acceptingHub();

    // Act
    const result = await runDoctor(
      doctorEnv(home, `http://127.0.0.1:${server.port}`),
      repo,
      measuredAt(100),
    );
    server.stop(true);

    // Assert
    expect(result.stdout).toContain("PASS  hub latency  hub is 100 ms away, timeout 400 ms");
  });

  test("says not measured when the hub is unreachable, never a number", async () => {
    // Arrange
    const { repo, home } = await fixture();

    // Act: the injected measurer must not even be consulted — a dead hub has
    // no distance worth printing
    const result = await runDoctor(doctorEnv(home, DEAD_HUB_URL), repo, () => {
      throw new Error("measured a hub the reachability probe already declared dead");
    });

    // Assert
    expect(result.stdout).toContain("PASS  hub latency  not measured");
  });
});

describe("crosscheck doctor timeout source line", () => {
  test("shows the default and names it as such", async () => {
    // Arrange
    const { repo, home } = await fixture();

    // Act
    const result = await runDoctor(doctorEnv(home, DEAD_HUB_URL), repo);

    // Assert
    expect(result.stdout).toContain("PASS  timeout  400 ms (default)");
  });

  test("shows an env override and names the variable", async () => {
    // Arrange
    const { repo, home } = await fixture();

    // Act
    const result = await runDoctor(
      doctorEnv(home, DEAD_HUB_URL, { CROSSCHECK_TIMEOUT_MS: "3000" }),
      repo,
    );

    // Assert
    expect(result.stdout).toContain("PASS  timeout  3000 ms (CROSSCHECK_TIMEOUT_MS)");
  });

  test("distinguishes a login-measured stored value from a hand-set one", async () => {
    // Arrange: two configs, one marker apart
    const { repo, home } = await fixture();
    const measuredConfig = {
      version: 1,
      hubUrl: DEAD_HUB_URL,
      apiKey: "test-key",
      timeoutMs: 2_200,
      timeoutSource: MEASURED_TIMEOUT_SOURCE,
    };
    await writeFile(join(home, "config.json"), JSON.stringify(measuredConfig), "utf8");

    // Act
    const measuredResult = await runDoctor(doctorEnv(home, DEAD_HUB_URL), repo);
    const { timeoutSource: _dropped, ...manualConfig } = measuredConfig;
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ ...manualConfig, timeoutMs: 9_000 }),
      "utf8",
    );
    const manualResult = await runDoctor(doctorEnv(home, DEAD_HUB_URL), repo);

    // Assert: the source tells the reader which command may rewrite the value
    expect(measuredResult.stdout).toContain(
      "PASS  timeout  2200 ms (stored config, measured at login)",
    );
    expect(manualResult.stdout).toContain(
      "PASS  timeout  9000 ms (stored config, set by hand)",
    );
  });
});
