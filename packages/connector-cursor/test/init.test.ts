/**
 * `init --cursor`'s Cursor half (design §3.4): the non-destructive merge
 * discipline on the documented hooks.json shape, and the prepare/apply
 * split that keeps the composed install all-or-nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  CURSOR_HOOKS_VERSION,
  CURSOR_HOOK_TIMEOUT_SECONDS,
} from "../src/constants.ts";
import {
  buildCursorHooksPlan,
  isOwnedCursorCommand,
  mergeCursorHooks,
} from "../src/init/hooks-merge.ts";
import { prepareCursorInit } from "../src/init/init.ts";
import { CURSOR_HOOK_EVENTS } from "../src/payload.ts";
import { HOOKS_JSON_EXAMPLE } from "./fixtures/cursor-contract/payloads.ts";
import { makeRepo } from "../../connector-core/test/helpers.ts";

const MCP_ENTRY = {
  type: "stdio",
  command: "crosscheck",
  args: ["mcp"],
} as const;

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
  cleanups.length = 0;
});

describe("mergeCursorHooks", () => {
  test("a fresh file gets all eight events, the documented version, an explicit timeout — and never failClosed", () => {
    // Act
    const merged = mergeCursorHooks({}, buildCursorHooksPlan("crosscheck"));

    // Assert
    expect(merged["version"]).toBe(CURSOR_HOOKS_VERSION);
    const hooks = merged["hooks"] as Record<string, readonly { command: string; timeout: number }[]>;
    for (const event of CURSOR_HOOK_EVENTS) {
      expect(hooks[event]).toEqual([
        {
          command: `crosscheck cursor-hook ${event}`,
          timeout: CURSOR_HOOK_TIMEOUT_SECONDS,
        },
      ]);
    }
    // The fail-open pin: no entry this installer writes may ever fail closed.
    expect(JSON.stringify(merged).includes("failClosed")).toBe(false);
  });

  test("foreign entries and foreign events survive; ours append after them", () => {
    // Arrange: the documented example file — a foreign sessionStart script
    // and a whole foreign event (beforeShellExecution).
    const existing = JSON.parse(JSON.stringify(HOOKS_JSON_EXAMPLE)) as Record<string, unknown>;

    // Act
    const merged = mergeCursorHooks(existing, buildCursorHooksPlan("crosscheck"));

    // Assert
    const hooks = merged["hooks"] as Record<string, readonly { command: string }[]>;
    expect(hooks["sessionStart"]?.map((entry) => entry.command)).toEqual([
      "./hooks/session-init.sh",
      "crosscheck cursor-hook sessionStart",
    ]);
    // The foreign event is untouched, matcher and all.
    expect(hooks["beforeShellExecution"]).toEqual(
      HOOKS_JSON_EXAMPLE.hooks.beforeShellExecution as never,
    );
  });

  test("re-running is idempotent — owned entries are replaced, never duplicated", () => {
    // Act
    const once = mergeCursorHooks({}, buildCursorHooksPlan("crosscheck"));
    const twice = mergeCursorHooks(once, buildCursorHooksPlan("crosscheck"));

    // Assert
    expect(twice).toEqual(once);
  });

  test("a launcher change replaces the owned entry in place", () => {
    // Arrange
    const oldInstall = mergeCursorHooks({}, buildCursorHooksPlan("crosscheck"));

    // Act
    const newPrefix = "bun /home/dev/tools/crosscheck.ts";
    const migrated = mergeCursorHooks(oldInstall, buildCursorHooksPlan(newPrefix));

    // Assert
    const hooks = migrated["hooks"] as Record<
      string,
      readonly { command: string; timeout: number }[]
    >;
    expect(hooks["stop"]).toEqual([
      { command: `${newPrefix} cursor-hook stop`, timeout: CURSOR_HOOK_TIMEOUT_SECONDS },
    ]);
  });

  test("a foreign numeric version is preserved — a future Cursor knows more than we do", () => {
    const merged = mergeCursorHooks(
      { version: 2 },
      buildCursorHooksPlan("crosscheck"),
    );
    expect(merged["version"]).toBe(2);
  });

  test("isOwnedCursorCommand recognises every launcher form and rejects foreign scripts", () => {
    expect(isOwnedCursorCommand("crosscheck cursor-hook stop")).toBe(true);
    expect(
      isOwnedCursorCommand("bun /abs/path/src/bin/crosscheck.ts cursor-hook stop"),
    ).toBe(true);
    expect(isOwnedCursorCommand("./hooks/audit.sh")).toBe(false);
    // The Claude subcommands are NOT cursor-owned (different registry).
    expect(isOwnedCursorCommand("crosscheck hook session-start")).toBe(false);
  });
});

describe("prepareCursorInit", () => {
  test("refuses an unparseable hooks.json BEFORE anything is written", async () => {
    // Arrange
    const repo = await makeRepo("init-refuse");
    cleanups.push(repo);
    await mkdir(join(repo, ".cursor"), { recursive: true });
    await writeFile(join(repo, ".cursor", "hooks.json"), "{ not json", "utf8");

    // Act
    const plan = await prepareCursorInit(repo, "crosscheck", MCP_ENTRY);

    // Assert
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain("hooks.json");
    expect(plan.reason).toContain("nothing was changed");
  });

  test("apply writes both files, backs up preexisting ones, and lands the shared mcp entry", async () => {
    // Arrange: a preexisting hooks.json that must be preserved AND backed up.
    const repo = await makeRepo("init-apply");
    cleanups.push(repo);
    await mkdir(join(repo, ".cursor"), { recursive: true });
    await writeFile(
      join(repo, ".cursor", "hooks.json"),
      JSON.stringify(HOOKS_JSON_EXAMPLE),
      "utf8",
    );

    // Act
    const plan = await prepareCursorInit(repo, "crosscheck", MCP_ENTRY);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const written = await plan.apply();

    // Assert
    expect(written).toEqual([
      join(repo, ".cursor", "hooks.json"),
      join(repo, ".cursor", "mcp.json"),
    ]);
    const hooksFile = JSON.parse(
      await Bun.file(join(repo, ".cursor", "hooks.json")).text(),
    ) as { hooks: Record<string, readonly { command: string }[]> };
    expect(
      hooksFile.hooks["sessionStart"]?.some((entry) =>
        isOwnedCursorCommand(entry.command),
      ),
    ).toBe(true);
    const mcpFile = JSON.parse(
      await Bun.file(join(repo, ".cursor", "mcp.json")).text(),
    ) as { mcpServers: Record<string, unknown> };
    expect(mcpFile.mcpServers["crosscheck"]).toEqual(MCP_ENTRY);
    // Timestamped backup beside the original it rewrote.
    const backups = (await readdir(join(repo, ".cursor"))).filter((name) =>
      name.startsWith("hooks.json.bak-"),
    );
    expect(backups.length).toBe(1);
  });
});
