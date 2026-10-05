/**
 * The shared fixture of the `crosscheck init --remove` (and init backup) test files: a real git
 * repo (tracked vs ignored is git's answer), a temp HOME and a temp
 * CROSSCHECK_HOME. No hub: neither init nor remove talks to one.
 *
 * Every path is REAL (realpath'd): the command prints git's toplevel, and
 * macOS's tmpdir is a symlink (/var → /private/var) that git resolves.
 */
import { mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Env } from "../../src/index.ts";
import { makeHome, makeRepo } from "../../../connector-core/test/helpers.ts";

/** Never contacted: init only writes it into .crosscheck.json. */
export const HUB_URL = "https://hub.example.com";
export const INIT_ARGS = ["init", "--command-prefix", "crosscheck"];

const created: string[] = [];

/** For each test file's afterEach: removes every fixture made since. */
export const removeFixtures = async (): Promise<void> => {
  const paths = created.splice(0, created.length);
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
};

export interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly env: Env;
  readonly settingsPath: string;
  readonly mcpPath: string;
  readonly repoConfigPath: string;
}

export const fixture = async (label: string): Promise<Fixture> => {
  const repo = await realpath(
    await makeRepo(`init-remove-${label}`, { remote: "git@github.com:acme/api.git" }),
  );
  const home = await realpath(await makeHome(`init-remove-${label}`));
  created.push(repo, home);
  return {
    repo,
    home,
    env: {
      HOME: home,
      CROSSCHECK_HOME: join(home, ".crosscheck"),
      CROSSCHECK_HUB_URL: HUB_URL,
      CROSSCHECK_API_KEY: "test-key",
    },
    settingsPath: join(repo, ".claude", "settings.json"),
    mcpPath: join(repo, ".mcp.json"),
    repoConfigPath: join(repo, ".crosscheck.json"),
  };
};

/** A temp dir the fixture cleanup also removes. */
export const tempDir = async (label: string): Promise<string> => {
  const dir = await realpath(await makeHome(`init-remove-${label}`));
  created.push(dir);
  return dir;
};

export const read = async (path: string): Promise<string> => Bun.file(path).text();
export const exists = async (path: string): Promise<boolean> => Bun.file(path).exists();

export const writeJson = async (path: string, value: unknown, indent = 2): Promise<string> => {
  const text = `${JSON.stringify(value, null, indent)}\n`;
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text, "utf8");
  return text;
};

/**
 * Backup or temp copies anywhere in the work tree, as git sees them — new or
 * ignored (with -uall, git lists the files inside ignored directories too).
 */
export const strayCopies = (repo: string): readonly string[] =>
  new TextDecoder()
    .decode(
      Bun.spawnSync({
        cmd: ["git", "status", "--porcelain", "--untracked-files=all", "--ignored"],
        cwd: repo,
      }).stdout,
    )
    .split("\n")
    .filter((line) => line.startsWith("?? ") || line.startsWith("!! "))
    .map((line) => line.slice(3))
    .filter((path) => path.includes(".bak-") || path.includes(".tmp-"));

/** The private path an output line says an original was saved to ("" if none). */
export const savedOriginal = (stdout: string, path: string): string =>
  new RegExp(`${path} .*\\(original saved to (\\S+)\\)`).exec(stdout)?.[1] ?? "";

/** `.bak-` files directly in `dir` — what a backup beside the original leaves. */
export const backupsIn = async (dir: string): Promise<readonly string[]> => {
  try {
    return (await readdir(dir)).filter((name) => name.includes(".bak-"));
  } catch {
    return [];
  }
};

/** A teammate's own hook and permissions — what must survive install → remove. */
export const FOREIGN_SETTINGS = {
  hooks: {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "./scripts/guard.sh" }] },
    ],
  },
  permissions: { allow: ["Bash(ls)"] },
};

export const FOREIGN_MCP = {
  mcpServers: { docs: { type: "stdio", command: "docs-mcp", args: ["serve"] } },
};

/** Hooks an init wrote, in the launcher form crosscheck recognises as its own. */
export const OWNED_HOOKS = {
  SessionStart: [{ hooks: [{ type: "command", command: "crosscheck hook session-start" }] }],
  Stop: [{ hooks: [{ type: "command", command: "crosscheck hook stop", async: true }] }],
};
export const OWNED_STATUSLINE = { type: "command", command: "crosscheck statusline" };
export const OWNED_MCP_SERVER = { type: "stdio", command: "crosscheck", args: ["mcp"] };
