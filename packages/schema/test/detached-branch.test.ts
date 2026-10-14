/**
 * The detached-HEAD spelling is a WIRE fact: a connector writes it as the
 * session's branch (connector-core git/repo-identity.ts resolveBranch) and the
 * hub reads it back — a detached session's base commit reaching the default
 * branch is never its work landing (server services/landed.ts). One
 * predicate, here, for both sides.
 */
import { describe, expect, test } from "bun:test";

import {
  DETACHED_BRANCH_PREFIX,
  UNNAMED_HEAD_BRANCH,
  isDetachedBranch,
} from "../src/index.ts";

describe("isDetachedBranch, as the hub reads a session's branch", () => {
  test("a detached ref and the unnamed HEAD are detached; a branch is not", () => {
    // Arrange + Act + Assert
    expect(isDetachedBranch(`${DETACHED_BRANCH_PREFIX}51eae4d8f`)).toBe(true);
    expect(isDetachedBranch(UNNAMED_HEAD_BRANCH)).toBe(true);
    expect(isDetachedBranch("feat/false-landed-stamp")).toBe(false);
    expect(isDetachedBranch(`${DETACHED_BRANCH_PREFIX}release`)).toBe(false);
  });
});
