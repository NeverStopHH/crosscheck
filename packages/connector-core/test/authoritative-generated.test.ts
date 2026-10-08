/**
 * `authoritativeGenerated` in the committed `.crosscheck.json`
 * (capture/authoritative-generated.ts): every entry validated, the list
 * bounded, and the trust rule for the file kept — read from the root that
 * makes the repo reportable and nowhere else, and never able to make that
 * repo unreportable.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import {
  isDeclaredAuthoritative,
  parseAuthoritativeGenerated,
  readAuthoritativeGenerated,
} from "../src/capture/authoritative-generated.ts";
import { readRepoConfig } from "../src/config/repo-config.ts";
import {
  MAX_AUTHORITATIVE_GENERATED_GLOBS,
  MAX_AUTHORITATIVE_GLOB_CHARS,
  MAX_AUTHORITATIVE_GLOB_WILDCARDS,
} from "../src/constants.ts";
import { makeRepo, writeRepoFile } from "./helpers.ts";

const HUB = "http://127.0.0.1:9";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
  cleanups.length = 0;
});

const repoWith = async (label: string, config: unknown): Promise<string> => {
  const repo = await makeRepo(label);
  cleanups.push(repo);
  await writeRepoFile(repo, ".crosscheck.json", `${JSON.stringify(config)}\n`);
  return repo;
};

describe("parseAuthoritativeGenerated — validated and bounded", () => {
  test("no field declares nothing", () => {
    const parsed = parseAuthoritativeGenerated({ hubUrl: HUB });

    expect(parsed.declared).toBe(false);
    expect(parsed.globs).toEqual([]);
  });

  test("valid repo-relative globs are honoured, in order, and match", () => {
    // Act
    const parsed = parseAuthoritativeGenerated({
      hubUrl: HUB,
      authoritativeGenerated: ["api/openapi.json", "migrations/**", "clients/**"],
    });

    // Assert
    expect(parsed.globs).toEqual(["api/openapi.json", "migrations/**", "clients/**"]);
    expect(parsed.refused).toEqual([]);
    expect(isDeclaredAuthoritative("api/openapi.json", parsed)).toBe(true);
    expect(isDeclaredAuthoritative("migrations/2026/0001_init.sql", parsed)).toBe(true);
    expect(isDeclaredAuthoritative("clients/go/api.pb.go", parsed)).toBe(true);
    expect(isDeclaredAuthoritative("src/api.ts", parsed)).toBe(false);
  });

  test("every malformed entry is refused with its reason, and the valid ones still count", () => {
    // Arrange
    const entries = [
      42,
      "   ",
      "x".repeat(MAX_AUTHORITATIVE_GLOB_CHARS + 1),
      "/etc/openapi.json",
      "../outside/**",
      "clients\\win\\**",
      "clients/\u0007bell",
      `${"*/".repeat(MAX_AUTHORITATIVE_GLOB_WILDCARDS)}*`,
      "clients/**",
    ];

    // Act
    const parsed = parseAuthoritativeGenerated({ hubUrl: HUB, authoritativeGenerated: entries });

    // Assert
    expect(parsed.globs).toEqual(["clients/**"]);
    expect(parsed.refused.map((entry) => entry.reason)).toEqual([
      "not a string",
      "empty",
      `longer than ${String(MAX_AUTHORITATIVE_GLOB_CHARS)} characters`,
      "absolute — globs are repo-relative",
      "climbs out of the repo with ..",
      "contains a backslash or a control character",
      "contains a backslash or a control character",
      `more than ${String(MAX_AUTHORITATIVE_GLOB_WILDCARDS)} wildcards`,
    ]);
    expect(parsed.refused.every((entry) => entry.glob.length <= MAX_AUTHORITATIVE_GLOB_CHARS)).toBe(true);
  });

  test("a field that is not a list is declared, refused whole, and honours nothing", () => {
    const parsed = parseAuthoritativeGenerated({ hubUrl: HUB, authoritativeGenerated: "clients/**" });

    expect(parsed.declared).toBe(true);
    expect(parsed.globs).toEqual([]);
    expect(parsed.refused[0]?.reason).toBe("not a list of globs");
  });

  test("past the cap, the rest are ignored and COUNTED", () => {
    // Arrange
    const many = Array.from({ length: MAX_AUTHORITATIVE_GENERATED_GLOBS + 5 }, (_unused, index) => `clients/c${String(index)}/**`);

    // Act
    const parsed = parseAuthoritativeGenerated({ hubUrl: HUB, authoritativeGenerated: many });

    // Assert
    expect(parsed.globs).toHaveLength(MAX_AUTHORITATIVE_GENERATED_GLOBS);
    expect(parsed.overCap).toBe(5);
    expect(isDeclaredAuthoritative(`clients/c${String(MAX_AUTHORITATIVE_GENERATED_GLOBS)}/x.ts`, parsed)).toBe(false);
  });
});

describe("the trust rule for .crosscheck.json holds", () => {
  test("a malformed declaration costs the declaration, never the repo: it stays reportable", async () => {
    // Arrange: a field no part of it can be honoured.
    const repo = await repoWith("auth-malformed", { hubUrl: HUB, authoritativeGenerated: { not: "a list" } });

    // Act
    const config = await readRepoConfig(repo);
    const declared = await readAuthoritativeGenerated(repo);

    // Assert: the hub URL is still read; the declaration honours nothing.
    expect(config?.hubUrl).toBe(HUB);
    expect(declared.globs).toEqual([]);
    expect(declared.refused).toHaveLength(1);
  });

  test("read from the ROOT's committed file only — a nested .crosscheck.json declares nothing", async () => {
    // Arrange: the root declares nothing; a subdirectory carries its own file.
    const repo = await repoWith("auth-nested", { hubUrl: HUB });
    await writeRepoFile(repo, "clients/.crosscheck.json", `${JSON.stringify({ hubUrl: HUB, authoritativeGenerated: ["**"] })}\n`);

    // Act
    const declared = await readAuthoritativeGenerated(repo);

    // Assert
    expect(declared.declared).toBe(false);
    expect(isDeclaredAuthoritative("clients/api.generated.ts", declared)).toBe(false);
  });

  test("an absent or unparseable file declares nothing", async () => {
    const repo = await makeRepo("auth-absent");
    cleanups.push(repo);
    expect((await readAuthoritativeGenerated(repo)).declared).toBe(false);
    await writeRepoFile(repo, ".crosscheck.json", "{ not json");
    expect((await readAuthoritativeGenerated(repo)).declared).toBe(false);
  });
});
