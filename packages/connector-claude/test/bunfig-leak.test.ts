/**
 * A repo bunfig with logLevel="debug" makes EVERY bun process in that cwd —
 * our hooks and MCP server included — print full request headers to stderr,
 * `Authorization: Bearer <api key>` among them. doctor WARNs about the state
 * (doctor.test.ts pins that); this file pins the DEFUSAL: the connector's own
 * hub calls must not leak the key even under a debug bunfig.
 *
 * MECHANISM, measured on Bun 1.3.13 before writing the fix (the numbers are
 * the counts of the marker in captured stderr):
 *
 *   bunfig logLevel="debug", plain fetch                      leaks (1)
 *   + BUN_CONFIG_VERBOSE_FETCH=0 in the spawn env             leaks (1)
 *   + process.env.BUN_CONFIG_VERBOSE_FETCH="0" at runtime     leaks (1)
 *   + fetch(..., { verbose: false }) per request              clean (0)
 *
 * NO environment variable wins over the bunfig — the launcher-env idea is
 * dead on arrival — but fetch's own per-request `verbose: false` provably
 * does. Every hub call goes through the one fetch in http/client.ts, so the
 * shield is one option on one call site, pinned here through the real hook
 * binary. The CONTROL test proves the fixture genuinely leaks for unshielded
 * processes on the running bun, so a bun that changed its bunfig discovery
 * would fail the control instead of silently making the main test vacuous.
 *
 * RESIDUAL RISK, stated honestly: the shield covers the connector's own
 * processes. Other bun processes in that repo still print THEIR headers, and
 * connectors older than this fix still leak — doctor's WARN (kept) is what
 * names the file and advises rotation.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { makeHome, makeRepo } from "./helpers.ts";

const BIN_PATH = resolve(import.meta.dir, "..", "src", "bin", "crosscheck.ts");
const CONTROL_PATH = join(import.meta.dir, "fixtures", "verbose-leak-control.ts");

const SECRET_KEY = "cx_secret_marker_key";
const DEBUG_BUNFIG = 'logLevel = "debug"\n';

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

interface SpawnOutcome {
  readonly stderr: string;
  readonly exitCode: number;
}

const spawnInRepo = async (
  cwd: string,
  cmd: readonly string[],
  env: Record<string, string>,
  stdinPayload?: string,
): Promise<SpawnOutcome> => {
  const proc = Bun.spawn({
    cmd: [...cmd],
    cwd,
    stdin:
      stdinPayload === undefined
        ? "ignore"
        : new TextEncoder().encode(stdinPayload),
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stderr, exitCode };
};

/** Answers every endpoint with a healthy envelope; the leak is request-side. */
const acceptingHub = (): ReturnType<typeof Bun.serve> =>
  Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        ok: true,
        data: { session: { id: "s1", developerId: "d1" }, sessions: [] },
      }),
  });

describe("a debug bunfig in the repo must not leak the api key", () => {
  test("control: an unshielded fetch in this cwd DOES leak its header", async () => {
    // Arrange: the fixture — without this control going red-hot, the main
    // assertion below could pass vacuously on a bun that stopped reading
    // ./bunfig.toml
    const repo = await makeRepo("bunfig-control");
    const home = await makeHome("bunfig-control");
    paths.push(repo, home);
    await writeFile(join(repo, "bunfig.toml"), DEBUG_BUNFIG, "utf8");
    const server = acceptingHub();

    // Act
    const outcome = await spawnInRepo(
      repo,
      [process.execPath, CONTROL_PATH, `http://127.0.0.1:${server.port}/`],
      {},
    );
    server.stop(true);

    // Assert: the mechanism is live on this runtime
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).toContain("cx_control_marker_key");
  });

  test("a hook invocation under the same bunfig never prints the key", async () => {
    // Arrange: the incident shape — the monorepo's bunfig, our hook, our key
    const repo = await makeRepo("bunfig-hook", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("bunfig-hook");
    paths.push(repo, home);
    await writeFile(join(repo, "bunfig.toml"), DEBUG_BUNFIG, "utf8");
    const server = acceptingHub();

    // Act: the real binary, cwd inside the repo, real hub round trips
    const outcome = await spawnInRepo(
      repo,
      [process.execPath, BIN_PATH, "hook", "session-start"],
      {
        CROSSCHECK_HOME: home,
        CROSSCHECK_HUB_URL: `http://127.0.0.1:${server.port}`,
        CROSSCHECK_API_KEY: SECRET_KEY,
        CROSSCHECK_TIMEOUT_MS: "2000",
      },
      JSON.stringify({
        session_id: "bunfig-leak-uuid",
        cwd: repo,
        hook_event_name: "SessionStart",
      }),
    );
    server.stop(true);

    // Assert: the hook ran (exit 0 always) and the key is nowhere on stderr
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).not.toContain(SECRET_KEY);
    expect(outcome.stderr).not.toContain("Authorization: Bearer");
  });
});
