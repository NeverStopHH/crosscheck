/**
 * Doctor's user-level install checks (finding #11), red before the checks
 * existed: the Ken shape (a parent-workspace cwd where NO crosscheck hooks
 * load and nothing on screen said so), the double-wiring state (project +
 * global at once), and the plain present/absent lines.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

/**
 * Finding #13, red before the project checks became scope-aware: after
 * `crosscheck init --global`, doctor in a connected repo WITHOUT
 * project-scope wiring contradicted itself — PASS global install directly
 * above FAIL hooks registered and FAIL mcp tools registered. The
 * project-scope checks predate the global mode and never consulted user
 * scope; sessions were fine, the REPORT lied.
 */
describe("doctor scope-aware project checks (finding #13)", () => {
  const globalOnlyFixture = async (
    slug: string,
  ): Promise<{ readonly repo: string; readonly env: Record<string, string> }> => {
    const home = await makeHome(slug);
    const repo = await makeRepo(slug, {
      remote: "git@github.com:acme/api.git",
    });
    paths.push(home, repo);
    const env = doctorEnv(home);
    await installGlobal(env);
    return { repo, env };
  };

  test("a global-only install in a connected repo passes hooks via user scope", async () => {
    // Arrange: a git repo with NO project-scope wiring, hooks installed
    // user-scoped — the exact live repro
    const { repo, env } = await globalOnlyFixture("doctor-scope-global-only");

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert: the report must not contradict its own global-install PASS,
    // and the PASS says which scope satisfied it
    expect(result.stdout).toContain("PASS  global install");
    expect(result.stdout).toContain("PASS  hooks registered  via global install");
    expect(result.stdout).not.toContain("FAIL  hooks registered");
    expect(result.stdout).toContain("PASS  statusline registered  via global install");
  });

  test("the mcp check passes via user scope and keeps the teammate note", async () => {
    // Arrange
    const { repo, env } = await globalOnlyFixture("doctor-scope-global-mcp");

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert: PASS via user scope — but the honest nuance survives as a
    // note: user scope covers THIS machine, a committed .mcp.json is still
    // what hands teammates the tools
    expect(result.stdout).toContain("PASS  mcp tools registered  via global install");
    expect(result.stdout).not.toContain("FAIL  mcp tools registered");
    expect(result.stdout).toContain("teammates");
    expect(result.stdout).toContain(join(repo, ".mcp.json"));
  });

  test("a statusLine-only project settings file still passes hooks via user scope", async () => {
    // Arrange: the second live shape — the repo carries .claude/settings.json
    // with ONLY a statusline, no hooks key at all
    const { repo, env } = await globalOnlyFixture("doctor-scope-statusline-only");
    await mkdir(join(repo, ".claude"), { recursive: true });
    await writeFile(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({ statusLine: { type: "command", command: "/usr/bin/uptime" } }),
      "utf8",
    );

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert: no false "missing: SessionStart, …" — and no double-wiring
    // WARN either: a statusline is not project hook wiring
    expect(result.stdout).toContain("PASS  hooks registered  via global install");
    expect(result.stdout).not.toContain("FAIL  hooks registered");
    expect(result.stdout).not.toContain("double wiring");
  });

  test("the hook launcher is checked against the scope that carries it", async () => {
    // Arrange: global-only wiring whose hooks call a bare `crosscheck`,
    // with a resolvable crosscheck on PATH — doctor must execute the
    // launcher the user-scope hooks would run, not skip the check because
    // the project registers none
    const { repo, env } = await globalOnlyFixture("doctor-scope-launcher");
    const binDir = await mkdtemp(join(tmpdir(), "cx-scope-bin-"));
    paths.push(binDir);
    const bin = join(binDir, "crosscheck");
    await writeFile(bin, '#!/bin/sh\necho "crosscheck 9.9.9"\n', "utf8");
    await chmod(bin, 0o755);

    // Act
    const result = await runCli(["doctor"], { ...env, PATH: binDir }, repo);

    // Assert
    expect(result.stdout).toContain("PASS  hook launcher");
  });

  test("a repo with neither scope still fails both checks exactly as before", async () => {
    // Arrange: no project wiring, no global install — the deaf repo must
    // keep its honest FAILs
    const home = await makeHome("doctor-scope-neither");
    const repo = await makeRepo("doctor-scope-neither", {
      remote: "git@github.com:acme/api.git",
    });
    paths.push(home, repo);

    // Act
    const result = await runCli(["doctor"], doctorEnv(home), repo);

    // Assert
    expect(result.stdout).toContain("FAIL  hooks registered");
    expect(result.stdout).toContain("run crosscheck init");
    expect(result.stdout).toContain("FAIL  mcp tools registered");
    expect(result.stdout).not.toContain("via global install");
  });

  test("double wiring keeps its WARN and hooks pass via the project scope", async () => {
    // Arrange: both scopes register hooks — the WARN must survive the
    // scope-aware checks, and the hooks PASS must credit the project scope
    const { repo, env } = await globalOnlyFixture("doctor-scope-double");
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
    expect(result.stdout).toContain("PASS  hooks registered");
    expect(result.stdout).not.toContain("hooks registered  via global install");
  });
});
