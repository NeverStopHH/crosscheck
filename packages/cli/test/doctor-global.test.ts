/**
 * Doctor's user-level install checks (finding #11), red before the checks
 * existed: the Ken shape (a parent-workspace cwd where NO crosscheck hooks
 * load and nothing on screen said so), the double-wiring state (project +
 * global at once), and the plain present/absent lines.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/index.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

/** Unreachable on purpose: the wiring checks run whether the hub answers. */
const HUB_URL = "http://127.0.0.1:9";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const doctorEnv = (home: string) => ({
  HOME: home,
  CROSSCHECK_HOME: join(home, ".crosscheck"),
  CROSSCHECK_HUB_URL: HUB_URL,
  CROSSCHECK_API_KEY: "test-key",
});

const installGlobal = async (env: Record<string, string>): Promise<void> => {
  const result = await runCli(
    ["init", "--global", "--command-prefix", "crosscheck"],
    env,
    "/",
  );
  expect(result.exitCode).toBe(0);
};

describe("doctor global-install checks", () => {
  test("the Ken shape: no project hooks, no global install → recommend --global", async () => {
    // Arrange: a plain directory that is not a git repo (the parent
    // workspace), a HOME without any user-level install
    const home = await makeHome("doctor-ken");
    const workspace = await mkdtemp(join(tmpdir(), "cx-workspace-"));
    paths.push(home, workspace);

    // Act
    const result = await runCli(["doctor"], doctorEnv(home), workspace);

    // Assert: the deaf state is named and the fix is the global install
    expect(result.stdout).toContain("WARN  global install");
    expect(result.stdout).toContain("crosscheck init --global");
    expect(result.stdout).toContain("no crosscheck hooks load");
  });

  test("a global install alone is a PASS naming the settings file", async () => {
    // Arrange
    const home = await makeHome("doctor-global-pass");
    const workspace = await mkdtemp(join(tmpdir(), "cx-workspace-"));
    paths.push(home, workspace);
    const env = doctorEnv(home);
    await installGlobal(env);

    // Act
    const result = await runCli(["doctor"], env, workspace);

    // Assert
    expect(result.stdout).toContain("PASS  global install");
    expect(result.stdout).toContain(join(home, ".claude", "settings.json"));
    expect(result.stdout).not.toContain("WARN  global install");
  });

  test("project + global wiring is a WARN naming the cleanup command", async () => {
    // Arrange: a connected repo with project hooks AND a global install
    const home = await makeHome("doctor-double");
    const repo = await makeRepo("doctor-double", {
      remote: "git@github.com:acme/api.git",
    });
    paths.push(home, repo);
    const env = doctorEnv(home);
    await installGlobal(env);
    const projectInit = await runCli(
      ["init", "--command-prefix", "crosscheck"],
      env,
      repo,
    );
    expect(projectInit.exitCode).toBe(0);

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert
    expect(result.stdout).toContain("WARN  global install");
    expect(result.stdout).toContain("double wiring");
    expect(result.stdout).toContain("crosscheck init --global --remove");
  });

  test("project hooks without a global install stay a quiet PASS", async () => {
    // Arrange
    const home = await makeHome("doctor-project-only");
    const repo = await makeRepo("doctor-project-only", {
      remote: "git@github.com:acme/api.git",
    });
    paths.push(home, repo);
    const env = doctorEnv(home);
    await runCli(["init", "--command-prefix", "crosscheck"], env, repo);

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert
    expect(result.stdout).toContain("PASS  global install");
    expect(result.stdout).toContain("absent (project hooks cover this repo");
  });

  test("project init says so when a global install already exists", async () => {
    // Arrange (finding #11 decision: honest message, never silent
    // duplication — and never a veto of the team's committed install)
    const home = await makeHome("init-note-global");
    const repo = await makeRepo("init-note-global", {
      remote: "git@github.com:acme/api.git",
    });
    paths.push(home, repo);
    const env = doctorEnv(home);
    await installGlobal(env);

    // Act
    const result = await runCli(
      ["init", "--command-prefix", "crosscheck"],
      env,
      repo,
    );

    // Assert: install proceeded AND the note names the cleanup command
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("wrote");
    expect(result.stdout).toContain("user-level (global) crosscheck install exists");
    expect(result.stdout).toContain("crosscheck init --global --remove");
  });
});
