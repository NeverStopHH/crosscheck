/**
 * Whether a session's branch IS the default branch a landed report names — in
 * ONE place both sides read: the connector skips landed collection from such
 * a session, and the hub never stamps its context by base ancestry.
 */
import { describe, expect, test } from "bun:test";

import { isDefaultBranch } from "../src/index.ts";

describe("isDefaultBranch", () => {
  test("the local name and the remote-tracking spelling both match", () => {
    // Arrange + Act + Assert
    expect(isDefaultBranch("main", "origin/main")).toBe(true);
    expect(isDefaultBranch("origin/main", "origin/main")).toBe(true);
    expect(isDefaultBranch("main", "main")).toBe(true);
  });

  test("another branch, or no known default, is not the default branch", () => {
    // Arrange + Act + Assert
    expect(isDefaultBranch("feat/main-menu", "origin/main")).toBe(false);
    expect(isDefaultBranch("release/main", "origin/main")).toBe(false);
    expect(isDefaultBranch("main", null)).toBe(false);
  });
});
