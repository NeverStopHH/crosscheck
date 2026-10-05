/**
 * A user-level wiring file that EXISTS but cannot be read (EACCES) is not an
 * absent one (review 2026-10-05). `readTextOrNull` folded the two into one
 * null, so doctor reported "no user-level install", the mcp lines said no
 * server was registered anywhere, Cursor's section said "not installed", and
 * init never mentioned the double wiring — all about a file nobody had read.
 * Every surface now says the file could not be read and that whether a
 * user-level install exists is unknown.
 *
 * Root ignores permission bits, so these cannot be staged as root.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runCli } from "../src/index.ts";
import { mcpUsableCheck, runDoctor } from "../src/cli/doctor.ts";
import { renderRepoConfig } from "@crosscheck/connector-core/config/repo-config.ts";
import {
  INIT_ARGS,
  OWNED_HOOKS,
  OWNED_MCP_SERVER,
  fixture,
  removeFixtures,
  tempDir,
  writeJson,
} from "./fixtures/init-remove.ts";

const locked: string[] = [];

afterEach(async () => {
  await Promise.all(locked.splice(0, locked.length).map((path) => chmod(path, 0o644)));
  await removeFixtures();
});

const isRoot = process.getuid?.() === 0;

/** Writes `value` to `path` and takes every permission away from it. */
const writeLocked = async (path: string, value: unknown): Promise<void> => {
  await writeJson(path, value);
  await chmod(path, 0o000);
  locked.push(path);
};

const UNKNOWN = "could not be read — whether a user-level install exists is unknown";

/** A connected repo (so doctor runs its full branch) on a temp HOME. */
const connectedRepo = async (label: string) => {
  const repo = await fixture(label);
  await writeFile(repo.repoConfigPath, renderRepoConfig("http://127.0.0.1:9"), "utf8");
  return { ...repo, env: { ...repo.env, CROSSCHECK_HUB_URL: "http://127.0.0.1:9" } };
};

describe.skipIf(isRoot)("an unreadable ~/.claude/settings.json", () => {
  test("doctor names it as unknown instead of reporting no user-level install", async () => {
    // Arrange: the Ken shape — a folder with no repo, a locked user install
    const home = await tempDir("unreadable-ken-home");
    const workspace = await tempDir("unreadable-ken-workspace");
    const userSettingsPath = join(home, ".claude", "settings.json");
    await writeLocked(userSettingsPath, { hooks: OWNED_HOOKS });
    const env = { HOME: home, CROSSCHECK_HOME: join(home, ".crosscheck") };

    // Act
    const result = await runDoctor(env, workspace, async () => null);

    // Assert
    expect(result.stdout).toContain(`${userSettingsPath} ${UNKNOWN}`);
    expect(result.stdout).not.toContain("no user-level install");
  });

  test("doctor never calls it absent where project hooks are wired", async () => {
    // Arrange
    const { repo, home, env } = await connectedRepo("unreadable-project");
    expect((await runCli(INIT_ARGS, env, repo)).exitCode).toBe(0);
    const userSettingsPath = join(home, ".claude", "settings.json");
    await writeLocked(userSettingsPath, { hooks: OWNED_HOOKS });

    // Act
    const result = await runDoctor(env, repo, async () => null);

    // Assert
    expect(result.stdout).toContain(`${userSettingsPath} ${UNKNOWN}`);
    expect(result.stdout).not.toContain("absent (project hooks cover this repo");
  });

  test("doctor's hooks line for a repo without project hooks says user-scope coverage is unknown", async () => {
    // Arrange: connected, no project settings, the user install locked
    const { repo, home, env } = await connectedRepo("unreadable-hooks");
    await writeLocked(join(home, ".claude", "settings.json"), { hooks: OWNED_HOOKS });

    // Act
    const result = await runDoctor(env, repo, async () => null);

    // Assert
    expect(result.stdout).toContain("whether user-scope hooks cover this repo is unknown");
    expect(result.stdout).not.toContain("FAIL  hooks registered");
    expect(result.stdout).toContain("whether a user-scope statusline applies is unknown");
  });

  test("init's double-wiring note says it is unknown instead of saying nothing", async () => {
    // Arrange
    const { repo, home, env } = await fixture("unreadable-init");
    const userSettingsPath = join(home, ".claude", "settings.json");
    await writeLocked(userSettingsPath, { hooks: OWNED_HOOKS });

    // Act
    const result = await runCli(INIT_ARGS, env, repo);

    // Assert
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`${userSettingsPath} ${UNKNOWN}`);
  });
});

describe.skipIf(isRoot)("an unreadable ~/.claude.json", () => {
  test("doctor's mcp lines say user-scope registration is unknown, never 'not registered in either scope'", async () => {
    // Arrange: connected, no project .mcp.json, the user-scope mcp file locked
    const { repo, home, env } = await connectedRepo("unreadable-mcp");
    await writeLocked(join(home, ".claude.json"), {
      mcpServers: { crosscheck: OWNED_MCP_SERVER },
    });

    // Act
    const result = await runDoctor(env, repo, async () => null);

    // Assert
    expect(result.stdout).toContain("whether the tools are registered at user scope is unknown");
    expect(result.stdout).not.toContain("no mcp server is registered in either scope");
    expect(result.stdout).not.toContain("FAIL  mcp tools registered");
  });
});

describe("doctor's mcp usable line with ~/.claude.json unread", () => {
  // Pure: with an unreachable hub the line is decided before `registered` is
  // ever read, so the end-to-end runs above cannot reach this branch.
  test("is a WARN naming the unread file, never the 'in either scope' FAIL", () => {
    // Arrange
    const unknown = "/home/dev/.claude.json could not be read — whether the tools are registered at user scope is unknown";

    // Act
    const result = mcpUsableCheck({
      configured: true,
      hubUrl: "https://hub.example.com",
      hub: { ok: true, status: 200, kind: "http" },
      registered: false,
      userScopeUnknown: unknown,
      probe: { kind: "not-probed", why: "the verdict is already decided" },
    });

    // Assert
    expect(result.level).toBe("WARN");
    expect(result.detail).toContain(unknown);
    expect(result.detail).not.toContain("in either scope");
  });
});

describe.skipIf(isRoot)("an unreadable ~/.cursor/hooks.json", () => {
  test("doctor's Cursor section names it instead of saying Cursor capture is not installed", async () => {
    // Arrange: connected, no project .cursor, the user-level Cursor hooks locked
    const { repo, home, env } = await connectedRepo("unreadable-cursor");
    const cursorHooksPath = join(home, ".cursor", "hooks.json");
    await mkdir(join(home, ".cursor"), { recursive: true });
    await writeLocked(cursorHooksPath, {
      version: 1,
      hooks: { sessionStart: [{ command: "crosscheck cursor-hook sessionStart" }] },
    });

    // Act
    const result = await runDoctor(env, repo, async () => null);

    // Assert
    expect(result.stdout).toContain(`${cursorHooksPath} could not be read`);
    expect(result.stdout).not.toContain("not installed — crosscheck init --cursor");
  });

  test("doctor's Cursor mcp line names a locked user-level mcp.json instead of 'not found'", async () => {
    // Arrange: a readable user-level Cursor install whose mcp.json is locked
    const { repo, home, env } = await connectedRepo("unreadable-cursor-mcp");
    const cursorMcpPath = join(home, ".cursor", "mcp.json");
    await writeJson(join(home, ".cursor", "hooks.json"), {
      version: 1,
      hooks: { sessionStart: [{ command: "crosscheck cursor-hook sessionStart" }] },
    });
    await writeLocked(cursorMcpPath, { mcpServers: { crosscheck: OWNED_MCP_SERVER } });

    // Act
    const result = await runDoctor(env, repo, async () => null);

    // Assert
    expect(result.stdout).toContain(`${cursorMcpPath} could not be read`);
    expect(result.stdout).not.toContain(`${cursorMcpPath} not found`);
  });
});
