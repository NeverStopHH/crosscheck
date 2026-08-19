/**
 * Login measures the hub's distance and stores a fitting timeout — the whole
 * flow through runLogin, with the MEASUREMENT injected so no test depends on
 * real network timing. The auth probe itself talks to a local Bun.serve hub,
 * the established pattern of cli.test.ts.
 *
 * The incident this guards: a teammate reaching the hub over a Tailscale DERP
 * relay at 200-580 ms RTT had every CLI call die as "hub unreachable" on the
 * 400 ms LAN default, while the escape hatch (CROSSCHECK_TIMEOUT_MS, stored
 * timeoutMs) sat undiscovered.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  HTTP_TIMEOUT_MS,
  LATENCY_PROBE_TIMEOUT_MS,
} from "@crosscheck/connector-core/constants.ts";
import { MEASURED_TIMEOUT_SOURCE } from "@crosscheck/connector-core/config/config.ts";
import type { Config } from "@crosscheck/connector-core/config/config.ts";
import { loginProbeTimeoutMs, runLogin } from "../src/cli/login.ts";
import type { LatencyMeasurer } from "../src/cli/login.ts";
import { makeHome } from "../../connector-core/test/helpers.ts";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

/** A hub that accepts the auth probe; latency itself is injected, never timed. */
const acceptingHub = (): ReturnType<typeof Bun.serve> =>
  Bun.serve({
    port: 0,
    fetch: () => Response.json({ ok: true, data: { sessions: [] } }),
  });

const measured =
  (medianRttMs: number): LatencyMeasurer =>
  () =>
    Promise.resolve({ medianRttMs, samples: 5 });

const failedMeasurement: LatencyMeasurer = () => Promise.resolve(null);

const storedConfig = async (home: string): Promise<Config> =>
  JSON.parse(await readFile(join(home, "config.json"), "utf8")) as Config;

const seedConfig = async (home: string, config: Config): Promise<void> => {
  await writeFile(join(home, "config.json"), JSON.stringify(config), "utf8");
};

const login = async (
  home: string,
  hubUrl: string,
  measure: LatencyMeasurer,
  env: Record<string, string> = {},
): Promise<{ readonly stdout: string; readonly exitCode: number }> =>
  runLogin(
    [hubUrl],
    { CROSSCHECK_HOME: home, CROSSCHECK_API_KEY: "test-key", ...env },
    async () => null,
    measure,
  );

describe("login stores a measured timeout for a far hub", () => {
  test("persists 4x median plus floor, marked as login's own", async () => {
    // Arrange: the hub answers 500 ms away (median of 5 probes, injected)
    const home = await makeHome("login-latency");
    paths.push(home);
    const server = acceptingHub();

    // Act
    const result = await login(home, `http://127.0.0.1:${server.port}`, measured(500));
    server.stop(true);

    // Assert: stored, marked, and said out loud — one honest line with the
    // measured latency and the chosen timeout
    expect(result.exitCode).toBe(0);
    const config = await storedConfig(home);
    expect(config.timeoutMs).toBe(2_200);
    expect(config.timeoutSource).toBe(MEASURED_TIMEOUT_SOURCE);
    expect(result.stdout).toContain("hub is 500 ms away");
    expect(result.stdout).toContain("2200 ms");
  });

  test("keeps the tight default for a LAN hub — nothing is stored", async () => {
    // Arrange: 2 ms away; the recommendation clamps to the default
    const home = await makeHome("login-lan");
    paths.push(home);
    const server = acceptingHub();

    // Act
    const result = await login(home, `http://127.0.0.1:${server.port}`, measured(2));
    server.stop(true);

    // Assert: never a value at or below the default in the file
    expect(result.exitCode).toBe(0);
    const config = await storedConfig(home);
    expect("timeoutMs" in config).toBe(false);
    expect("timeoutSource" in config).toBe(false);
    expect(result.stdout).toContain("hub is 2 ms away");
    expect(result.stdout).toContain(`${HTTP_TIMEOUT_MS} ms`);
  });

  test("never stores a value lower than the default, even at zero latency", async () => {
    // Arrange
    const home = await makeHome("login-zero");
    paths.push(home);
    const server = acceptingHub();

    // Act
    await login(home, `http://127.0.0.1:${server.port}`, measured(0));
    server.stop(true);

    // Assert
    expect("timeoutMs" in (await storedConfig(home))).toBe(false);
  });
});

describe("login never overwrites a timeout it did not write", () => {
  test("a hand-set stored timeoutMs survives a disagreeing measurement", async () => {
    // Arrange: a human wrote timeoutMs 9000 into the config (no measured marker)
    const home = await makeHome("login-manual");
    paths.push(home);
    const server = acceptingHub();
    const hubUrl = `http://127.0.0.1:${server.port}`;
    await seedConfig(home, {
      version: 1,
      hubUrl,
      apiKey: "old-key",
      timeoutMs: 9_000,
    });

    // Act: the measurement says 2200 would do
    const result = await login(home, hubUrl, measured(500));
    server.stop(true);

    // Assert: kept, and the line says why
    const config = await storedConfig(home);
    expect(config.timeoutMs).toBe(9_000);
    expect("timeoutSource" in config).toBe(false);
    expect(result.stdout).toContain("9000");
    expect(result.stdout).toContain("hub is 500 ms away");
  });

  test("an explicit CROSSCHECK_TIMEOUT_MS is named and nothing is stored", async () => {
    // Arrange
    const home = await makeHome("login-env");
    paths.push(home);
    const server = acceptingHub();

    // Act
    const result = await login(
      home,
      `http://127.0.0.1:${server.port}`,
      measured(500),
      { CROSSCHECK_TIMEOUT_MS: "3000" },
    );
    server.stop(true);

    // Assert
    const config = await storedConfig(home);
    expect("timeoutMs" in config).toBe(false);
    expect(result.stdout).toContain("CROSSCHECK_TIMEOUT_MS");
  });

  test("refreshes its OWN stale value once the hub is close again", async () => {
    // Arrange: an earlier login (from the far side of a relay) stored 2200 with
    // the measured marker; the developer is back on the LAN now
    const home = await makeHome("login-refresh");
    paths.push(home);
    const server = acceptingHub();
    const hubUrl = `http://127.0.0.1:${server.port}`;
    await seedConfig(home, {
      version: 1,
      hubUrl,
      apiKey: "old-key",
      timeoutMs: 2_200,
      timeoutSource: MEASURED_TIMEOUT_SOURCE,
    });

    // Act
    const result = await login(home, hubUrl, measured(2));
    server.stop(true);

    // Assert: login retires the value it wrote itself — back to the default —
    // and SAYS it removed the stored value, so the config diff is explicable
    const config = await storedConfig(home);
    expect("timeoutMs" in config).toBe(false);
    expect("timeoutSource" in config).toBe(false);
    expect(result.stdout).toContain("retiring stored 2200 ms");
    expect(result.exitCode).toBe(0);
  });
});

describe("login without a measurement", () => {
  test("says so and changes no timeout setting", async () => {
    // Arrange: every latency probe failed (auth probe succeeded moments before,
    // so this is a flapping path, not a dead hub)
    const home = await makeHome("login-nomeasure");
    paths.push(home);
    const server = acceptingHub();

    // Act
    const result = await login(home, `http://127.0.0.1:${server.port}`, failedMeasurement);
    server.stop(true);

    // Assert: still logged in; honest about the missing number
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("not measured");
    expect("timeoutMs" in (await storedConfig(home))).toBe(false);
  });
});

describe("the auth probe's own patience", () => {
  test("waits like a human-run command, not like a hook", () => {
    // Assert: at the hook default the teammate 580 ms away could never log in
    // at all — the probe must never be tighter than LATENCY_PROBE_TIMEOUT_MS.
    expect(loginProbeTimeoutMs({}, null)).toBe(LATENCY_PROBE_TIMEOUT_MS);
    expect(loginProbeTimeoutMs({}, null)).toBeGreaterThan(HTTP_TIMEOUT_MS);
  });

  test("honours an even more patient explicit setting", () => {
    expect(loginProbeTimeoutMs({ CROSSCHECK_TIMEOUT_MS: "20000" }, null)).toBe(20_000);
    // A TIGHTER explicit setting must not re-create the incident at login.
    expect(loginProbeTimeoutMs({ CROSSCHECK_TIMEOUT_MS: "200" }, null)).toBe(
      LATENCY_PROBE_TIMEOUT_MS,
    );
  });
});
