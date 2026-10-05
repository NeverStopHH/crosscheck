/**
 * What `crosscheck init --remove` says is STILL wiring this repo after it
 * ran, and the one sentence that says nothing is: printed only when every
 * place it can know about was read and found clean (review 2026-10-05).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { join } from "node:path";

import { runCli } from "../src/index.ts";
import {
  FOREIGN_MCP,
  INIT_ARGS,
  OWNED_HOOKS,
  fixture,
  removeFixtures,
  writeJson,
} from "./fixtures/init-remove.ts";

afterEach(removeFixtures);

describe("Cursor files left in place without --cursor", () => {
  test("a .cursor/mcp.json holding only the user's own server is never called crosscheck's", async () => {
    // Arrange: a Claude-only install beside the team's own Cursor server
    const { repo, env } = await fixture("cursor-foreign-only");
    await writeJson(join(repo, ".cursor", "mcp.json"), FOREIGN_MCP);
    expect((await runCli(INIT_ARGS, env, repo)).exitCode).toBe(0);

    // Act
    const result = await runCli(["init", "--remove"], env, repo);

    // Assert
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("cursor entries");
  });

  test("crosscheck's cursor entries are named per file, with the flag that removes them", async () => {
    // Arrange
    const { repo, env } = await fixture("cursor-wired");
    expect((await runCli([...INIT_ARGS, "--cursor"], env, repo)).exitCode).toBe(0);
    const hooksPath = join(repo, ".cursor", "hooks.json");
    const cursorMcpPath = join(repo, ".cursor", "mcp.json");

    // Act
    const result = await runCli(["init", "--remove"], env, repo);

    // Assert
    expect(result.stdout).toMatch(new RegExp(`${hooksPath} \\(\\d+ cursor hook entries\\)`));
    expect(result.stdout).toContain(`${cursorMcpPath} (the crosscheck mcp server)`);
    expect(result.stdout).toContain("`crosscheck init --remove --cursor`");
  });
});

/** The sentence that says nothing wires the repo any more. */
const ABSENCE = "load no crosscheck hooks";

describe("the 'sessions here load no crosscheck hooks' sentence", () => {
  test("is printed when the repo, its Cursor pair and every user-level file were read and are clean", async () => {
    // Arrange
    const { repo, env } = await fixture("verdict-clean");
    expect((await runCli(INIT_ARGS, env, repo)).exitCode).toBe(0);

    // Act
    const result = await runCli(["init", "--remove"], env, repo);

    // Assert
    expect(result.stdout).toContain(ABSENCE);
  });

  test("is withheld while crosscheck's cursor entries stay in place without --cursor", async () => {
    // Arrange
    const { repo, env } = await fixture("verdict-cursor");
    expect((await runCli([...INIT_ARGS, "--cursor"], env, repo)).exitCode).toBe(0);

    // Act
    const result = await runCli(["init", "--remove"], env, repo);

    // Assert
    expect(result.stdout).not.toContain(ABSENCE);
  });

  test("is withheld, and the server under crosscheck's key named, after an install through an unrecognised launcher", async () => {
    // Arrange: an install made with an operator's own --command-prefix — its
    // hooks never name crosscheck, but its mcp server sits under crosscheck's key
    const { repo, env, mcpPath } = await fixture("verdict-prefix");
    expect(
      (await runCli(["init", "--command-prefix", "/opt/tools/cx-wrap"], env, repo)).exitCode,
    ).toBe(0);

    // Act
    const result = await runCli(["init", "--remove"], env, repo);

    // Assert
    expect(result.stdout).not.toContain(ABSENCE);
    expect(result.stdout).toContain(
      `${mcpPath}: left 1 entry that looks like crosscheck's but runs through a launcher`,
    );
    expect(result.stdout).toContain("mcpServers.crosscheck: sh -c /opt/tools/cx-wrap mcp");
    expect(result.stdout).toContain("NOT removed");
    expect(result.stdout).toContain("hooks that run through the same launcher");
  });

  test("is withheld, and the entry named, for a hook that names crosscheck through a launcher it does not own", async () => {
    // Arrange: `crosscheck-hub` names crosscheck, but is not a launcher init writes
    const { repo, env, settingsPath } = await fixture("verdict-named");
    await writeJson(settingsPath, {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "bunx crosscheck-hub hook session-start" }] },
        ],
      },
    });

    // Act
    const result = await runCli(["init", "--remove"], env, repo);

    // Assert
    expect(result.stdout).not.toContain(ABSENCE);
    expect(result.stdout).toContain(`${settingsPath}: left 1 entry that looks like crosscheck's`);
    expect(result.stdout).toContain("`bunx crosscheck-hub hook session-start`");
  });

  test.each([
    ["npx -y ccusage statusline", "~/.local/bin/cc-tools statusline"],
    ["bunx ccusage statusline", "starship-claude statusline"],
  ])(
    "is printed when the only leftovers are other tools' statuslines (%s, %s) that merely share the word",
    async (projectStatusline, userStatusline) => {
      // Arrange: crosscheck's hooks beside a foreign project statusline, and
      // a foreign user-level statusline — neither names crosscheck
      const { repo, home, env, settingsPath } = await fixture("verdict-statusline");
      await writeJson(settingsPath, {
        hooks: OWNED_HOOKS,
        statusLine: { type: "command", command: projectStatusline },
      });
      await writeJson(join(home, ".claude", "settings.json"), {
        statusLine: { type: "command", command: userStatusline },
      });

      // Act
      const result = await runCli(["init", "--remove"], env, repo);

      // Assert
      expect(result.stdout).not.toContain("looks like crosscheck's");
      expect(result.stdout).toContain(ABSENCE);
    },
  );

  test.skipIf(process.getuid?.() === 0)(
    "is withheld when a user-level file cannot be read, and that file is named",
    async () => {
      // Arrange: a user-level install the command has no permission to read
      const { repo, home, env } = await fixture("verdict-eacces");
      expect((await runCli(INIT_ARGS, env, repo)).exitCode).toBe(0);
      const userSettingsPath = join(home, ".claude", "settings.json");
      await writeJson(userSettingsPath, { hooks: OWNED_HOOKS });
      await chmod(userSettingsPath, 0o000);

      // Act
      const result = await runCli(["init", "--remove"], env, repo).finally(() =>
        chmod(userSettingsPath, 0o644),
      );

      // Assert
      expect(result.stdout).not.toContain(ABSENCE);
      expect(result.stdout).not.toContain("no user-level install");
      expect(result.stdout).toContain(`${userSettingsPath} could not be read`);
    },
  );
});
