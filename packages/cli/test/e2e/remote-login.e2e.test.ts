/**
 * THE FRONT DOOR MUST WORK FROM FAR AWAY WITH ZERO CONFIGURATION.
 *
 * The catch-22 this pins (2026-08-18 live trial onboarding): the login auth
 * probe used to run at the hardcoded 400 ms LAN default, ignoring both
 * CROSSCHECK_TIMEOUT_MS and any stored timeoutMs — so a teammate whose hub
 * sat ~600 ms away over a Tailscale DERP relay could NEVER log in. The escape
 * hatch reached every call except the one that installs it.
 *
 * This file is the finding's proof: it runs the real flow — login, init,
 * doctor — against a hub whose every response arrives after 600 ms, with a
 * fresh home and no timeout environment variables. On the pre-fix tree
 * (4529fcc, before the latency-aware-timeout block) login dies with
 * "hub unreachable" and this file goes red; on the fixed tree the probe is
 * patient by design (loginProbeTimeoutMs), the measurement runs at the same
 * patience, a fitting timeout is STORED, and a subsequent doctor is green
 * end to end.
 *
 * The 600 ms delay is the injected subject, not a synchronization sleep: the
 * hub's slowness IS what is under test, and every timeout that meets it is
 * the code's own.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { HTTP_TIMEOUT_MS } from "@crosscheck/connector-core/constants.ts";
import { runDoctor } from "../../src/cli/doctor.ts";
import { runInit } from "../../src/cli/init.ts";
import { runLogin } from "../../src/cli/login.ts";
import { makeHome, makeRepo } from "../../../connector-core/test/helpers.ts";

/** The incident's distance: every response arrives this late. */
const HUB_DELAY_MS = 600;

/**
 * What login must store for a 600 ms hub: recommendedTimeoutMs floors at
 * 600 * LATENCY_TIMEOUT_MULTIPLIER + LATENCY_TIMEOUT_FLOOR_MS = 2600, and
 * loopback overhead only pushes the median up. The cap bounds it above.
 * Literals rather than the constants so this file also runs, unchanged, on
 * the pre-fix tree that had neither constant — that run is the RED proof.
 */
const MIN_STORED_TIMEOUT_MS = 2_600;
const MAX_STORED_TIMEOUT_MS = 5_000;

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

/** A hub that answers everything correctly — 600 ms later. */
const farHub = (): ReturnType<typeof Bun.serve> =>
  Bun.serve({
    port: 0,
    fetch: async () => {
      await Bun.sleep(HUB_DELAY_MS);
      return Response.json({ ok: true, data: { sessions: [] } });
    },
  });

describe("first login from far away, zero configuration", () => {
  test("login succeeds, stores a measured timeout, and doctor is then green", async () => {
    // Arrange: fresh home, a real git repo, no CROSSCHECK_* timeout env —
    // exactly the state of a new teammate's machine on day one. The key
    // arrives on stdin, the documented safe form.
    const home = await makeHome("remote-login");
    const repo = await makeRepo("remote-login", {
      remote: "git@github.com:acme/api.git",
    });
    paths.push(home, repo);
    const server = farHub();
    const hubUrl = `http://127.0.0.1:${server.port}`;
    const env = { CROSSCHECK_HOME: home, HOME: home };

    // Act 1: the front door, real probes against the real 600 ms hub
    const login = await runLogin([hubUrl], env, async () => "test-key");

    // Assert 1: logged in — the pre-fix tree dies here with "hub unreachable"
    expect(login.stdout).toContain("logged in to");
    expect(login.exitCode).toBe(0);

    // Assert 2: the measured distance was said and a fitting timeout STORED,
    // marked as login's own — zero configuration by the human
    expect(login.stdout).toContain("ms away");
    const config = JSON.parse(
      await readFile(join(home, "config.json"), "utf8"),
    ) as { timeoutMs?: number; timeoutSource?: string };
    expect(config.timeoutMs).toBeDefined();
    expect(config.timeoutMs ?? 0).toBeGreaterThanOrEqual(MIN_STORED_TIMEOUT_MS);
    expect(config.timeoutMs ?? 0).toBeLessThanOrEqual(MAX_STORED_TIMEOUT_MS);
    expect(config.timeoutMs ?? 0).toBeGreaterThan(HTTP_TIMEOUT_MS);
    expect(config.timeoutSource).toBe("measured");

    // Act 2: install into the repo (hooks, mcp, .crosscheck.json)
    const init = await runInit([], env, repo);
    expect(init.exitCode).toBe(0);

    // Act 3: the health check, at the stored timeout, over the same far hub
    const doctor = await runDoctor(env, repo);
    server.stop(true);

    // Assert 3: GREEN — every check passes, and the three connection lines
    // say why: reachable at the stored timeout, whose owner is login
    expect(doctor.stdout).toContain("PASS  hub reachable");
    expect(doctor.stdout).toContain("stored config, measured at login");
    expect(doctor.stdout).toContain("PASS  hub latency");
    expect(doctor.stdout).toContain("0 warn, 0 fail");
    expect(doctor.exitCode).toBe(0);
  }, 30_000);
});
