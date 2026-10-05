/**
 * `crosscheck init --remove` must never change a file that is not this
 * repo's own project copy, never leave a secret-bearing file in the work
 * tree, and never claim a change it did not make (review 2026-10-05).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";

import { runCli } from "../src/index.ts";
import { git } from "../../connector-core/test/helpers.ts";
import {
  INIT_ARGS,
  OWNED_HOOKS,
  OWNED_STATUSLINE,
  exists,
  fixture,
  read,
  removeFixtures,
  tempDir,
  writeJson,
} from "./fixtures/init-remove.ts";

afterEach(removeFixtures);

describe("a project copy that is really the user-level install", () => {
  test("init --remove refuses and changes nothing when $HOME itself is the git work tree", async () => {
    // Arrange: a dotfiles user — HOME is a repo, the cwd is a plain folder in it
    const home = await tempDir("home-repo");
    await git(home, ["init", "--initial-branch=main"]);
    const userSettingsPath = join(home, ".claude", "settings.json");
    const userSettingsBefore = await writeJson(userSettingsPath, {
      hooks: OWNED_HOOKS,
      statusLine: OWNED_STATUSLINE,
      model: "opus",
    });
    const project = join(home, "code", "scratch");
    await mkdir(project, { recursive: true });
    const env = { HOME: home, CROSSCHECK_HOME: join(home, ".crosscheck") };

    // Act
    const result = await runCli(["init", "--remove", "--cursor"], env, project);

    // Assert
    expect(result.exitCode).toBe(1);
    expect(await read(userSettingsPath)).toBe(userSettingsBefore);
    expect(result.stdout).toContain(`${userSettingsPath} is your user-level wiring`);
    expect(result.stdout).toContain("nothing was changed");
    expect(result.stdout).toContain("`crosscheck init --global --remove`");
  });

  test("init --remove refuses when the repo's settings file is a symlink into ~/.claude", async () => {
    // Arrange: an ordinary repo whose project settings link to the user's
    const { repo, home, env, settingsPath } = await fixture("link-to-home");
    const userSettingsPath = join(home, ".claude", "settings.json");
    const userSettingsBefore = await writeJson(userSettingsPath, { hooks: OWNED_HOOKS });
    await mkdir(join(repo, ".claude"), { recursive: true });
    await symlink(userSettingsPath, settingsPath);

    // Act
    const result = await runCli(["init", "--remove"], env, repo);

    // Assert
    expect(result.exitCode).toBe(1);
    expect(await read(userSettingsPath)).toBe(userSettingsBefore);
    expect(result.stdout).toContain(`(${userSettingsPath})`);
    expect(result.stdout).toContain("`crosscheck init --global --remove`");
  });

  test("crosscheck init refuses to write the user-level settings as a project copy when $HOME is the work tree", async () => {
    // Arrange
    const home = await tempDir("home-repo-init");
    await git(home, ["init", "--initial-branch=main"]);
    const project = join(home, "code", "scratch");
    await mkdir(project, { recursive: true });
    const env = {
      HOME: home,
      CROSSCHECK_HOME: join(home, ".crosscheck"),
      CROSSCHECK_HUB_URL: "https://hub.example.com",
      CROSSCHECK_API_KEY: "test-key",
    };

    // Act
    const result = await runCli(INIT_ARGS, env, project);

    // Assert: no user-level file written, and HOME not connected as a repo
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("is your user-level wiring");
    expect(result.stdout).toContain("`crosscheck init --global`");
    expect(await exists(join(home, ".claude", "settings.json"))).toBe(false);
    expect(await exists(join(home, ".crosscheck.json"))).toBe(false);
  });
});

describe("a symlinked project file", () => {
  const linkedRepo = async (label: string, target: Record<string, unknown>) => {
    const owner = await fixture(`${label}-owner`);
    const linked = await fixture(label);
    const targetPath = owner.settingsPath;
    const targetBefore = await writeJson(targetPath, target);
    await mkdir(join(linked.repo, ".claude"), { recursive: true });
    await symlink(targetPath, linked.settingsPath);
    return { ...linked, targetPath, targetBefore };
  };

  test("is refused, naming its target, when the strip would rewrite it — link and target unchanged", async () => {
    // Arrange: a worktree-style link to another checkout's settings
    const { repo, env, settingsPath, targetPath, targetBefore } = await linkedRepo("link-strip", {
      hooks: OWNED_HOOKS,
      permissions: { allow: ["Bash(ls)"] },
    });

    // Act
    const result = await runCli(["init", "--remove"], env, repo);

    // Assert
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(`${settingsPath} is a symlink to ${targetPath}`);
    expect(result.stdout).toContain("nothing was changed");
    expect((await lstat(settingsPath)).isSymbolicLink()).toBe(true);
    expect(await read(targetPath)).toBe(targetBefore);
  });

  test("is refused when the strip would delete it, instead of removing the link and claiming the file is gone", async () => {
    // Arrange: the target holds nothing but crosscheck's entries
    const { repo, env, settingsPath, targetPath, targetBefore } = await linkedRepo("link-delete", {
      hooks: OWNED_HOOKS,
      statusLine: OWNED_STATUSLINE,
    });

    // Act
    const result = await runCli(["init", "--remove"], env, repo);

    // Assert
    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain("deleted the file");
    expect((await lstat(settingsPath)).isSymbolicLink()).toBe(true);
    expect(await read(targetPath)).toBe(targetBefore);
  });
});
