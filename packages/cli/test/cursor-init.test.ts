/**
 * `crosscheck init --cursor` — the COMPOSED install (design §3.4): one
 * command, both connectors, all-or-nothing. The Cursor halves' own merge
 * mechanics live in connector-cursor/test/init.test.ts; what THIS file pins
 * is the composition: both file pairs written together, the same one-PR
 * story in stdout, and an unparseable Cursor file aborting BEFORE any
 * Claude file is touched.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runCli } from "../src/cli/index.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REMOTE = "git@github.com:acme/api.git";
const HUB_URL = "http://127.0.0.1:19999";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
  cleanups.length = 0;
});

const fixture = async (label: string) => {
  const repo = await makeRepo(label, { remote: REMOTE });
  const home = await makeHome(label);
  cleanups.push(repo, home);
  return {
    repo,
    home,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: HUB_URL,
      CROSSCHECK_API_KEY: "test-key",
    },
  };
};

describe("init --cursor", () => {
  test("writes the Claude pair AND the Cursor pair, and says to commit both", async () => {
    // Arrange
    const { repo, env } = await fixture("compose");

    // Act
    const result = await runCli(["init", "--cursor"], env, repo);

    // Assert
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(join(repo, ".claude", "settings.json"));
    expect(result.stdout).toContain(join(repo, ".cursor", "hooks.json"));
    expect(result.stdout).toContain(join(repo, ".cursor", "mcp.json"));
    expect(result.stdout).toContain("commit the .cursor files too");
    // Trial finding #8: the --cursor variant carries the restart hint too
    // (Cursor hot-reloads its own hook files; Claude Code does not).
    expect(result.stdout).toContain(
      "hooks load when an agent or editor process starts",
    );
    const hooks = JSON.parse(
      await Bun.file(join(repo, ".cursor", "hooks.json")).text(),
    ) as { version: number; hooks: Record<string, readonly { command: string; timeout: number }[]> };
    expect(hooks.version).toBe(1);
    expect(hooks.hooks["sessionStart"]?.[0]?.command).toContain(
      "cursor-hook sessionStart",
    );
    // The documented per-script timeout, in seconds — and never failClosed.
    expect(hooks.hooks["sessionEnd"]?.[0]?.timeout).toBe(10);
    expect(JSON.stringify(hooks).includes("failClosed")).toBe(false);
    const mcp = JSON.parse(
      await Bun.file(join(repo, ".cursor", "mcp.json")).text(),
    ) as { mcpServers: Record<string, unknown> };
    expect(mcp.mcpServers["crosscheck"]).toBeDefined();
  });

  test("without --cursor nothing under .cursor/ is created — the flag composes, never leaks", async () => {
    // Arrange
    const { repo, env } = await fixture("noflag");

    // Act
    const result = await runCli(["init"], env, repo);

    // Assert
    expect(result.exitCode).toBe(0);
    expect(await Bun.file(join(repo, ".cursor", "hooks.json")).exists()).toBe(false);
  });

  test("an unparseable .cursor/hooks.json aborts the WHOLE init before any Claude file is written", async () => {
    // Arrange
    const { repo, env } = await fixture("abort");
    await mkdir(join(repo, ".cursor"), { recursive: true });
    await writeFile(join(repo, ".cursor", "hooks.json"), "{ broken", "utf8");

    // Act
    const result = await runCli(["init", "--cursor"], env, repo);

    // Assert: aborted, named, and NOTHING was changed — the Claude settings
    // file must not exist either (all-or-nothing across connectors).
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("nothing was changed");
    expect(
      await Bun.file(join(repo, ".claude", "settings.json")).exists(),
    ).toBe(false);
    expect(await Bun.file(join(repo, ".mcp.json")).exists()).toBe(false);
  });

  test("re-running is idempotent — no duplicate cursor entries", async () => {
    // Arrange
    const { repo, env } = await fixture("idem");
    await runCli(["init", "--cursor"], env, repo);

    // Act
    const result = await runCli(["init", "--cursor"], env, repo);

    // Assert
    expect(result.exitCode).toBe(0);
    const hooks = JSON.parse(
      await Bun.file(join(repo, ".cursor", "hooks.json")).text(),
    ) as { hooks: Record<string, readonly unknown[]> };
    expect(hooks.hooks["sessionStart"]?.length).toBe(1);
    expect(hooks.hooks["stop"]?.length).toBe(1);
  });
});
