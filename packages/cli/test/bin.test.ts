import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN_PATH = resolve(import.meta.dir, "..", "src", "bin", "crosscheck.ts");
const RECORD_MODULES = resolve(import.meta.dir, "fixtures", "record-modules.ts");

/** Comfortably above STDIN_TIMEOUT_MS, far below a developer's patience. */
const EXIT_WAIT_MS = 6000;

describe("crosscheck entry point", () => {
  test("exits on its own when stdin is never closed", async () => {
    // Arrange: a caller that opens stdin and then stalls forever
    const proc = Bun.spawn({
      cmd: [process.execPath, BIN_PATH, "hook", "session-start"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, CROSSCHECK_DISABLED: "1" },
    });

    // Act
    const outcome = await Promise.race([
      proc.exited,
      new Promise<"timed out">((resolveRace) => {
        setTimeout(() => resolveRace("timed out"), EXIT_WAIT_MS);
      }),
    ]);
    if (outcome === "timed out") {
      proc.kill();
    }

    // Assert
    expect(outcome).toBe(0);
  });
});

/** Every module a `crosscheck hook <name>` process loaded, with empty stdin and the connector off. */
const modulesLoadedBy = async (args: readonly string[]): Promise<readonly string[]> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-modules-"));
  try {
    const log = join(dir, "modules.json");
    const proc = Bun.spawn({
      cmd: [process.execPath, "--preload", RECORD_MODULES, BIN_PATH, ...args],
      stdin: new TextEncoder().encode(""),
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, CROSSCHECK_DISABLED: "1", CX_MODULE_LOG: log },
    });
    await proc.exited;
    return JSON.parse(await readFile(log, "utf8")) as string[];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** Whether any loaded module lives under `fragment` (a path piece, `/`-separated). */
const loads = (modules: readonly string[], fragment: string): boolean =>
  modules.some((module) => module.replaceAll("\\", "/").includes(fragment));

describe("a hook process loads what its hook runs, and nothing more (batch-2 review, M6)", () => {
  test("PreToolUse loads its own handler — not the CLI, the MCP server or another hook", async () => {
    // Act
    const modules = await modulesLoadedBy(["hook", "pre-tool-use"]);

    // Assert
    expect(loads(modules, "/connector-claude/src/hooks/pre-tool-use.ts")).toBe(true);
    expect(loads(modules, "/cli/src/cli/index.ts")).toBe(false);
    expect(loads(modules, "/connector-core/src/mcp/server.ts")).toBe(false);
    expect(loads(modules, "/connector-claude/src/hooks/session-start.ts")).toBe(false);
    expect(loads(modules, "/connector-claude/src/hooks/user-prompt-submit.ts")).toBe(false);
  });
});