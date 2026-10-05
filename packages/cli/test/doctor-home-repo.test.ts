/**
 * $HOME is itself a git work tree (dotfiles), and doctor runs in a folder
 * under it (review 2026-10-05). The "project" `.claude/settings.json` there
 * IS `~/.claude/settings.json`: ONE install read under two names. doctor
 * called it double wiring and offered remedies the commands refuse
 * (`init --remove`), or that delete the only install (`init --global
 * --remove`), and its mcp line said "run crosscheck init", which refuses
 * there too. It now asks the scope guard the commands ask.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runCli } from "../src/index.ts";
import { runDoctor } from "../src/cli/doctor.ts";
import { git } from "../../connector-core/test/helpers.ts";
import { removeFixtures, tempDir } from "./fixtures/init-remove.ts";

afterEach(removeFixtures);

/** A dotfiles HOME with the user-level install committed or ignored, and a plain folder under it. */
const homeWorkTree = async (label: string, claudeIgnored: boolean) => {
  const home = await tempDir(label);
  await git(home, ["init", "--initial-branch=main"]);
  await git(home, ["config", "user.email", "dev@example.com"]);
  await git(home, ["config", "user.name", "Dev"]);
  await writeFile(
    join(home, ".gitignore"),
    claudeIgnored ? ".crosscheck/\n.claude/\n" : ".crosscheck/\n",
    "utf8",
  );
  const cwd = join(home, "scratch");
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, "notes.md"), "x\n", "utf8");
  const env = {
    HOME: home,
    CROSSCHECK_HOME: join(home, ".crosscheck"),
    CROSSCHECK_HUB_URL: "http://127.0.0.1:9",
    CROSSCHECK_API_KEY: "test-key",
  };
  expect(
    (await runCli(["init", "--global", "--command-prefix", "crosscheck"], env, cwd)).exitCode,
  ).toBe(0);
  await git(home, ["add", "-A"]);
  await git(home, ["commit", "-m", "dotfiles"]);
  return { home, cwd, env };
};

describe("doctor in a $HOME that is the git work tree", () => {
  test.each([
    ["committed", false],
    ["ignored", true],
  ])(
    "with ~/.claude %s: one install, said plainly — no double wiring, no remedy the commands refuse",
    async (_shape, claudeIgnored) => {
      // Arrange
      const { home, cwd, env } = await homeWorkTree(`home-repo-doctor-${String(claudeIgnored)}`, claudeIgnored);

      // Act
      const result = await runDoctor(env, cwd, async () => null);

      // Assert
      expect(result.stdout).not.toContain("double wiring");
      expect(result.stdout).toContain(`this repo's root ${home} is your home directory`);
      expect(result.stdout).not.toContain("crosscheck init --remove");
      expect(result.stdout).not.toContain("crosscheck init --global --remove");
      expect(result.stdout).not.toContain("run crosscheck init, then commit the file");
    },
  );
});
