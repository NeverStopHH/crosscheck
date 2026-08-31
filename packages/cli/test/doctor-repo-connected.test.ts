/**
 * doctor names `.crosscheck.json`'s git state (Anhang A, A4-07).
 *
 * `runDoctor` reads the file only as a boolean — it decides whether the
 * parent-workspace scan runs — and says nothing about it. The file is the only
 * thing that makes a repo reportable (DESIGN.md §2.1), so a checkout without
 * it is silent for everyone who works there, and nothing on any surface
 * explains why. It is a LOW finding because a fresh clone of a repo whose main
 * branch carries the file has it; what it catches is a branch that predates
 * the commit — `feature/metric-glossary` in the trial's monorepo showed `??`
 * for exactly that reason.
 *
 * Real repos, real `git ls-files`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { repoConnectedCheck, runDoctor } from "../src/cli/doctor.ts";
import { REPO_CONFIG_FILE } from "@crosscheck/connector-core/constants.ts";
import { renderRepoConfig } from "@crosscheck/connector-core/config/repo-config.ts";
import { git, makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const HUB_URL = "http://127.0.0.1:9";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

type State = "tracked" | "untracked" | "absent";

const repoIn = async (label: string, state: State): Promise<string> => {
  const repo = await makeRepo(label, {
    remote: "git@github.com:acme/api.git",
  });
  paths.push(repo);
  if (state === "absent") {
    return repo;
  }
  await writeFile(
    join(repo, REPO_CONFIG_FILE),
    renderRepoConfig(HUB_URL),
    "utf8",
  );
  if (state === "tracked") {
    await git(repo, ["add", REPO_CONFIG_FILE]);
    await git(repo, ["commit", "-m", "connect the repo"]);
  }
  return repo;
};

const doctorEnv = (home: string) => ({
  CROSSCHECK_HOME: home,
  HOME: home,
  CROSSCHECK_HUB_URL: HUB_URL,
  CROSSCHECK_API_KEY: "test-key",
});

describe("repoConnectedCheck", () => {
  test("the three states read as three different sentences", () => {
    // Arrange + Act + Assert
    expect(repoConnectedCheck(true, true).detail).toContain(
      "present and tracked",
    );
    expect(repoConnectedCheck(true, false).detail).toContain("untracked");
    expect(repoConnectedCheck(false, null).detail).toContain("crosscheck init");
  });

  test("absent is the WARN — the state nothing else explains", () => {
    // Arrange + Act + Assert
    expect(repoConnectedCheck(false, null).level).toBe("WARN");
    // Untracked is the minutes between `init` and the commit, so it says its
    // piece at PASS rather than greeting every new install with a defect —
    // a deliberate deviation from A4-07's prescribed WARN, spelled out at the
    // site in doctor.ts (review finding B2-08/B2-L6).
    expect(repoConnectedCheck(true, false).level).toBe("PASS");
    expect(repoConnectedCheck(true, true).level).toBe("PASS");
  });

  test("git that cannot answer never claims untracked", () => {
    // Arrange + Act
    const result = repoConnectedCheck(true, null);

    // Assert: old text over wrong text
    expect(result.level).toBe("PASS");
    expect(result.detail).toContain("git could not say");
    expect(result.detail).not.toContain("untracked");
  });
});

describe("runDoctor", () => {
  test("a tracked config reads present and tracked", async () => {
    // Arrange
    const repo = await repoIn("repo-connected-tracked", "tracked");
    const home = await makeHome("repo-connected-tracked");
    paths.push(home);

    // Act
    const result = await runDoctor(doctorEnv(home), repo, async () => null);

    // Assert
    expect(result.stdout).toContain("PASS  repo connected");
    expect(result.stdout).toContain("present and tracked");
  });

  test("an untracked config says so without crying wolf", async () => {
    // Arrange
    const repo = await repoIn("repo-connected-untracked", "untracked");
    const home = await makeHome("repo-connected-untracked");
    paths.push(home);

    // Act
    const result = await runDoctor(doctorEnv(home), repo, async () => null);

    // Assert
    expect(result.stdout).toContain("PASS  repo connected");
    expect(result.stdout).toContain("teammates' sessions stay silent");
  });

  test("an absent config WARNs and names the command that fixes it", async () => {
    // Arrange
    const repo = await repoIn("repo-connected-absent", "absent");
    const home = await makeHome("repo-connected-absent");
    paths.push(home);

    // Act
    const result = await runDoctor(doctorEnv(home), repo, async () => null);

    // Assert
    expect(result.stdout).toContain("WARN  repo connected");
    expect(result.stdout).toContain("run crosscheck init");
  });
});
