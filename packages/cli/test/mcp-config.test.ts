/**
 * `.mcp.json`, which is how a teammate gets the tools on `git pull`.
 *
 * TWO PROPERTIES, AND ONE OF THEM HAS ALREADY GONE WRONG ONCE IN THIS REPO.
 *
 * 1. NON-DESTRUCTIVE. A repo's `.mcp.json` is shared: other MCP servers live in
 *    it, and clobbering them is how an install gets reverted (DESIGN.md §2:
 *    install = one PR). Same rule `.claude/settings.json` obeys, same reason.
 *
 * 2. NO FETCHABLE PACKAGE NAME. `init` resolves its own absolute entry point
 *    rather than emitting something a package manager would go and download. An
 *    earlier version of the hook installer emitted an UNPUBLISHED npm name,
 *    which is a dependency-confusion hole: whoever claims it on npm gets code
 *    execution in every session of every machine that ran `init`. cli.test.ts
 *    pins that for the hook commands; this pins the same property for the MCP
 *    entry, which is a second place with the same temptation and is not covered
 *    by that test.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { MCP_CONFIG_FILE, MCP_SERVER_KEY, runCli } from "../src/index.ts";
import { isOwnedMcpEntry, mergeMcpConfig } from "@crosscheck/connector-core/config/mcp-config.ts";
import type { McpServerEntry } from "@crosscheck/connector-core/config/mcp-config.ts";
import type { Env } from "../src/index.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const HUB_URL = "https://hub.example.com";
const cleanups: string[] = [];

afterAll(async () => {
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
});

const OURS: McpServerEntry = {
  type: "stdio",
  command: "/opt/bun/bin/bun",
  args: ["/repo/packages/connector-claude/src/bin/crosscheck.ts", "mcp"],
};

const FOREIGN = {
  type: "stdio",
  command: "npx",
  args: ["-y", "@someone/other-mcp"],
};

interface McpConfigShape {
  readonly mcpServers?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

const serversOf = (config: Record<string, unknown>): Record<string, unknown> =>
  (config as McpConfigShape).mcpServers ?? {};

describe("mergeMcpConfig", () => {
  test("creates the file's shape when there is nothing there yet", () => {
    // Act
    const merged = mergeMcpConfig({}, OURS);

    // Assert
    expect(serversOf(merged)[MCP_SERVER_KEY]).toEqual(OURS);
  });

  test("leaves another team's mcp server exactly as it found it", () => {
    // Arrange: the case that decides whether an install survives review
    const existing = { mcpServers: { "other-mcp": FOREIGN } };

    // Act
    const merged = mergeMcpConfig(existing, OURS);

    // Assert
    expect(serversOf(merged)["other-mcp"]).toEqual(FOREIGN);
    expect(serversOf(merged)[MCP_SERVER_KEY]).toEqual(OURS);
  });

  test("leaves unrelated top-level keys alone", () => {
    // Arrange: the file format may grow keys this connector has never heard of
    const existing = { mcpServers: {}, someFutureKey: { a: 1 } };

    // Act
    const merged = mergeMcpConfig(existing, OURS);

    // Assert
    expect(merged["someFutureKey"]).toEqual({ a: 1 });
  });

  test("replaces its OWN entry rather than duplicating it", () => {
    // Arrange: a second `init`, e.g. after moving the checkout
    const stale = {
      mcpServers: {
        [MCP_SERVER_KEY]: {
          type: "stdio",
          command: "/old/path/bun",
          args: ["/old/path/crosscheck.ts", "mcp"],
        },
      },
    };

    // Act
    const merged = mergeMcpConfig(stale, OURS);

    // Assert
    expect(Object.keys(serversOf(merged))).toEqual([MCP_SERVER_KEY]);
    expect(serversOf(merged)[MCP_SERVER_KEY]).toEqual(OURS);
  });

  test("does not mutate the object it was given", () => {
    // Arrange: the same immutability rule the settings merge obeys — a caller
    // that wants to write a backup first must still have the original
    const existing = { mcpServers: { "other-mcp": FOREIGN } };
    const before = JSON.stringify(existing);

    // Act
    mergeMcpConfig(existing, OURS);

    // Assert
    expect(JSON.stringify(existing)).toBe(before);
  });

  test("survives an mcpServers key that is not an object", () => {
    // Arrange: a hand-edited file can hold anything
    const existing = { mcpServers: "nonsense" };

    // Act
    const merged = mergeMcpConfig(existing, OURS);

    // Assert
    expect(serversOf(merged)[MCP_SERVER_KEY]).toEqual(OURS);
  });
});

describe("isOwnedMcpEntry", () => {
  test.each([
    ["absolute entry point", OURS],
    [
      "crosscheck on PATH",
      { type: "stdio", command: "crosscheck", args: ["mcp"] },
    ],
    [
      "shell-wrapped operator prefix",
      {
        type: "stdio",
        command: "sh",
        args: ["-c", "my-launcher crosscheck mcp"],
      },
    ],
  ])("recognises its own entry: %s", (_label, entry) => {
    expect(isOwnedMcpEntry(entry)).toBe(true);
  });

  test.each([
    ["a foreign server", FOREIGN],
    ["a string", "crosscheck mcp"],
    ["null", null],
    ["an entry with no args", { type: "stdio", command: "crosscheck" }],
  ])("does not claim %s", (_label, entry) => {
    expect(isOwnedMcpEntry(entry)).toBe(false);
  });
});

describe("crosscheck init writes .mcp.json", () => {
  const initInRepo = async (
    label: string,
  ): Promise<{ repo: string; raw: string }> => {
    const home = await makeHome(label);
    const repo = await makeRepo(label);
    cleanups.push(home, repo);
    const env: Env = {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: HUB_URL,
      CROSSCHECK_API_KEY: "cx_test_key",
      PATH: "/nonexistent-bin",
    };
    const result = await runCli(["init"], env, repo);
    expect(result.exitCode).toBe(0);
    return { repo, raw: await Bun.file(join(repo, MCP_CONFIG_FILE)).text() };
  };

  test("registers the crosscheck server pointing at a real entry point", async () => {
    // Act
    const { raw } = await initInRepo("mcp-init");

    // Assert
    const config = JSON.parse(raw) as Record<string, unknown>;
    const entry = serversOf(config)[MCP_SERVER_KEY];
    expect(entry).toBeDefined();
    expect(isOwnedMcpEntry(entry)).toBe(true);
    expect(JSON.stringify(entry)).toContain("mcp");
  });

  test("never emits a package name a package manager would fetch", async () => {
    // Arrange: THE dependency-confusion property. `PATH` above names a
    // directory that does not exist, so `crosscheck` is definitely not on it —
    // which is exactly the situation that tempted the earlier version of the
    // hook installer into emitting an unpublished npm name.
    // Act
    const { raw } = await initInRepo("mcp-init-noname");

    // Assert
    expect(raw).not.toContain("@crosscheck/");
    expect(raw).not.toContain("npx");
    expect(raw).not.toContain("bunx");
    // And what it emitted instead is an absolute path that exists on this disk
    const config = JSON.parse(raw) as Record<string, unknown>;
    const entry = serversOf(config)[MCP_SERVER_KEY] as {
      command: string;
      args: string[];
    };
    expect(entry.command.startsWith("/")).toBe(true);
    expect(await Bun.file(entry.args[0] ?? "").exists()).toBe(true);
  });

  test("says what it wrote, so a developer knows to commit it", async () => {
    // Arrange: committing this file is the whole delivery mechanism — a
    // teammate gets the tools on `git pull` and nowhere else
    // Act
    const home = await makeHome("mcp-init-says");
    const repo = await makeRepo("mcp-init-says");
    cleanups.push(home, repo);
    const result = await runCli(
      ["init"],
      {
        CROSSCHECK_HOME: home,
        CROSSCHECK_HUB_URL: HUB_URL,
        CROSSCHECK_API_KEY: "cx_test_key",
      },
      repo,
    );

    // Assert
    expect(result.stdout).toContain(MCP_CONFIG_FILE);
  });

  test("leaves a teammate's existing mcp server in place", async () => {
    // Arrange: the real repo case — somebody already committed an .mcp.json
    const home = await makeHome("mcp-init-merge");
    const repo = await makeRepo("mcp-init-merge");
    cleanups.push(home, repo);
    await Bun.write(
      join(repo, MCP_CONFIG_FILE),
      `${JSON.stringify({ mcpServers: { "other-mcp": FOREIGN } }, null, 2)}\n`,
    );

    // Act
    await runCli(
      ["init"],
      {
        CROSSCHECK_HOME: home,
        CROSSCHECK_HUB_URL: HUB_URL,
        CROSSCHECK_API_KEY: "cx_test_key",
      },
      repo,
    );

    // Assert
    const config = JSON.parse(
      await Bun.file(join(repo, MCP_CONFIG_FILE)).text(),
    ) as Record<string, unknown>;
    expect(serversOf(config)["other-mcp"]).toEqual(FOREIGN);
    expect(serversOf(config)[MCP_SERVER_KEY]).toBeDefined();
  });

  test("refuses to touch an .mcp.json it cannot parse", async () => {
    // Arrange: the same rule init already applies to settings.json — a file it
    // cannot read is a file it must not overwrite
    const home = await makeHome("mcp-init-broken");
    const repo = await makeRepo("mcp-init-broken");
    cleanups.push(home, repo);
    const path = join(repo, MCP_CONFIG_FILE);
    await Bun.write(path, "{ not json");

    // Act
    const result = await runCli(
      ["init"],
      {
        CROSSCHECK_HOME: home,
        CROSSCHECK_HUB_URL: HUB_URL,
        CROSSCHECK_API_KEY: "cx_test_key",
      },
      repo,
    );

    // Assert: nothing changed, and it said so
    expect(result.stdout).toContain(MCP_CONFIG_FILE);
    expect(result.stdout).toContain("not valid json");
    expect(await Bun.file(path).text()).toBe("{ not json");
  });
});
