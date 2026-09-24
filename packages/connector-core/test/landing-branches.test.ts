/**
 * WHERE WORK "LANDS" IS THE TEAM'S CALL, NOT CROSSCHECK'S.
 *
 * Not every company merges into `main` and `staging`. The committed
 * `.crosscheck.json` may name the branches work is merged into
 * (`"landingBranches": ["main", "staging"]`); without that list, the
 * default branch plus whichever of `staging` and `develop` exist on origin
 * are used (docs/1.0/landed-changes.md, decision 4).
 *
 * And the list must never cost the team its hub: `.crosscheck.json` is also
 * where every hook learns the hub URL, so a typo in `landingBranches` has to
 * leave that file readable — a rejected file would switch every hook off
 * without a word.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readRepoConfig } from "../src/config/repo-config.ts";
import {
  parseLandingBranches,
  readLandingBranches,
  resolveLandingRefs,
} from "../src/landed-changes/landing-branches.ts";
import { makeLandingRepos } from "./fixtures/landing-repos.ts";

const cleanups: string[] = [];

afterAll(async () => {
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

describe("parseLandingBranches", () => {
  test("a listed set of branches is the team's choice", () => {
    expect(parseLandingBranches({ hubUrl: "x", landingBranches: ["main", "staging"] })).toEqual({
      kind: "configured",
      branches: ["main", "staging"],
    });
  });

  test("an empty list switches landed-change warnings off", () => {
    expect(parseLandingBranches({ hubUrl: "x", landingBranches: [] })).toEqual({
      kind: "configured",
      branches: [],
    });
  });

  test("no list means auto-detection", () => {
    expect(parseLandingBranches({ hubUrl: "x" })).toEqual({ kind: "auto" });
    expect(parseLandingBranches(null)).toEqual({ kind: "auto" });
  });

  test("a name git would read as a flag or a range is refused, and says so", () => {
    for (const bad of [["-rf"], ["main..staging"], ["release/"], [42], "staging"]) {
      const setting = parseLandingBranches({ hubUrl: "x", landingBranches: bad });

      expect(setting.kind).toBe("invalid");
    }
  });

  test("a bad list leaves the hub URL readable", async () => {
    // Arrange
    const repos = await makeLandingRepos("bad-list");
    cleanups.push(repos.base);
    await writeFile(
      join(repos.reader, ".crosscheck.json"),
      JSON.stringify({ hubUrl: "https://hub.example", landingBranches: ["-rf"] }),
    );

    // Act
    const repoConfig = await readRepoConfig(repos.reader);
    const setting = await readLandingBranches(repos.reader);

    // Assert
    expect(repoConfig?.hubUrl).toBe("https://hub.example");
    expect(setting.kind).toBe("invalid");
  });
});

describe("resolveLandingRefs", () => {
  test("auto-detection finds the default branch and staging, and skips a develop that does not exist", async () => {
    // Arrange
    const repos = await makeLandingRepos("auto", ["staging"]);
    cleanups.push(repos.base);

    // Act
    const refs = await resolveLandingRefs(repos.reader, { kind: "auto" });

    // Assert
    expect(refs?.map(({ branch, ref }) => ({ branch, ref }))).toEqual([
      { branch: "main", ref: "refs/remotes/origin/main" },
      { branch: "staging", ref: "refs/remotes/origin/staging" },
    ]);
  });

  test("a team's own names are used as given, and a name origin does not have is skipped", async () => {
    // Arrange — this team integrates into `integration`, not staging
    const repos = await makeLandingRepos("configured", ["integration", "staging"]);
    cleanups.push(repos.base);

    // Act
    const refs = await resolveLandingRefs(repos.reader, {
      kind: "configured",
      branches: ["integration", "release"],
    });

    // Assert — and each carries the commit it points at
    expect(refs?.map(({ branch, ref }) => ({ branch, ref }))).toEqual([
      { branch: "integration", ref: "refs/remotes/origin/integration" },
    ]);
    expect(refs?.[0]?.tip).toMatch(/^[0-9a-f]{40}$/);
  });

  test("an invalid list falls back to auto-detection rather than to nothing", async () => {
    // Arrange
    const repos = await makeLandingRepos("invalid-fallback", ["staging"]);
    cleanups.push(repos.base);

    // Act
    const refs = await resolveLandingRefs(repos.reader, { kind: "invalid", reason: "x" });

    // Assert
    expect(refs?.map((ref) => ref.branch)).toEqual(["main", "staging"]);
  });

  test("a clone with no origin has no landing branches", async () => {
    // Arrange — Mike's clone with its remote removed
    const repos = await makeLandingRepos("no-origin");
    cleanups.push(repos.base);
    const { gitIn } = await import("./fixtures/landing-repos.ts");
    await gitIn(repos.teammate, ["remote", "remove", "origin"]);

    // Act
    const refs = await resolveLandingRefs(repos.teammate, { kind: "auto" });

    // Assert
    expect(refs).toEqual([]);
  });
});
