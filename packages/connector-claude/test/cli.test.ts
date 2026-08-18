import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { runCli } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { resolveLauncher } from "../src/cli/init.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const HUB_URL = "https://hub.example.com";

const paths: string[] = [];

const fixture = async (): Promise<{
  readonly repo: string;
  readonly home: string;
  readonly env: Env;
  readonly settingsPath: string;
}> => {
  const repo = await makeRepo("cli", { remote: "git@github.com:acme/api.git" });
  const home = await makeHome("cli");
  paths.push(repo, home);
  return {
    repo,
    home,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: HUB_URL,
      CROSSCHECK_API_KEY: "test-key",
    },
    settingsPath: join(repo, ".claude", "settings.json"),
  };
};

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const unquote = (value: string): string =>
  value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : value;

/** A directory holding an executable named `crosscheck` that runs `script`. */
const makeFakeBin = async (label: string, script: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), `cx-fakebin-${label}-`));
  paths.push(dir);
  const bin = join(dir, "crosscheck");
  await writeFile(bin, `#!/bin/sh\n${script}\n`, "utf8");
  await chmod(bin, 0o755);
  return dir;
};

/** Last group is the one `init` appends; foreign groups keep their place. */
const hookCommand = (settings: unknown, event: string): string => {
  const hooks = (settings as Record<string, Record<string, unknown>>)["hooks"];
  const groups = hooks?.[event] as readonly Record<string, unknown>[];
  const entries = groups[groups.length - 1]?.["hooks"] as readonly Record<
    string,
    unknown
  >[];
  return String(entries[0]?.["command"]);
};

describe("crosscheck init", () => {
  test("writes the repo config and the three hook entries", async () => {
    // Arrange
    const { repo, env, settingsPath } = await fixture();

    // Act
    const result = await runCli(
      ["init", "--command-prefix", "crosscheck"],
      env,
      repo,
    );

    // Assert
    expect(result.exitCode).toBe(0);
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(settings)).toContain("crosscheck hook session-start");
    expect(JSON.stringify(settings)).toContain("crosscheck hook post-tool-use");
    expect(JSON.stringify(settings)).toContain("crosscheck hook session-end");
    const repoConfig = JSON.parse(
      await readFile(join(repo, ".crosscheck.json"), "utf8"),
    ) as { hubUrl: string };
    expect(repoConfig.hubUrl).toBe(HUB_URL);
  });

  test("registers the hint hooks: UserPromptSubmit and edit-only PreToolUse", async () => {
    // Arrange
    const { repo, env, settingsPath } = await fixture();

    // Act
    const result = await runCli(
      ["init", "--command-prefix", "crosscheck"],
      env,
      repo,
    );

    // Assert — the injection pipeline's two hooks (DESIGN.md §4)
    expect(result.exitCode).toBe(0);
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(hookCommand(settings, "UserPromptSubmit")).toBe(
      "crosscheck hook user-prompt-submit",
    );
    expect(hookCommand(settings, "PreToolUse")).toBe(
      "crosscheck hook pre-tool-use",
    );
    // The tripwire fires on writes only — Bash carries no file to overlap on.
    const hooks = settings["hooks"] as Record<string, readonly Record<string, unknown>[]>;
    const preToolUse = hooks["PreToolUse"] ?? [];
    expect(preToolUse[preToolUse.length - 1]?.["matcher"]).toBe(
      "Edit|Write|MultiEdit|NotebookEdit",
    );
  });

  test("running init twice produces a byte-identical settings file", async () => {
    // Arrange
    const { repo, env, settingsPath } = await fixture();
    await runCli(["init", "--command-prefix", "crosscheck"], env, repo);
    const first = await readFile(settingsPath, "utf8");

    // Act
    await runCli(["init", "--command-prefix", "crosscheck"], env, repo);

    // Assert
    expect(await readFile(settingsPath, "utf8")).toBe(first);
  });

  test("falls back to an absolute launcher path, never an unpublished package", async () => {
    // Arrange: `crosscheck` is not installed on this PATH
    const { repo, env, settingsPath } = await fixture();
    const withoutPath = { ...env, PATH: "" };

    // Act
    const result = await runCli(["init"], withoutPath, repo);

    // Assert
    expect(result.exitCode).toBe(0);
    const raw = await readFile(settingsPath, "utf8");
    expect(raw).not.toContain("@crosscheck/cli");
    const [runtime, script, ...rest] = hookCommand(
      JSON.parse(raw),
      "SessionStart",
    ).split(" ");
    expect(rest).toEqual(["hook", "session-start"]);
    expect(isAbsolute(unquote(runtime ?? ""))).toBe(true);
    expect(isAbsolute(unquote(script ?? ""))).toBe(true);
    expect(await Bun.file(unquote(runtime ?? "")).exists()).toBe(true);
    expect(await Bun.file(unquote(script ?? "")).exists()).toBe(true);
  });

  test("re-running init with the path launcher stays byte-identical", async () => {
    // Arrange
    const { repo, env, settingsPath } = await fixture();
    const withoutPath = { ...env, PATH: "" };
    await runCli(["init"], withoutPath, repo);
    const first = await readFile(settingsPath, "utf8");

    // Act
    await runCli(["init"], withoutPath, repo);

    // Assert
    expect(await readFile(settingsPath, "utf8")).toBe(first);
  });

  test("never blesses a foreign PATH binary that answers to crosscheck", async () => {
    // Arrange: `crosscheck` on PATH is a DIFFERENT tool — npm's crosscheck-cli
    // package installs a bin of exactly this name. Hooks wired to it would
    // pipe session json into a stranger's binary on every prompt.
    const { repo, env, settingsPath } = await fixture();
    const foreignDir = await makeFakeBin("foreign", 'echo "othertool 1.2.3"');

    // Act
    const result = await runCli(["init"], { ...env, PATH: foreignDir }, repo);

    // Assert: the absolute entry launcher is used instead, in both files
    expect(result.exitCode).toBe(0);
    const raw = await readFile(settingsPath, "utf8");
    expect(raw).not.toContain('"crosscheck hook session-start"');
    const mcp = JSON.parse(await readFile(join(repo, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(mcp.mcpServers["crosscheck"]?.command).not.toBe("crosscheck");
  });

  test("does not write a bare name resolved from an npx cache", async () => {
    // Arrange: the binary IS ours (identity passes), but it sits in npm's npx
    // cache — the PATH prefix that made the bare name resolve is gone the
    // moment npx exits, so every hook would die with `command not found`.
    const { repo, env, settingsPath } = await fixture();
    const cacheRoot = await mkdtemp(join(tmpdir(), "cx-npxcache-"));
    paths.push(cacheRoot);
    const binDir = join(cacheRoot, "_npx", "0123abc", "node_modules", ".bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "crosscheck"),
      '#!/bin/sh\necho "crosscheck 0.5.0"\n',
      "utf8",
    );
    await chmod(join(binDir, "crosscheck"), 0o755);

    // Act
    const result = await runCli(["init"], { ...env, PATH: binDir }, repo);

    // Assert
    expect(result.exitCode).toBe(0);
    expect(await readFile(settingsPath, "utf8")).not.toContain(
      '"crosscheck hook session-start"',
    );
  });

  test("blesses a durable PATH crosscheck that passes the identity probe", async () => {
    // Arrange: the global-install flow — this must keep working untouched
    const { repo, env, settingsPath } = await fixture();
    const binDir = await makeFakeBin("genuine", 'echo "crosscheck 9.9.9"');

    // Act
    const result = await runCli(["init"], { ...env, PATH: binDir }, repo);

    // Assert
    expect(result.exitCode).toBe(0);
    expect(await readFile(settingsPath, "utf8")).toContain(
      "crosscheck hook session-start",
    );
  });

  test("refuses outright when even its own entry lives in an npx cache", async () => {
    // Arrange: how `npx crosscheck-hub init` actually runs — BOTH the PATH hit and
    // the running entry sit inside the cache; there is nothing durable to
    // write, so init must say so instead of wiring hooks that die with it.
    const cacheRoot = await mkdtemp(join(tmpdir(), "cx-npxentry-"));
    paths.push(cacheRoot);
    const entry = join(
      cacheRoot,
      "_npx",
      "0abc",
      "node_modules",
      "crosscheck-hub",
      "src",
      "bin",
      "crosscheck.ts",
    );
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(entry, "// entry fixture\n", "utf8");

    // Act
    const launcher = await resolveLauncher(undefined, { PATH: "" }, entry);

    // Assert
    expect(launcher.kind).toBe("refused");
    if (launcher.kind === "refused") {
      expect(launcher.reason).toContain("npm install -g crosscheck-hub");
    }
  });

  test("names the api key, not the hub url, when only the key is missing", async () => {
    // Arrange: a cloned repo carries the hub url, the key never leaves a machine
    const { repo, home } = await fixture();
    await writeFile(
      join(repo, ".crosscheck.json"),
      `${JSON.stringify({ hubUrl: HUB_URL, protocol: "0.1" })}\n`,
      "utf8",
    );

    // Act
    const result = await runCli(["init"], { CROSSCHECK_HOME: home }, repo);

    // Assert
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("no api key");
    expect(result.stdout).toContain(HUB_URL);
    expect(result.stdout).not.toContain("no hub url");
  });

  test("names the hub url when nothing on disk supplies one", async () => {
    // Arrange
    const { repo, home } = await fixture();

    // Act
    const result = await runCli(
      ["init"],
      { CROSSCHECK_HOME: home, CROSSCHECK_API_KEY: "test-key" },
      repo,
    );

    // Assert
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("no hub url");
  });

  test("rejects a hub url that is not http(s) instead of blaming the key", async () => {
    // Arrange
    const { repo, home } = await fixture();

    // Act
    const result = await runCli(
      ["init", "--hub", "ftp://hub.example.com"],
      { CROSSCHECK_HOME: home },
      repo,
    );

    // Assert
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("invalid hub url");
  });

  test("aborts without writing when the existing settings are malformed", async () => {
    // Arrange
    const { repo, env, settingsPath } = await fixture();
    await mkdir(join(repo, ".claude"), { recursive: true });
    await writeFile(settingsPath, "{ this is not json", "utf8");

    // Act
    const result = await runCli(["init"], env, repo);

    // Assert
    expect(result.exitCode).toBe(1);
    expect(await readFile(settingsPath, "utf8")).toBe("{ this is not json");
    expect(await Bun.file(join(repo, ".crosscheck.json")).exists()).toBe(false);
  });
});

describe("crosscheck cli surface", () => {
  test("an unknown command prints usage and exits 64", async () => {
    // Arrange
    const { repo, env } = await fixture();

    // Act
    const result = await runCli(["wat"], env, repo);

    // Assert
    expect(result.exitCode).toBe(64);
    expect(result.stdout).toContain("usage: crosscheck <command>");
  });

  test("login rejects a hub url that is not http(s)", async () => {
    // Arrange
    const { repo, env } = await fixture();

    // Act
    const result = await runCli(["login", "ftp://hub", "key"], env, repo);

    // Assert
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("invalid hub url");
  });

  test("--help prints usage and exits 0, unlike an unknown command", async () => {
    // Arrange
    const { repo, env } = await fixture();

    // Act
    const long = await runCli(["--help"], env, repo);
    const short = await runCli(["-h"], env, repo);
    const bare = await runCli(["help"], env, repo);

    // Assert: asking for help is not an error — npx/bunx users probe with it
    for (const result of [long, short, bare]) {
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("usage: crosscheck <command>");
    }
  });

  test("usage lists the serve command", async () => {
    // Arrange
    const { repo, env } = await fixture();

    // Act
    const result = await runCli(["--help"], env, repo);

    // Assert: DESIGN.md §2 promises `npx crosscheck-hub serve`; the usage screen
    // is where a stranger discovers it.
    expect(result.stdout).toMatch(/^\s+serve\s/m);
  });

  test("--version prints the version from the nearest package.json", async () => {
    // Arrange
    const { repo, env } = await fixture();
    const packageJson = JSON.parse(
      await readFile(
        join(import.meta.dir, "..", "package.json"),
        "utf8",
      ),
    ) as { version: string };

    // Act
    const result = await runCli(["--version"], env, repo);

    // Assert: read from package.json at runtime, so publish bumps cannot
    // drift from what the binary reports.
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(`crosscheck ${packageJson.version}`);
  });
});

describe("crosscheck login without a key in argv", () => {
  const acceptingHub = (): ReturnType<typeof Bun.serve> =>
    Bun.serve({
      port: 0,
      fetch: () => Response.json({ ok: true, data: { sessions: [] } }),
    });

  const storedKey = async (home: string): Promise<string> => {
    const raw = await readFile(join(home, "config.json"), "utf8");
    return (JSON.parse(raw) as { apiKey: string }).apiKey;
  };

  test("takes the api key from the environment", async () => {
    // Arrange
    const { repo, home } = await fixture();
    const server = acceptingHub();
    const env = { CROSSCHECK_HOME: home, CROSSCHECK_API_KEY: "env-key" };

    // Act
    const result = await runCli(
      ["login", `http://127.0.0.1:${server.port}`],
      env,
      repo,
      async () => null,
    );

    // Assert
    expect(result.exitCode).toBe(0);
    expect(await storedKey(home)).toBe("env-key");
    server.stop(true);
  });

  test("takes the api key from stdin when nothing else supplies it", async () => {
    // Arrange
    const { repo, home } = await fixture();
    const server = acceptingHub();

    // Act
    const result = await runCli(
      ["login", `http://127.0.0.1:${server.port}`],
      { CROSSCHECK_HOME: home },
      repo,
      async () => "piped-key",
    );

    // Assert
    expect(result.exitCode).toBe(0);
    expect(await storedKey(home)).toBe("piped-key");
    server.stop(true);
  });

  test("prints the safe usage when no key is available at all", async () => {
    // Arrange
    const { repo, home } = await fixture();

    // Act
    const result = await runCli(
      ["login", "https://hub.example.com"],
      { CROSSCHECK_HOME: home },
      repo,
      async () => null,
    );

    // Assert
    expect(result.exitCode).toBe(64);
    expect(result.stdout).toContain("reads the api key from stdin");
    expect(result.stdout).toContain("CROSSCHECK_API_KEY");
  });
});
