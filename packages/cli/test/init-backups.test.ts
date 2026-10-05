/**
 * Project `crosscheck init` must never leave a copy of a file it rewrote in
 * the work tree (review 2026-10-05, the init --remove backup finding one
 * command earlier): a `.mcp.json.bak-<ts>` beside an ignored `.mcp.json` is a
 * new file `git status` offers to commit, holding every other server's env.
 * Originals go to a private directory under CROSSCHECK_HOME, named in the
 * output — the same mechanism `init --remove` uses.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runCli } from "../src/index.ts";
import { git } from "../../connector-core/test/helpers.ts";
import {
  INIT_ARGS,
  fixture,
  read,
  removeFixtures,
  savedOriginal,
  strayCopies,
  writeJson,
} from "./fixtures/init-remove.ts";

afterEach(removeFixtures);

const isDirectory = async (path: string): Promise<boolean> =>
  stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );

const SECRET_MCP = {
  mcpServers: {
    linear: { command: "linear-mcp", env: { LINEAR_API_KEY: "lin_SECRET_123" } },
  },
};

describe("crosscheck init's originals", () => {
  test("a rewritten ignored .mcp.json leaves no copy in the work tree; its original is saved privately and named", async () => {
    // Arrange: ignored project files, one holding a teammate's API key
    const { repo, env, mcpPath } = await fixture("init-backup-secret");
    await writeFile(join(repo, ".gitignore"), ".mcp.json\n.claude/\n", "utf8");
    await git(repo, ["add", ".gitignore"]);
    await git(repo, ["commit", "-m", "ignore local tooling"]);
    const mcpBefore = await writeJson(mcpPath, SECRET_MCP);

    // Act
    const result = await runCli(INIT_ARGS, env, repo);

    // Assert
    expect(result.exitCode).toBe(0);
    expect(strayCopies(repo)).toEqual([]);
    const saved = savedOriginal(result.stdout, mcpPath);
    expect(saved.startsWith(join(env["CROSSCHECK_HOME"] ?? "", "backups"))).toBe(true);
    expect(await read(saved)).toBe(mcpBefore);
    expect((await stat(saved)).mode & 0o777).toBe(0o600);
    expect(result.stdout).toContain(`wrote ${mcpPath} (original saved to ${saved})`);
  });

  test("init --cursor saves a rewritten .cursor/hooks.json's original outside the work tree too", async () => {
    // Arrange: the team's own Cursor hook, before crosscheck's join it
    const { repo, env } = await fixture("init-backup-cursor");
    const hooksPath = join(repo, ".cursor", "hooks.json");
    const hooksBefore = await writeJson(hooksPath, {
      version: 1,
      hooks: { sessionStart: [{ command: "./scripts/cursor-audit.sh" }] },
    });

    // Act
    const result = await runCli([...INIT_ARGS, "--cursor"], env, repo);

    // Assert
    expect(result.exitCode).toBe(0);
    expect(strayCopies(repo)).toEqual([]);
    const saved = savedOriginal(result.stdout, hooksPath);
    expect(saved.startsWith(join(env["CROSSCHECK_HOME"] ?? "", "backups"))).toBe(true);
    expect(await read(saved)).toBe(hooksBefore);
  });

  test("a re-run that changes nothing saves no original at all", async () => {
    // Arrange: one install, so the second run finds its own files unchanged
    const { repo, env } = await fixture("init-backup-rerun");
    expect((await runCli([...INIT_ARGS, "--cursor"], env, repo)).exitCode).toBe(0);

    // Act
    const rerun = await runCli([...INIT_ARGS, "--cursor"], env, repo);

    // Assert
    expect(rerun.exitCode).toBe(0);
    expect(rerun.stdout).not.toContain("original saved to");
    expect(await isDirectory(join(env["CROSSCHECK_HOME"] ?? "", "backups"))).toBe(false);
    expect(strayCopies(repo)).toEqual([]);
  });
});
