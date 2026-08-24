/**
 * `crosscheck init --global` (finding #11): the user-level install, driven
 * through the real CLI against a sandboxed HOME. Everything here was RED
 * before the feature existed — `init --global` was an unknown-flag usage
 * error on main — and each test pins one of the decisive behaviors: the
 * wiring lands in ~/.claude/settings.json + ~/.claude.json, re-runs are
 * byte-identical no-ops that leave no fresh backups, foreign content
 * survives install → remove byte-for-byte, the statusline discipline holds
 * without --force-statusline, and --remove sweeps the Cursor files without
 * needing --cursor remembered.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runCli } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { makeHome } from "../../connector-core/test/helpers.ts";

const HUB_URL = "https://hub.example.com";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const fixture = async (): Promise<{
  readonly home: string;
  readonly env: Env;
  readonly settingsPath: string;
  readonly mcpPath: string;
}> => {
  const home = await makeHome("init-global");
  paths.push(home);
  return {
    home,
    env: {
      HOME: home,
      CROSSCHECK_HOME: join(home, ".crosscheck"),
      CROSSCHECK_HUB_URL: HUB_URL,
      CROSSCHECK_API_KEY: "test-key",
    },
    settingsPath: join(home, ".claude", "settings.json"),
    mcpPath: join(home, ".claude.json"),
  };
};

const GLOBAL_ARGS = ["init", "--global", "--command-prefix", "crosscheck"];

const backupsIn = async (dir: string): Promise<readonly string[]> => {
  try {
    return (await readdir(dir)).filter((name) => name.includes(".bak-"));
  } catch {
    return [];
  }
};

describe("crosscheck init --global", () => {
  test("wires hooks, statusline and user-scope mcp at the user level", async () => {
    // Arrange
    const { env, settingsPath, mcpPath } = await fixture();

    // Act
    const result = await runCli(GLOBAL_ARGS, env, "/");

    // Assert
    expect(result.exitCode).toBe(0);
    const settings = await readFile(settingsPath, "utf8");
    for (const hook of [
      "session-start",
      "post-tool-use",
      "session-end",
      "user-prompt-submit",
      "pre-tool-use",
      "stop",
    ]) {
      expect(settings).toContain(`crosscheck hook ${hook}`);
    }
    expect(settings).toContain("crosscheck statusline");
    const mcp = JSON.parse(await readFile(mcpPath, "utf8")) as {
      mcpServers: Record<string, { args: readonly string[] }>;
    };
    // The operator prefix resolves through sh -c, so the subcommand sits
    // inside the joined argument — assert on the entry as rendered.
    expect(JSON.stringify(mcp.mcpServers["crosscheck"])).toContain("mcp");
    // Trial finding M10: the SessionEnd entry carries the explicit host
    // timeout, read back from the file `init --global` actually wrote.
    const parsed = JSON.parse(settings) as {
      hooks: Record<string, { hooks: { timeout?: number }[] }[]>;
    };
    expect(parsed.hooks["SessionEnd"]?.[0]?.hooks[0]?.timeout).toBe(60);
    // The §2.1 line and the restart hint are said out loud
    expect(result.stdout).toContain("committed .crosscheck.json");
    expect(result.stdout).toContain("restart");
  });

  test("a second run is a byte-identical no-op with no fresh backup", async () => {
    // Arrange
    const { home, env, settingsPath } = await fixture();
    await runCli(GLOBAL_ARGS, env, "/");
    const firstSettings = await readFile(settingsPath, "utf8");
    const firstMcp = await readFile(join(home, ".claude.json"), "utf8");
    const backupsAfterFirst = await backupsIn(join(home, ".claude"));

    // Act
    const second = await runCli(GLOBAL_ARGS, env, "/");

    // Assert: same bytes, no new backups, and the output says "unchanged"
    expect(second.exitCode).toBe(0);
    expect(await readFile(settingsPath, "utf8")).toBe(firstSettings);
    expect(await readFile(join(home, ".claude.json"), "utf8")).toBe(firstMcp);
    expect(await backupsIn(join(home, ".claude"))).toEqual(backupsAfterFirst);
    expect(second.stdout).toContain("unchanged");
  });

  test("install then --remove hands back the byte-identical foreign file", async () => {
    // Arrange: user settings with the user's own hooks and statusline
    const { home, env, settingsPath } = await fixture();
    const foreign = `${JSON.stringify(
      {
        model: "opus",
        hooks: {
          PostToolUse: [
            {
              matcher: "Write",
              hooks: [{ type: "command", command: "prettier --write" }],
            },
          ],
        },
        statusLine: { type: "command", command: "my-statusline" },
      },
      null,
      2,
    )}\n`;
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(settingsPath, foreign, "utf8");

    // Act
    await runCli(GLOBAL_ARGS, env, "/");
    const removal = await runCli(["init", "--global", "--remove"], env, "/");

    // Assert
    expect(removal.exitCode).toBe(0);
    expect(removal.stdout).toContain(`removed crosscheck entries from ${settingsPath}`);
    expect(await readFile(settingsPath, "utf8")).toBe(foreign);
  });

  test("--remove on a machine without an install says so and changes nothing", async () => {
    const { env } = await fixture();
    const result = await runCli(["init", "--global", "--remove"], env, "/");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no user-level crosscheck install found");
  });

  test("never steals an existing statusline without --force-statusline", async () => {
    // Arrange
    const { home, env, settingsPath } = await fixture();
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      settingsPath,
      `${JSON.stringify({ statusLine: { type: "command", command: "my-statusline" } }, null, 2)}\n`,
      "utf8",
    );

    // Act
    const result = await runCli(GLOBAL_ARGS, env, "/");

    // Assert: foreign statusline preserved, the note names the escape hatch
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      statusLine: { command: string };
    };
    expect(settings.statusLine.command).toBe("my-statusline");
    expect(result.stdout).toContain("--force-statusline");

    // Act again, forced
    await runCli([...GLOBAL_ARGS, "--force-statusline"], env, "/");
    const forced = JSON.parse(await readFile(settingsPath, "utf8")) as {
      statusLine: { command: string };
    };
    expect(forced.statusLine.command).toBe("crosscheck statusline");
  });

  test("--cursor wires ~/.cursor and --remove sweeps it without the flag", async () => {
    // Arrange
    const { home, env } = await fixture();
    const cursorHooksPath = join(home, ".cursor", "hooks.json");
    const cursorMcpPath = join(home, ".cursor", "mcp.json");

    // Act
    const install = await runCli([...GLOBAL_ARGS, "--cursor"], env, "/");

    // Assert: both files exist and carry the wiring
    expect(install.exitCode).toBe(0);
    expect(await readFile(cursorHooksPath, "utf8")).toContain(
      "crosscheck cursor-hook sessionStart",
    );
    expect(await readFile(cursorMcpPath, "utf8")).toContain("crosscheck");
    // The cloud-agent limitation is said honestly
    expect(install.stdout).toContain("cloud agents");

    // Act: removal WITHOUT --cursor still sweeps the cursor files
    const removal = await runCli(["init", "--global", "--remove"], env, "/");
    expect(removal.stdout).toContain(
      `removed crosscheck entries from ${cursorHooksPath}`,
    );
    expect(removal.stdout).toContain(
      `removed crosscheck entries from ${cursorMcpPath}`,
    );
    expect(await readFile(cursorHooksPath, "utf8")).not.toContain("cursor-hook");
  });

  test("aborts without writing when the user settings are malformed", async () => {
    // Arrange
    const { home, env, settingsPath } = await fixture();
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(settingsPath, "{ not json", "utf8");

    // Act
    const result = await runCli(GLOBAL_ARGS, env, "/");

    // Assert
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("not valid json");
    expect(await readFile(settingsPath, "utf8")).toBe("{ not json");
  });

  test("refuses a parseable non-object user file instead of clobbering it", async () => {
    // Arrange: valid JSON that is not an object — its content cannot be
    // preserved through the merge, so the read-and-refuse principle applies
    // to it exactly as it does to unparseable text (rigor review MEDIUM-1)
    const { home, env, settingsPath } = await fixture();
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(settingsPath, "[1, 2, 3]\n", "utf8");

    // Act
    const result = await runCli(GLOBAL_ARGS, env, "/");

    // Assert: aborted, file byte-identical, no backup written
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("not a json object");
    expect(await readFile(settingsPath, "utf8")).toBe("[1, 2, 3]\n");
    expect(await backupsIn(join(home, ".claude"))).toEqual([]);
  });

  test("--remove skips a corrupt file it never wrote and sweeps the rest", async () => {
    // Arrange: a Claude-only install, then ~/.cursor/mcp.json — a file this
    // install never touched — goes corrupt (rigor review MEDIUM-2: one
    // unreadable file must not make the Claude wiring un-uninstallable)
    const { home, env, settingsPath } = await fixture();
    await runCli(GLOBAL_ARGS, env, "/");
    const cursorMcpPath = join(home, ".cursor", "mcp.json");
    await mkdir(join(home, ".cursor"), { recursive: true });
    await writeFile(cursorMcpPath, "{ not json", "utf8");

    // Act
    const removal = await runCli(["init", "--global", "--remove"], env, "/");

    // Assert: the Claude wiring is gone, the corrupt file is named as
    // skipped and left byte-identical
    expect(removal.exitCode).toBe(0);
    expect(removal.stdout).toContain(
      `removed crosscheck entries from ${settingsPath}`,
    );
    expect(removal.stdout).toContain(`${cursorMcpPath} is not valid json — skipped`);
    expect(await readFile(settingsPath, "utf8")).not.toContain("crosscheck hook");
    expect(await readFile(cursorMcpPath, "utf8")).toBe("{ not json");
  });

  test("requires a login first — inert machine-wide wiring helps nobody", async () => {
    const home = await makeHome("init-global-nologin");
    paths.push(home);
    const result = await runCli(
      ["init", "--global", "--command-prefix", "crosscheck"],
      { HOME: home, CROSSCHECK_HOME: join(home, ".crosscheck") },
      "/",
    );
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("crosscheck login");
  });

  test("--hub is refused: the hub url lives in each repo's config", async () => {
    const { env } = await fixture();
    const result = await runCli(
      ["init", "--global", "--hub", "https://other.example.com"],
      env,
      "/",
    );
    expect(result.exitCode).toBe(64);
    expect(result.stdout).toContain("--hub does not apply to --global");
  });

  test("--remove without --global points at the global spelling", async () => {
    const { env } = await fixture();
    const result = await runCli(["init", "--remove"], env, "/");
    expect(result.exitCode).toBe(64);
    expect(result.stdout).toContain("crosscheck init --global --remove");
  });
});
