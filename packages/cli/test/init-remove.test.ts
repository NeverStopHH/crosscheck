/**
 * `crosscheck init --remove` — the project-side uninstall (pilot, 2026-10).
 *
 * A teammate ran `crosscheck init` in his checkout AND `crosscheck init
 * --global`; doctor's double-wiring WARN told him to keep the global install
 * and delete the gitignored project copy, and no command did that: `--remove`
 * existed only as `--global --remove`, which removes the side that should
 * stay. These tests pin the command that does: it strips exactly the entries
 * `--global --remove` would recognise, from THIS repo's files only, and
 * leaves the team's `.crosscheck.json`, every foreign entry and every
 * user-level file where they were.
 *
 * Real git repos (tracked vs ignored is git's answer), a temp HOME and a temp
 * CROSSCHECK_HOME. No hub: neither init nor remove talks to one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runCli } from "../src/index.ts";
import { git } from "../../connector-core/test/helpers.ts";
import {
  FOREIGN_MCP,
  FOREIGN_SETTINGS,
  INIT_ARGS,
  backupsIn,
  exists,
  fixture,
  read,
  removeFixtures,
  writeJson,
} from "./fixtures/init-remove.ts";

afterEach(removeFixtures);

describe("crosscheck init --remove", () => {
  test("strips crosscheck's hooks, statusline and mcp server and hands back the user's own files byte-identical", async () => {
    // Arrange
    const { repo, env, settingsPath, mcpPath } = await fixture("foreign");
    const settingsBefore = await writeJson(settingsPath, FOREIGN_SETTINGS);
    const mcpBefore = await writeJson(mcpPath, FOREIGN_MCP);
    expect((await runCli(INIT_ARGS, env, repo)).exitCode).toBe(0);

    // Act
    const result = await runCli(["init", "--remove"], env, repo);

    // Assert
    expect(result.exitCode).toBe(0);
    expect(await read(settingsPath)).toBe(settingsBefore);
    expect(await read(mcpPath)).toBe(mcpBefore);
    expect(result.stdout).toMatch(
      new RegExp(`${settingsPath}: removed \\d+ hook entries and the statusline; everything else in it is kept`),
    );
    expect(result.stdout).toContain(
      `${mcpPath}: removed the crosscheck mcp server; everything else in it is kept`,
    );
  });

  test("never touches .crosscheck.json, the team's committed repo connection, and says it stays", async () => {
    // Arrange
    const { repo, env, repoConfigPath } = await fixture("repo-config");
    expect((await runCli(INIT_ARGS, env, repo)).exitCode).toBe(0);
    const connectionBefore = await read(repoConfigPath);

    // Act
    const result = await runCli(["init", "--remove"], env, repo);

    // Assert
    expect(result.exitCode).toBe(0);
    expect(await read(repoConfigPath)).toBe(connectionBefore);
    expect(result.stdout).toContain(`left ${repoConfigPath} in place`);
  });

  test("deletes a file that held nothing but crosscheck's entries", async () => {
    // Arrange: init created both files from nothing
    const { repo, env, settingsPath, mcpPath } = await fixture("only-ours");
    expect((await runCli(INIT_ARGS, env, repo)).exitCode).toBe(0);

    // Act
    const result = await runCli(["init", "--remove"], env, repo);

    // Assert
    expect(result.exitCode).toBe(0);
    expect(await exists(settingsPath)).toBe(false);
    expect(await exists(mcpPath)).toBe(false);
    expect(result.stdout).toContain(`${mcpPath}: removed the crosscheck mcp server and deleted the file`);
    // Nothing of the user's was in them, so no backup litters the checkout:
    // `crosscheck init` writes the same content again.
    expect(await backupsIn(join(repo, ".claude"))).toEqual([]);
    expect(await backupsIn(repo)).toEqual([]);
  });

  test("a file without crosscheck entries is neither rewritten, reformatted nor deleted", async () => {
    // Arrange: 4-space formatting no crosscheck writer would produce, and an
    // empty object — the shape a deletion rule might mistake for a leftover
    const { repo, env, settingsPath, mcpPath } = await fixture("untouched");
    const settingsBefore = await writeJson(settingsPath, FOREIGN_SETTINGS, 4);
    const mcpBefore = await writeJson(mcpPath, {});

    // Act
    const result = await runCli(["init", "--remove"], env, repo);

    // Assert
    expect(result.exitCode).toBe(0);
    expect(await read(settingsPath)).toBe(settingsBefore);
    expect(await read(mcpPath)).toBe(mcpBefore);
    expect(await backupsIn(join(repo, ".claude"))).toEqual([]);
    expect(await backupsIn(repo)).toEqual([]);
    expect(result.stdout).toContain(`${settingsPath}: no crosscheck entries — left as is`);
  });

  test("a teammate's own statusline is kept and never reported as removed", async () => {
    // Arrange: init without --force-statusline leaves a foreign statusline alone
    const { repo, env, settingsPath } = await fixture("foreign-statusline");
    const settingsBefore = await writeJson(settingsPath, {
      statusLine: { type: "command", command: "my-statusline" },
    });
    expect((await runCli(INIT_ARGS, env, repo)).exitCode).toBe(0);

    // Act
    const result = await runCli(["init", "--remove"], env, repo);

    // Assert
    expect(await read(settingsPath)).toBe(settingsBefore);
    expect(result.stdout).toMatch(
      new RegExp(`${settingsPath}: removed \\d+ hook entries; everything else in it is kept`),
    );
  });

  test("a lone crosscheck statusline is removed without claiming hook entries", async () => {
    // Arrange: somebody hand-deleted the hooks and left our statusline
    const { repo, env, settingsPath } = await fixture("lone-statusline");
    await writeJson(settingsPath, {
      statusLine: { type: "command", command: "crosscheck statusline" },
    });

    // Act
    const result = await runCli(["init", "--remove"], env, repo);

    // Assert
    expect(await exists(settingsPath)).toBe(false);
    expect(result.stdout).toContain(
      `${settingsPath}: removed the statusline and deleted the file`,
    );
  });

  test("an unreadable user-level settings file is named, never reported as no install", async () => {
    // Arrange
    const { repo, home, env } = await fixture("user-unreadable");
    expect((await runCli(INIT_ARGS, env, repo)).exitCode).toBe(0);
    const userSettingsPath = join(home, ".claude", "settings.json");
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(userSettingsPath, "{ not json", "utf8");

    // Act
    const result = await runCli(["init", "--remove"], env, repo);

    // Assert
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`${userSettingsPath} is not valid json — left untouched`);
    expect(result.stdout).not.toContain("no user-level install");
    expect(await read(userSettingsPath)).toBe("{ not json");
  });

  test("a file that is not valid json refuses the whole removal before anything is written", async () => {
    // Arrange: a healthy install, then a broken .mcp.json beside it
    const { repo, env, settingsPath, mcpPath } = await fixture("corrupt");
    expect((await runCli(INIT_ARGS, env, repo)).exitCode).toBe(0);
    await writeFile(mcpPath, "{ not json", "utf8");
    const settingsBefore = await read(settingsPath);

    // Act
    const result = await runCli(["init", "--remove"], env, repo);

    // Assert
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(`${mcpPath} is not valid json — nothing was changed`);
    expect(await read(settingsPath)).toBe(settingsBefore);
    expect(await read(mcpPath)).toBe("{ not json");
  });

  test("leaves the user-level install byte-identical and says it still wires this repo", async () => {
    // Arrange: the pilot's double wiring — a global install AND a project one
    const { repo, home, env } = await fixture("double-wiring");
    expect((await runCli(["init", "--global", "--command-prefix", "crosscheck"], env, repo)).exitCode).toBe(0);
    expect((await runCli(INIT_ARGS, env, repo)).exitCode).toBe(0);
    const userSettingsPath = join(home, ".claude", "settings.json");
    const userMcpPath = join(home, ".claude.json");
    const userSettingsBefore = await read(userSettingsPath);
    const userMcpBefore = await read(userMcpPath);

    // Act
    const result = await runCli(["init", "--remove"], env, repo);

    // Assert
    expect(result.exitCode).toBe(0);
    expect(await read(userSettingsPath)).toBe(userSettingsBefore);
    expect(await read(userMcpPath)).toBe(userMcpBefore);
    expect(result.stdout).toContain(`left the user-level install in place: ${userSettingsPath} (`);
  });

  test("without a user-level install it says sessions here now load no crosscheck hooks", async () => {
    // Arrange
    const { repo, env } = await fixture("deaf");
    expect((await runCli(INIT_ARGS, env, repo)).exitCode).toBe(0);

    // Act
    const result = await runCli(["init", "--remove"], env, repo);

    // Assert
    expect(result.stdout).toContain("crosscheck init --global");
    expect(result.stdout).toContain("load no crosscheck hooks");
    expect(result.stdout).not.toContain("left the user-level install in place");
  });

  test("outside a git repository it says so and changes nothing", async () => {
    // Arrange: a directory that is not a repo, holding a file named like ours
    const { home, env } = await fixture("not-a-repo");
    const strayPath = join(home, ".mcp.json");
    const strayBefore = await writeJson(strayPath, {
      mcpServers: { crosscheck: { type: "stdio", command: "crosscheck", args: ["mcp"] } },
    });

    // Act
    const result = await runCli(["init", "--remove"], env, home);

    // Assert
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("not a git repository");
    expect(await read(strayPath)).toBe(strayBefore);
  });
});

describe("crosscheck init --remove and git", () => {
  test("a TRACKED settings file is called a change teammates receive, to commit or restore", async () => {
    // Arrange: the team committed the project install
    const { repo, env } = await fixture("tracked");
    expect((await runCli(INIT_ARGS, env, repo)).exitCode).toBe(0);
    await git(repo, ["add", ".claude/settings.json", ".mcp.json", ".crosscheck.json"]);
    await git(repo, ["commit", "-m", "wire crosscheck"]);

    // Act
    const result = await runCli(["init", "--remove"], env, repo);

    // Assert
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(".claude/settings.json is tracked by git");
    expect(result.stdout).toContain("git restore -- .claude/settings.json");
    expect(result.stdout).toContain(".mcp.json is tracked by git");
  });

  test("an IGNORED project copy changes nothing teammates share, so no commit advice is printed", async () => {
    // Arrange: the monorepo shape — both project files gitignored
    const { repo, env } = await fixture("ignored");
    await writeFile(join(repo, ".gitignore"), ".mcp.json\n.claude/\n", "utf8");
    await git(repo, ["add", ".gitignore"]);
    await git(repo, ["commit", "-m", "ignore local tooling"]);
    expect((await runCli(INIT_ARGS, env, repo)).exitCode).toBe(0);

    // Act
    const result = await runCli(["init", "--remove"], env, repo);

    // Assert
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("tracked by git");
    expect(result.stdout).not.toContain("git restore");
  });
});

describe("crosscheck init --remove and Cursor", () => {
  test("without --cursor the .cursor files stay byte-identical, and the output says how to include them", async () => {
    // Arrange
    const { repo, env } = await fixture("cursor-kept");
    expect((await runCli([...INIT_ARGS, "--cursor"], env, repo)).exitCode).toBe(0);
    const hooksPath = join(repo, ".cursor", "hooks.json");
    const cursorMcpPath = join(repo, ".cursor", "mcp.json");
    const hooksBefore = await read(hooksPath);
    const cursorMcpBefore = await read(cursorMcpPath);

    // Act
    const result = await runCli(["init", "--remove"], env, repo);

    // Assert
    expect(result.exitCode).toBe(0);
    expect(await read(hooksPath)).toBe(hooksBefore);
    expect(await read(cursorMcpPath)).toBe(cursorMcpBefore);
    expect(result.stdout).toContain(`left crosscheck's cursor entries in place — ${hooksPath}`);
    expect(result.stdout).toContain("--cursor");
  });

  test("with --cursor crosscheck's cursor entries go and the user's own cursor hook and server stay byte-identical", async () => {
    // Arrange: the team's own Cursor hook and server, then init --cursor
    const { repo, env } = await fixture("cursor-foreign");
    const hooksPath = join(repo, ".cursor", "hooks.json");
    const cursorMcpPath = join(repo, ".cursor", "mcp.json");
    const hooksBefore = await writeJson(hooksPath, {
      version: 1,
      hooks: { sessionStart: [{ command: "./scripts/cursor-audit.sh" }] },
    });
    const cursorMcpBefore = await writeJson(cursorMcpPath, FOREIGN_MCP);
    expect((await runCli([...INIT_ARGS, "--cursor"], env, repo)).exitCode).toBe(0);

    // Act
    const result = await runCli(["init", "--remove", "--cursor"], env, repo);

    // Assert
    expect(result.exitCode).toBe(0);
    expect(await read(hooksPath)).toBe(hooksBefore);
    expect(await read(cursorMcpPath)).toBe(cursorMcpBefore);
    expect(result.stdout).toMatch(
      new RegExp(`${hooksPath}: removed \\d+ cursor hook entries; everything else in it is kept`),
    );
  });

  test("with --cursor a hooks.json that keeps a key of the user's is rewritten, never deleted", async () => {
    // Arrange: no foreign hook, but a top-level key the skeleton does not have
    const { repo, env } = await fixture("cursor-own-key");
    const hooksPath = join(repo, ".cursor", "hooks.json");
    const hooksBefore = await writeJson(hooksPath, {
      version: 1,
      hooks: {},
      $comment: "team hooks live in scripts/cursor",
    });
    expect((await runCli([...INIT_ARGS, "--cursor"], env, repo)).exitCode).toBe(0);

    // Act
    const result = await runCli(["init", "--remove", "--cursor"], env, repo);

    // Assert
    expect(result.exitCode).toBe(0);
    expect(await read(hooksPath)).toBe(hooksBefore);
  });

  test("with --cursor a hooks.json init created is deleted, not left as an empty {version, hooks} skeleton", async () => {
    // Arrange: init --cursor created both Cursor files from nothing
    const { repo, env } = await fixture("cursor-only-ours");
    const hooksPath = join(repo, ".cursor", "hooks.json");
    const cursorMcpPath = join(repo, ".cursor", "mcp.json");
    expect((await runCli([...INIT_ARGS, "--cursor"], env, repo)).exitCode).toBe(0);

    // Act
    const result = await runCli(["init", "--remove", "--cursor"], env, repo);

    // Assert
    expect(result.exitCode).toBe(0);
    expect(await exists(hooksPath)).toBe(false);
    expect(await exists(cursorMcpPath)).toBe(false);
    expect(result.stdout).toMatch(
      new RegExp(`${hooksPath}: removed \\d+ cursor hook entries and deleted the file`),
    );
  });
});

describe("crosscheck init --remove and install-only flags", () => {
  test.each([
    [["--hub", "https://other.example.com"], "--hub"],
    [["--command-prefix", "crosscheck"], "--command-prefix"],
    [["--force-statusline"], "--force-statusline"],
    [["--global", "--force-statusline"], "--force-statusline"],
  ])("refuses %p with a usage error instead of ignoring %s, and removes nothing", async (extra, flag) => {
    // Arrange: an installed repo, so a removal would show
    const { repo, env, settingsPath } = await fixture("flag-refused");
    expect((await runCli(INIT_ARGS, env, repo)).exitCode).toBe(0);
    const settingsBefore = await read(settingsPath);

    // Act
    const result = await runCli(["init", "--remove", ...extra], env, repo);

    // Assert
    expect(result.exitCode).toBe(64);
    expect(result.stdout).toContain(`${flag} does not apply to --remove`);
    expect(await read(settingsPath)).toBe(settingsBefore);
  });
});

describe("crosscheck init --remove in the help", () => {
  test("init's usage and the top-level usage both list the project-side form", async () => {
    // Act
    const initHelp = await runCli(["init", "--help"], {}, "/");
    const topHelp = await runCli(["--help"], {}, "/");

    // Assert
    expect(initHelp.stdout).toContain("crosscheck init --remove [--cursor]");
    expect(topHelp.stdout).toContain("init --remove [--cursor]");
  });
});
