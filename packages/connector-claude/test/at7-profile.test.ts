import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkShellProfiles,
  profilePaths,
  watchedProfileNames,
} from "../bench/at7/profile.ts";

/**
 * A2.2 residue: the Bash tool sources the user's shell profile, so the env
 * allowlist does not bound what that profile sets. The manifest records a
 * check that no profile file sets or exports a CROSSCHECK_, CLAUDE_ or
 * ANTHROPIC_ variable. Names only — a value is never read into the record.
 * Hermetic: every file lives in a temp dir; ~ is never touched.
 */
describe("watchedProfileNames", () => {
  test.each([
    ["export CLAUDE_CODE_EFFORT=high", ["CLAUDE_CODE_EFFORT"]],
    ["ANTHROPIC_BASE_URL=https://proxy.example", ["ANTHROPIC_BASE_URL"]],
    ["typeset -x CROSSCHECK_HUB_URL=https://hub.example", ["CROSSCHECK_HUB_URL"]],
    ["export CROSSCHECK_HUB_URL", ["CROSSCHECK_HUB_URL"]],
    ["export PATH=$HOME/bin:$PATH CLAUDE_X", ["CLAUDE_X"]],
    ["alias c='CLAUDE_CODE_SIMPLE=1 claude'", ["CLAUDE_CODE_SIMPLE"]],
  ])("flags %j", (line, expected) => {
    // Act / Assert
    expect(watchedProfileNames(line)).toEqual(expected);
  });

  test.each([
    "# export CLAUDE_CODE_EFFORT=high",
    'echo "$CLAUDE_CODE_EFFORT"',
    "export PATH=$HOME/bin:$PATH",
    "MY_CLAUDE_TOOL=1",
    "if [ -n \"${ANTHROPIC_API_KEY}\" ]; then :; fi",
  ])("does not flag %j", (line) => {
    // Act / Assert
    expect(watchedProfileNames(line)).toEqual([]);
  });

  test("returns names only, never the value", () => {
    // Act
    const names = watchedProfileNames("export ANTHROPIC_API_KEY=placeholder-value-123");

    // Assert
    expect(names).toEqual(["ANTHROPIC_API_KEY"]);
    expect(JSON.stringify(names)).not.toContain("placeholder-value-123");
  });
});

describe("profilePaths", () => {
  test("names the zsh and bash profiles under home, then the system files", () => {
    // Act
    const paths = profilePaths("/home/someone", undefined);

    // Assert
    expect(paths).toContain("/home/someone/.zshrc");
    expect(paths).toContain("/home/someone/.zshenv");
    expect(paths).toContain("/home/someone/.bash_profile");
    expect(paths).toContain("/etc/zshenv");
  });

  test("adds ZDOTDIR's zsh files when it differs from home", () => {
    // Act
    const paths = profilePaths("/home/someone", "/home/someone/.config/zsh");

    // Assert
    expect(paths).toContain("/home/someone/.config/zsh/.zshrc");
  });
});

describe("checkShellProfiles", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "profile-check-"));
    await writeFile(join(dir, "clean.zshrc"), "export PATH=$HOME/bin:$PATH\n", "utf8");
    await writeFile(join(dir, "dirty.zshenv"), "export CLAUDE_CODE_EFFORT=xhigh\n", "utf8");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a set of clean or absent files is clean", async () => {
    // Act
    const check = await checkShellProfiles([join(dir, "clean.zshrc"), join(dir, "absent")]);

    // Assert
    expect(check.clean).toBe(true);
    expect(check.files.map((f) => f.present)).toEqual([true, false]);
    expect(check.prefixes).toEqual(["CROSSCHECK_", "CLAUDE_", "ANTHROPIC_"]);
  });

  test("a file that exports a watched variable makes the check unclean and names it", async () => {
    // Act
    const check = await checkShellProfiles([join(dir, "clean.zshrc"), join(dir, "dirty.zshenv")]);

    // Assert
    expect(check.clean).toBe(false);
    expect(check.files[1]?.watched).toEqual(["CLAUDE_CODE_EFFORT"]);
  });
});
