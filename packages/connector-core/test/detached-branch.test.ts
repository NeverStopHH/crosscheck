/**
 * A detached HEAD is spelled `detached@<sha>` (git/repo-identity.ts
 * resolveBranch) — and `detached@release` is a legal git branch name. The
 * predicate every teammate listing groups by must tell the two apart, or a
 * real branch folds into the one detached-HEAD topic.
 */
import { describe, expect, test } from "bun:test";

import { isDetachedBranch, isDetachedTitleHead } from "../src/git/detached-branch.ts";

const FULL_SHA = "f".repeat(40);
/** A repository on git's SHA-256 object format names commits in 64 hex digits. */
const FULL_SHA256 = "e".repeat(64);

describe("isDetachedBranch matches what resolveBranch writes, exactly", () => {
  test("a detached ref, short or full, and the unnamed HEAD are detached", () => {
    expect(isDetachedBranch("detached@abc1234")).toBe(true);
    expect(isDetachedBranch(`detached@${FULL_SHA}`)).toBe(true);
    expect(isDetachedBranch("HEAD")).toBe(true);
  });

  test("a SHA-256 repository's full detached ref is detached too", () => {
    expect(isDetachedBranch(`detached@${FULL_SHA256}`)).toBe(true);
  });

  test("a branch that merely starts with the prefix is a branch", () => {
    expect(isDetachedBranch("detached@release")).toBe(false);
    expect(isDetachedBranch("detached@abc1234-hotfix")).toBe(false);
    expect(isDetachedBranch("detached@ABC1234")).toBe(false);
    expect(isDetachedBranch("detached@")).toBe(false);
    // Shorter than git ever abbreviates, longer than any object id (SHA-256).
    expect(isDetachedBranch("detached@abc")).toBe(false);
    expect(isDetachedBranch(`detached@${FULL_SHA256}0`)).toBe(false);
  });
});

describe("isDetachedTitleHead reads the ref a detached fallback title opens with", () => {
  test("with or without the commit subject composeDetachedTitle appends", () => {
    expect(isDetachedTitleHead("detached@abc1234")).toBe(true);
    expect(isDetachedTitleHead("detached@abc1234 · Fix flaky test")).toBe(true);
    expect(isDetachedTitleHead("HEAD")).toBe(true);
  });

  test("a branch named like a detached ref stays a branch in a title too", () => {
    expect(isDetachedTitleHead("detached@release · Cut 2.0")).toBe(false);
    expect(isDetachedTitleHead("detached@release")).toBe(false);
  });
});
