/**
 * EVERY CROSSCHECK PROCESS STARTS ISOLATED FROM THE REPO IT RUNS IN
 * (config/runtime-isolation.ts). The process-level proof — a bait repo's
 * bunfig preload and .env steering nothing in a real hook — lives in
 * packages/cli/test/e2e/bait-repo-isolation.e2e.test.ts; this pins the
 * pieces: the flags every self-spawn carries, the two launcher forms init
 * writes, and doctor's verdict on a hook command written before the flags.
 */
import { describe, expect, test } from "bun:test";

import { checkLauncherCommand } from "../src/config/launcher-check.ts";
import { resolveCommandPrefix, resolveMcpLauncher } from "../src/config/launcher.ts";
import {
  ISOLATED_BUNFIG_PATH,
  RUNTIME_ISOLATION_FLAGS,
  selfLaunch,
  selfSpawnCmd,
} from "../src/config/runtime-isolation.ts";

const ENTRY = new URL("../../cli/src/bin/crosscheck.ts", import.meta.url).pathname;
const KEYWORDS = ["hook", "statusline", "mcp"];
const PACKAGES_DIR = new URL("../../", import.meta.url).pathname;
const THIS_MODULE = "connector-core/src/config/runtime-isolation.ts";

/** Every source file a package ships: its `src/`, which is what pack-npm.ts packs. */
const shippedSources = async (): Promise<readonly string[]> => {
  const files: string[] = [];
  for await (const file of new Bun.Glob("*/src/**/*.{ts,tsx,js,cjs,mjs}").scan({ cwd: PACKAGES_DIR })) {
    files.push(file);
  }
  return files.sort();
};

const filesMatching = async (pattern: RegExp): Promise<readonly string[]> => {
  const hits: string[] = [];
  for (const file of await shippedSources()) {
    if (pattern.test(await Bun.file(`${PACKAGES_DIR}${file}`).text())) {
      hits.push(file);
    }
  }
  return hits;
};

describe("the isolation flags", () => {
  test("are --no-env-file and crosscheck's own packaged bunfig, which exists", async () => {
    // Act + Assert
    expect(RUNTIME_ISOLATION_FLAGS).toEqual(["--no-env-file", `--config=${ISOLATED_BUNFIG_PATH}`]);
    expect(await Bun.file(ISOLATED_BUNFIG_PATH).exists()).toBe(true);
    expect((await Bun.file(ISOLATED_BUNFIG_PATH).text()).replace(/^#.*$/gm, "").trim()).toBe("");
  });

  test("lead every self-spawn, before the entry and its arguments", () => {
    // Act
    const cmd = selfSpawnCmd("/opt/crosscheck/worker-entry.ts", ["--session", "s1"]);

    // Assert
    expect(cmd).toEqual([
      process.execPath,
      "--no-env-file",
      `--config=${ISOLATED_BUNFIG_PATH}`,
      "/opt/crosscheck/worker-entry.ts",
      "--session",
      "s1",
    ]);
  });

  test("are in the hook prefix and the MCP entry init writes for the entry form", () => {
    // Arrange
    const launcher = { kind: "entry", launch: selfLaunch(ENTRY) } as const;

    // Act
    const prefix = resolveCommandPrefix(launcher);
    const mcp = resolveMcpLauncher(launcher);

    // Assert
    expect(prefix).toBe(`${process.execPath} --no-env-file --config=${ISOLATED_BUNFIG_PATH} ${ENTRY}`);
    expect(mcp).toEqual({
      type: "stdio",
      command: process.execPath,
      args: ["--no-env-file", `--config=${ISOLATED_BUNFIG_PATH}`, ENTRY, "mcp"],
    });
  });
});

describe("the one place that names the running bun", () => {
  // Structural, not lexical (review round 2, N1 and R1): a grep for two
  // spellings of an unflagged spawn missed `[launcher.runtime, entry, "mcp"]`
  // in the ACP injector and `String(process.execPath)` in a worker. A start
  // that does not take its argv from runtime-isolation.ts cannot name the
  // runtime without one of these words appearing in its file.
  test("is runtime-isolation.ts: no other shipped source mentions the runtime's path", async () => {
    // Arrange
    const sources = await shippedSources();

    // Act
    const naming = await filesMatching(/execPath|argv0/);

    // Assert — the walk is real (it sees the worker spawn sites), and only
    // the isolation module names the runtime
    expect(sources.length).toBeGreaterThan(100);
    expect(sources).toContain("connector-claude/src/hooks/landing-fetch.ts");
    expect(sources).toContain("connector-acp/src/inject/launcher.ts");
    expect(naming).toEqual([THIS_MODULE]);
  });

  test("no shipped source starts bun by its bare name", async () => {
    // Act
    const byName = await filesMatching(/cmd:\s*\[\s*["'`]bun["'`]|spawn\(\s*["'`]bun["'`]/);

    // Assert
    expect(byName).toEqual([]);
  });

  test("the absolute launcher carries only the finished isolated start", async () => {
    // Act
    const launch = selfLaunch(ENTRY);

    // Assert — there is no bare runtime or entry field a caller could reassemble
    expect(launch).toEqual({ command: process.execPath, args: [...RUNTIME_ISOLATION_FLAGS, ENTRY] });
    expect(Object.keys(launch).sort()).toEqual(["args", "command"]);
  });
});

describe("doctor's launcher check on the isolation flags", () => {
  test("an entry-form hook command without them WARNs to rerun init", async () => {
    // Act
    const health = await checkLauncherCommand(`${process.execPath} ${ENTRY} hook session-start`, {}, KEYWORDS);

    // Assert
    expect(health.level).toBe("WARN");
    expect(health.detail).toContain("bunfig.toml preload and .env files run inside every hook");
    expect(health.detail).toContain("rerun crosscheck init");
  });

  test("the command init writes now passes", async () => {
    // Act
    const prefix = resolveCommandPrefix({ kind: "entry", launch: selfLaunch(ENTRY) });
    const health = await checkLauncherCommand(`${prefix} hook session-start`, {}, KEYWORDS);

    // Assert
    expect(health.level).toBe("PASS");
  });

  test("a --config naming a file that is gone FAILs, because bun would not start", async () => {
    // Act
    const health = await checkLauncherCommand(
      `${process.execPath} --no-env-file --config=/nonexistent/isolated.bunfig.toml ${ENTRY} hook session-start`,
      {},
      KEYWORDS,
    );

    // Assert
    expect(health.level).toBe("FAIL");
    expect(health.detail).toContain("/nonexistent/isolated.bunfig.toml does not exist");
  });
});
