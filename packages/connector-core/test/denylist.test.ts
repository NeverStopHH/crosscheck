import { describe, expect, test } from "bun:test";

import { DEFAULT_DENYLIST, isDenied, resolveDenylist } from "../src/index.ts";

describe("denylist", () => {
  test("filters lockfiles, build output and generated clients", () => {
    // Arrange
    const denied = [
      "bun.lock",
      "package-lock.json",
      "dist/x.js",
      "packages/api-client/src/Api.gen.ts",
      "node_modules/zod/index.js",
      "assets/logo.png",
      ".env.local",
      "coverage/lcov.info",
    ];

    // Act & Assert
    for (const path of denied) {
      expect(isDenied(path, DEFAULT_DENYLIST)).toBe(true);
    }
  });

  test("keeps ordinary source files", () => {
    // Arrange
    const kept = [
      "src/a.ts",
      "src/api/handler.ts",
      "docs/DESIGN.md",
    ];

    // Act & Assert
    for (const path of kept) {
      expect(isDenied(path, DEFAULT_DENYLIST)).toBe(false);
    }
  });

  test("extend mode adds to the defaults", () => {
    // Arrange
    const patterns = resolveDenylist({ mode: "extend", patterns: ["**/*.sql"] });

    // Act & Assert
    expect(isDenied("db/seed.sql", patterns)).toBe(true);
    expect(isDenied("bun.lock", patterns)).toBe(true);
  });

  test("replace mode honours only the configured patterns", () => {
    // Arrange
    const patterns = resolveDenylist({
      mode: "replace",
      patterns: ["**/*.sql"],
    });

    // Act & Assert
    expect(isDenied("db/seed.sql", patterns)).toBe(true);
    expect(isDenied("bun.lock", patterns)).toBe(false);
  });
});
