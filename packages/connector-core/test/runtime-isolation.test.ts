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
  selfSpawnCmd,
} from "../src/config/runtime-isolation.ts";

const ENTRY = new URL("../../cli/src/bin/crosscheck.ts", import.meta.url).pathname;
const KEYWORDS = ["hook", "statusline", "mcp"];

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
    const launcher = { kind: "entry", runtime: process.execPath, entry: ENTRY } as const;

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
    const prefix = resolveCommandPrefix({ kind: "entry", runtime: process.execPath, entry: ENTRY });
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
