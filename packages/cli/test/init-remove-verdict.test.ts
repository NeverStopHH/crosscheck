/**
 * What `crosscheck init --remove` says is STILL wiring this repo after it
 * ran, and the one sentence that says nothing is: printed only when every
 * place it can know about was read and found clean (review 2026-10-05).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { runCli } from "../src/index.ts";
import {
  FOREIGN_MCP,
  INIT_ARGS,
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
