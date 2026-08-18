/**
 * doctor's two latency-aware lines: the effective timeout with its SOURCE, and
 * a fresh distance measurement with a WARN when the two are too close for
 * comfort (LATENCY_FLAP_WARN_RATIO). Measurement also runs when the
 * reachability probe dies network-shaped — a hub past the tight effective
 * timeout is the incident itself, and skipping it left doctor naming neither
 * remedy exactly there. The measurement is injected — network timing never
 * decides a test — while the reachability probe talks to a local Bun.serve
 * hub (answering, denying, or hanging) or a refused port, doctor.test.ts's
 * own pattern.
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

/**
 * Never answers: doctor's reachability probe (which runs at the TIGHT
 * effective timeout) dies of AbortSignal.timeout — the incident state. No
 * sleep and no luck: the handler's promise never resolves, so the abort
 * always fires.
 */
const hangingHub = (): ReturnType<typeof Bun.serve> =>
  Bun.serve({
    port: 0,
    fetch: () => new Promise<Response>(() => undefined),
  });

/** Answers, but with a denial — the hub is there, the key is not welcome. */
const denyingHub = (): ReturnType<typeof Bun.serve> =>
  Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        { ok: false, error: { code: "unauthorized", message: "bad key" } },
        { status: 401 },
      ),
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
  test("names the incident when the median itself is past the timeout", async () => {
    // Arrange: the incident numbers — 500 ms away on the 400 ms default. Not
    // marginal: the median call dies, so "may flap" would undersell it.
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
    expect(result.stdout).toContain("past the timeout, calls die as unreachable");
    expect(result.stdout).toContain("crosscheck login");
    expect(result.stdout).toContain("CROSSCHECK_TIMEOUT_MS");
  });

  test("warns that calls may flap when only jitter can reach the timeout", async () => {
    // Arrange: 300 ms away on the 400 ms default — 2x300 crosses 400, but the
    // median itself is still under the timeout: flapping, not dead.
    const { repo, home } = await fixture();
    const server = acceptingHub();

    // Act
    const result = await runDoctor(
      doctorEnv(home, `http://127.0.0.1:${server.port}`),
      repo,
      measuredAt(300),
    );
    server.stop(true);

    // Assert
    expect(result.stdout).toContain("WARN  hub latency");
    expect(result.stdout).toContain("hub is 300 ms away, timeout 400 ms");
    expect(result.stdout).toContain("calls may flap");
    expect(result.stdout).not.toContain("die as unreachable");
    expect(result.stdout).toContain("crosscheck login");
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

  test("still measures when the reachability probe dies of the tight timeout", async () => {
    // Arrange: THE incident state — the hub answers, just slower than the
    // 400 ms default, so doctor's own probe (which runs at the effective
    // timeout) times out. Gating measurement on probe.ok left doctor printing
    // "FAIL hub reachable" + "not measured" here, naming neither remedy in
    // the one state this feature exists for.
    const { repo, home } = await fixture();
    const server = hangingHub();

    // Act
    const result = await runDoctor(
      doctorEnv(home, `http://127.0.0.1:${server.port}`),
      repo,
      measuredAt(600),
    );
    server.stop(true);

    // Assert: reachability FAILs honestly (its probe did time out), and the
    // latency line still says how far the hub is, why calls die, and both
    // remedies.
    expect(result.stdout).toContain("FAIL  hub reachable");
    expect(result.stdout).toContain("WARN  hub latency");
    expect(result.stdout).toContain("hub is 600 ms away, timeout 400 ms");
    expect(result.stdout).toContain("past the timeout, calls die as unreachable");
    expect(result.stdout).toContain("rerun crosscheck login");
    expect(result.stdout).toContain("CROSSCHECK_TIMEOUT_MS");
  });

  test("says not measured when the hub refuses connections, never a number", async () => {
    // Arrange
    const { repo, home } = await fixture();

    // Act: a refused hub fails the patient probes too — instantly — so the
    // measurer honestly reports null and the line must not invent a distance.
    const result = await runDoctor(doctorEnv(home, DEAD_HUB_URL), repo, () =>
      Promise.resolve(null),
    );

    // Assert
    expect(result.stdout).toContain("PASS  hub latency  not measured");
  });

  test("does not measure a hub that answered with a denial", async () => {
    // Arrange: a 401 is an ANSWER — the hub is near enough, the key is wrong,
    // and the reachability FAIL owns that story.
    const { repo, home } = await fixture();
    const server = denyingHub();

    // Act: the injected measurer must not even be consulted
    const result = await runDoctor(
      doctorEnv(home, `http://127.0.0.1:${server.port}`),
      repo,
      () => {
        throw new Error("measured a hub that already answered the probe");
      },
    );
    server.stop(true);

    // Assert
    expect(result.stdout).toContain("FAIL  hub reachable  invalid api key");
    expect(result.stdout).toContain("PASS  hub latency  not measured");
  });
});

describe("the WARN names a knob that actually moves THIS timeout", () => {
  test("env owner: raise CROSSCHECK_TIMEOUT_MS — a login rerun is a no-op", async () => {
    // Arrange: CROSSCHECK_TIMEOUT_MS=600 governs; hub 500 ms away (1000 > 600).
    // Policy keeps env values, so "rerun crosscheck login" would change nothing.
    const { repo, home } = await fixture();
    const server = acceptingHub();

    // Act
    const result = await runDoctor(
      doctorEnv(home, `http://127.0.0.1:${server.port}`, {
        CROSSCHECK_TIMEOUT_MS: "600",
      }),
      repo,
      measuredAt(500),
    );
    server.stop(true);

    // Assert
    expect(result.stdout).toContain("WARN  hub latency");
    expect(result.stdout).toContain("raise CROSSCHECK_TIMEOUT_MS");
    expect(result.stdout).not.toContain("rerun crosscheck login");
  });

  test("hand-set owner: the remedy is the value's own knob, not a login rerun", async () => {
    // Arrange: a human wrote timeoutMs 500 (no measured marker); hub 300 ms
    // away (600 > 500). Login keeps hand-set values, so advising a rerun
    // would loop: WARN -> login keeps 500 -> identical WARN.
    const { repo, home } = await fixture();
    const server = acceptingHub();
    const hubUrl = `http://127.0.0.1:${server.port}`;
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ version: 1, hubUrl, apiKey: "test-key", timeoutMs: 500 }),
      "utf8",
    );

    // Act
    const result = await runDoctor(doctorEnv(home, hubUrl), repo, measuredAt(300));
    server.stop(true);

    // Assert
    expect(result.stdout).toContain("WARN  hub latency");
    expect(result.stdout).toContain("raise your hand-set timeoutMs");
    expect(result.stdout).toContain("CROSSCHECK_TIMEOUT_MS");
    expect(result.stdout).not.toContain("rerun crosscheck login");
  });

  test("login owner below the cap: a rerun stores more and is the remedy", async () => {
    // Arrange: login stored 2200 in a closer era; the hub is now 1200 ms away
    // (2400 > 2200), and a fresh login would store the 5000 cap.
    const { repo, home } = await fixture();
    const server = acceptingHub();
    const hubUrl = `http://127.0.0.1:${server.port}`;
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        version: 1,
        hubUrl,
        apiKey: "test-key",
        timeoutMs: 2_200,
        timeoutSource: MEASURED_TIMEOUT_SOURCE,
      }),
      "utf8",
    );

    // Act
    const result = await runDoctor(doctorEnv(home, hubUrl), repo, measuredAt(1_200));
    server.stop(true);

    // Assert
    expect(result.stdout).toContain("WARN  hub latency");
    expect(result.stdout).toContain("rerun crosscheck login");
  });

  test("login owner at the cap: a rerun re-stores the cap — only the env var is left", async () => {
    // Arrange: login already stores 5000, its cap; hub 2600 ms away
    // (5200 > 5000) — the recommendation cannot exceed what is stored.
    const { repo, home } = await fixture();
    const server = acceptingHub();
    const hubUrl = `http://127.0.0.1:${server.port}`;
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        version: 1,
        hubUrl,
        apiKey: "test-key",
        timeoutMs: 5_000,
        timeoutSource: MEASURED_TIMEOUT_SOURCE,
      }),
      "utf8",
    );

    // Act
    const result = await runDoctor(doctorEnv(home, hubUrl), repo, measuredAt(2_600));
    server.stop(true);

    // Assert
    expect(result.stdout).toContain("WARN  hub latency");
    expect(result.stdout).toContain("login already stores its cap (5000 ms)");
    expect(result.stdout).toContain("set CROSSCHECK_TIMEOUT_MS");
    expect(result.stdout).not.toContain("rerun crosscheck login");
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
