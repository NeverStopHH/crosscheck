/**
 * THE GUARD ITSELF (test/network-guard.ts). A real hub listens on
 * 127.0.0.1:7100 on a developer machine; these pin that no test can reach it,
 * or any tailnet host, through either door a test uses — the global `fetch`
 * and the connector's own HTTP client — while an in-process hub on a random
 * port still answers.
 *
 * This file imports the RULES only, never the preload: the first test proves
 * the bunfig wired the guard for this very run, and the requests below are
 * made only when it did, so a run that lost the preload fails here instead of
 * dialling the real hub.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { z } from "zod";

import { hubRequest } from "../src/http/client.ts";
import { makeHome } from "./helpers.ts";
import {
  BLOCKED_FETCHES_KEY,
  GUARD_CHILD_ENV,
  GUARD_INSTALLED_KEY,
  HUB_ENV_KEYS,
  isRealHubUrl,
  isTestHubUrl,
  isUnderDir,
  withGuardPreload,
} from "./network-guard-rules.ts";
import type { GuardMarks } from "./network-guard-rules.ts";

/** The preload this suite's bunfig wires, as children are told to load it. */
const GUARD_PATH = resolve(import.meta.dir, "network-guard.ts");

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

const paths: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  for (const server of servers) {
    server.stop(true);
  }
  servers.length = 0;
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const marks = globalThis as GuardMarks;
const blockedSoFar = (): number => marks[BLOCKED_FETCHES_KEY] ?? 0;

/** Refuses to make the request at all unless the guard is in place. */
const requireGuard = (): void => {
  if (marks[GUARD_INSTALLED_KEY] !== true) {
    throw new Error("the network guard preload is not wired for this run — no request made");
  }
};

describe("which URLs count as a real hub", () => {
  test.each([
    ["http://127.0.0.1:7100/api/health", true],
    ["http://localhost:7100", true],
    ["http://[::1]:7100/api/records", true],
    ["http://0.0.0.0:7100", true],
    ["https://hub.tailnet.ts.net/api/presence", true],
    ["http://HUB.TAILNET.TS.NET:8443", true],
    // Round 3, F-M3: the spellings that reach a loopback listener and a tailnet
    ["http://localhost.:7100", true],
    ["http://[::ffff:127.0.0.1]:7100", true],
    ["http://2130706433:7100", true],
    ["http://0x7f000001:7100", true],
    ["http://127.1:7100", true],
    ["http://127.0.0.2:7100", true],
    ["http://dev.localhost:7100", true],
    ["http://[::]:7100", true],
    ["https://hub.tailnet.ts.net./api/presence", true],
    ["http://100.101.102.103:8443", true],
    ["http://[fd7a:115c:a1e0:ab12::1]:443", true],
    ["http://127.0.0.1:7199", false],
    ["http://127.0.0.1:1", false],
    ["http://hub.example:7100", false],
    ["http://hub.invalid", false],
    ["http://10.0.0.1:7100", false],
    ["http://100.128.0.1:7100", false],
    ["http://[::ffff:10.0.0.1]:7100", false],
    ["http://localhost.example:7100", false],
  ] as const)("%s → %p", (url, expected) => {
    // Act / Assert
    expect(isRealHubUrl(new URL(url))).toBe(expected);
  });
});

describe("what only a test sets, and so survives the first run's scrub (round 3, F-M3)", () => {
  test.each([
    ["http://127.0.0.1:41234", true],
    ["http://localhost:9", true],
    ["http://127.0.0.1:7100", false],
    ["http://127.0.0.1", false],
    ["https://hub.tailnet.ts.net:8443", false],
    ["https://crosscheck.example.com:9443", false],
    ["not a url", false],
  ] as const)("hub URL %s is a test hub → %p", (url, expected) => {
    // Act / Assert
    expect(isTestHubUrl(url)).toBe(expected);
  });

  test("a home or archive counts as a test's only inside the temp directory", () => {
    // Act / Assert
    expect(isUnderDir("/tmp/x/cx-home-a", "/tmp/x")).toBe(true);
    expect(isUnderDir("/tmp/x", "/tmp/x")).toBe(false);
    expect(isUnderDir("/tmp/xy/home", "/tmp/x")).toBe(false);
    expect(isUnderDir(join(homedir(), ".crosscheck"), tmpdir())).toBe(false);
    expect(isUnderDir(undefined, tmpdir())).toBe(false);
  });
});

describe("the preload refuses a real hub on every door a test uses", () => {
  test("the preload wired the guard for this very run", () => {
    // Assert
    expect(marks[GUARD_INSTALLED_KEY]).toBe(true);
  });

  test("a bare fetch to 127.0.0.1:7100 rejects before any socket opens", async () => {
    // Arrange
    requireGuard();
    const before = blockedSoFar();

    // Act
    const attempt = fetch("http://127.0.0.1:7100/api/health");

    // Assert
    await expect(attempt).rejects.toThrow("test network guard");
    expect(blockedSoFar()).toBe(before + 1);
  });

  test("a tailnet host rejects too, given as a Request", async () => {
    // Arrange
    requireGuard();

    // Act / Assert
    await expect(fetch(new Request("https://hub.tailnet.ts.net/api/presence"))).rejects.toThrow(
      "test network guard",
    );
  });

  test("the connector's HTTP client reaches the guard and reads it as a network failure", async () => {
    // Arrange
    requireGuard();
    const home = await makeHome("network-guard");
    paths.push(home);
    const before = blockedSoFar();

    // Act
    const result = await hubRequest(
      { hubUrl: "http://127.0.0.1:7100", apiKey: "test-key", timeoutMs: 400, home, repoKey: "guard", now: () => new Date() },
      { method: "GET", path: "/api/health", schema: z.unknown() },
    );

    // Assert
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.kind).toBe("network");
    expect(blockedSoFar()).toBe(before + 1);
  });

  test("an in-process hub on a random port still answers", async () => {
    // Arrange
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true, data: { pong: true } }) });
    servers.push(server);

    // Act
    const response = await fetch(`http://127.0.0.1:${String(server.port)}/ping`);

    // Assert
    expect(await response.json()).toEqual({ ok: true, data: { pong: true } });
  });
});

describe("the guard reaches every child a test spawns with its env (round 3, F-M3)", () => {
  /** What a bun child reports of its own environment and guard, as JSON on stdout. */
  const REPORT = [
    `const keys = ${JSON.stringify(HUB_ENV_KEYS)};`,
    `const marks = globalThis;`,
    `let refused = "";`,
    `try { await fetch("http://127.0.0.1:7100/api/health"); } catch (error) { refused = String(error); }`,
    `const home = process.env.CROSSCHECK_HOME ?? null;`,
    `console.log(JSON.stringify({`,
    `  hub: Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null])),`,
    `  home, homeExists: home !== null && (await import("node:fs")).existsSync(home),`,
    `  bunOptions: process.env.BUN_OPTIONS ?? "", child: process.env.${GUARD_CHILD_ENV} ?? null,`,
    `  guarded: marks[Symbol.for("crosscheck.test.networkGuardInstalled")] === true, refused,`,
    `}));`,
  ].join("\n");

  interface ChildReport {
    readonly hub: Readonly<Record<string, string | null>>;
    readonly home: string | null;
    readonly homeExists: boolean;
    readonly bunOptions: string;
    readonly child: string | null;
    readonly guarded: boolean;
    readonly refused: string;
  }

  const reportOf = async (args: readonly string[], env: Record<string, string | undefined>): Promise<ChildReport> => {
    const child = Bun.spawn({ cmd: [process.execPath, ...args, "-e", REPORT], env, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) {
      throw new Error(`the guard child failed: ${await new Response(child.stderr).text()}`);
    }
    return JSON.parse(stdout) as ChildReport;
  };

  /**
   * A hub's credentials and an archive, as a developer's shell might export
   * them beside the hub's URL — none of them real, and the child below dials
   * nothing but the refused 127.0.0.1:7100.
   */
  const SHELL_HUB: Readonly<Record<string, string>> = {
    CROSSCHECK_API_KEY: "k",
    CROSSCHECK_CI_TOKEN: "t",
    CROSSCHECK_DATA_DIR: "/nonexistent/crosscheck-archive",
  };

  /** The hub URLs a shell exports: the machine's own hub, a tailnet name, a team's host. */
  const SHELL_HUB_URLS = ["http://127.0.0.1:7100", "https://hub.tailnet.ts.net", "https://crosscheck.example.com"] as const;

  test("this run carries no hub variable, a home of its own and the guard for its children", () => {
    // Assert
    for (const key of HUB_ENV_KEYS) {
      expect(process.env[key], key).toBeUndefined();
    }
    const home = process.env["CROSSCHECK_HOME"] ?? "";
    expect(home.startsWith(tmpdir())).toBe(true);
    expect(home.startsWith(join(homedir(), ".crosscheck"))).toBe(false);
    expect((process.env["BUN_OPTIONS"] ?? "").split(/\s+/u)).toContain(`--preload=${GUARD_PATH}`);
    expect(process.env[GUARD_CHILD_ENV]).toBe("1");
  });

  test.each([...SHELL_HUB_URLS])(
    "a run started from a shell that exports %s scrubs it, and gives itself a temp home, at preload",
    async (hubUrl) => {
      // Arrange: a first run — no child marker, no BUN_OPTIONS — under a shell
      // that exports a hub and a crosscheck home (one nothing can be written to)
      const { [GUARD_CHILD_ENV]: _marker, BUN_OPTIONS: _options, ...rest } = process.env;
      const shell = {
        ...rest,
        ...SHELL_HUB,
        CROSSCHECK_HUB_URL: hubUrl,
        CROSSCHECK_HOME: "/nonexistent/shell-home/.crosscheck",
      };

      // Act
      const report = await reportOf([`--preload=${GUARD_PATH}`], shell);

      // Assert
      expect(report.hub).toEqual(Object.fromEntries(HUB_ENV_KEYS.map((key) => [key, null])));
      expect(report.home?.startsWith(tmpdir())).toBe(true);
      expect(report.homeExists).toBe(true);
      expect(report.bunOptions.split(/\s+/u)).toContain(`--preload=${GUARD_PATH}`);
      expect(report.child).toBe("1");
      expect(report.guarded).toBe(true);
    },
  );

  test("a process started with a test's own hub and temp home, the guard preloaded and no marker, keeps them", async () => {
    // Arrange: the shape a probe or a test harness spawns — an explicit env, no spread
    const home = await makeHome("guard-explicit");
    paths.push(home);
    const explicit = {
      PATH: process.env["PATH"] ?? "",
      CROSSCHECK_HUB_URL: "http://127.0.0.1:9",
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_HOME: home,
    };

    // Act
    const report = await reportOf([`--preload=${GUARD_PATH}`], explicit);

    // Assert: the test's hub and home survive; the guard still refuses the real one
    expect(report.hub["CROSSCHECK_HUB_URL"]).toBe("http://127.0.0.1:9");
    expect(report.hub["CROSSCHECK_API_KEY"]).toBe("test-key");
    expect(report.home).toBe(home);
    expect(report.refused).toContain("test network guard");
  });

  test("a bun child spawned with this run's env loads the guard through BUN_OPTIONS, with no flag of its own", async () => {
    // Act
    const report = await reportOf([], { ...process.env });

    // Assert: wired, refusing, and handed this run's scrubbed env and home
    expect(report.guarded).toBe(true);
    expect(report.refused).toContain("test network guard");
    expect(report.hub).toEqual(Object.fromEntries(HUB_ENV_KEYS.map((key) => [key, null])));
    expect(report.home).toBe(process.env["CROSSCHECK_HOME"] ?? "");
  });

  test("a child keeps whatever hub a test handed it — even a dead remote one: only the first run scrubs", async () => {
    // Act: a config test's dead host, which the first run's scrub would delete
    const report = await reportOf([], { ...process.env, CROSSCHECK_HUB_URL: "https://hub.invalid", CROSSCHECK_API_KEY: "k" });

    // Assert
    expect(report.hub["CROSSCHECK_HUB_URL"]).toBe("https://hub.invalid");
    expect(report.hub["CROSSCHECK_API_KEY"]).toBe("k");
    expect(report.guarded).toBe(true);
  });
});

/** Every Bun.spawn / Bun.spawnSync call site in a source text, with the text of its arguments. */
const spawnCalls = (source: string): readonly { readonly line: number; readonly args: string }[] =>
  [...source.matchAll(/\bBun\.spawn(?:Sync)?\(/gu)].map((match) => {
    const open = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    let close = source.length;
    for (let index = open; index < source.length; index += 1) {
      depth += source[index] === "(" ? 1 : source[index] === ")" ? -1 : 0;
      if (depth === 0) {
        close = index;
        break;
      }
    }
    return { line: source.slice(0, match.index).split("\n").length, args: source.slice(open + 1, close) };
  });

/** A bun child: its command is this runtime or `bun` itself — the children that run crosscheck code. */
const isBunChild = (args: string): boolean => /process\.execPath|\[\s*["']bun["']/u.test(args);

/** The call hands the child an env of its own (`env:` or the `env` shorthand). */
const passesEnv = (args: string): boolean => /\benv\s*[:,}]/u.test(args);

const testSources = async (dir: string): Promise<readonly string[]> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return entry.name === "node_modules" ? Promise.resolve([]) : testSources(path);
      }
      return Promise.resolve(/\.[cm]?tsx?$/u.test(entry.name) ? [path] : []);
    }),
  );
  return nested.flat();
};

describe("no test spawns a bun child that skips the guard (round 3, F-M3)", () => {
  test("every bun child in a test tree is spawned with an env, so the scrubbed env and the guard reach it", async () => {
    // Arrange: a child spawned with NO env gets the environment the runner
    // STARTED with — the shell's hub variables, no BUN_OPTIONS, no guard
    const packages = await readdir(join(REPO_ROOT, "packages"));
    const files = (await Promise.all(packages.map((name) => testSources(join(REPO_ROOT, "packages", name, "test"))))).flat();

    // Act
    const unguarded = (
      await Promise.all(
        files.map(async (file) =>
          spawnCalls(await readFile(file, "utf8"))
            .filter((call) => isBunChild(call.args) && !passesEnv(call.args))
            .map((call) => `${relative(REPO_ROOT, file)}:${String(call.line)}`),
        ),
      )
    ).flat();

    // Assert
    expect(files.length).toBeGreaterThan(0);
    expect(unguarded).toEqual([]);
  });

  test("the scan sees a bun child spawned without an env, and passes one spawned with it", () => {
    // Arrange: spelled in pieces, so the scan above does not find these in this file
    const spawn = ["Bun", "spawn"].join(".");
    const bare = `${spawn}({ cmd: [process.execPath, "worker.ts"], stdout: "pipe" })`;
    const guarded = `${spawn}({ cmd: [process.execPath, "worker.ts"], env: { ...process.env } })`;
    const shorthand = `${spawn}Sync({ cmd: ["bun", "x.ts"], env })`;
    const git = `${spawn}({ cmd: ["git", "status"] })`;

    // Act
    const flagged = [bare, guarded, shorthand, git].map((source) =>
      spawnCalls(source).some((call) => isBunChild(call.args) && !passesEnv(call.args)),
    );

    // Assert
    expect(flagged).toEqual([true, false, false, false]);
  });
});
