/**
 * A PROMPT WORD AS THE EXACT TIER MATCHES IT (hold-out review round 5, M1 and
 * M4): a stack trace's "(packages/api/src/auth/permissions.ts:27:13)" is the
 * path it names, and a conventional file name is told apart from the rest.
 */
import { describe, expect, test } from "bun:test";

import { exactTargetToken, isConventionalFileName } from "../src/exact-token.ts";

describe("a path as a trace or a link writes it is the path (M1)", () => {
  test.each([
    ["(packages/api/src/auth/permissions.ts:27:13)", "packages/api/src/auth/permissions.ts"],
    ["packages/api/src/auth/permissions.ts:27", "packages/api/src/auth/permissions.ts"],
    ["src/auth/session.ts:27:13,", "src/auth/session.ts"],
    ["file:///repo/src/auth/session.ts", "/repo/src/auth/session.ts"],
    ["src/auth/session.ts#L12", "src/auth/session.ts"],
    ["src/auth/session.ts#L12-L40", "src/auth/session.ts"],
    ["src/auth/session.ts#l12", "src/auth/session.ts"],
    ["`src/auth/session.ts`", "src/auth/session.ts"],
    ["\"lib/jwks.ts\".", "lib/jwks.ts"],
    ["[search.repository.ts]", "search.repository.ts"],
    ["(file:///repo/lib/jwks.ts#L3)", "/repo/lib/jwks.ts"],
  ])("%p is %p", (word, path) => {
    // Arrange, Act
    const token = exactTargetToken(word);

    // Assert
    expect(token).toBe(path);
  });

  test.each([
    ["src/auth/session.ts"],
    [".nvmrc"],
    [".github/workflows/ci.yml"],
    ["e3b0c44298fc1c149afbf4c8996fb924"],
    ["PermissionsGuard.canActivate"],
  ])("%p is left as written", (word) => {
    expect(exactTargetToken(word)).toBe(word);
  });
});

describe("a conventional file name is told apart (M4)", () => {
  test.each([["Dockerfile"], ["Makefile"], ["package.json"], ["README.md"], ["index.ts"], ["docker-compose.yml"], ["tsconfig.json"], [".gitignore"], [".nvmrc"]])(
    "%p is conventional",
    (name) => {
      expect(isConventionalFileName(name)).toBe(true);
    },
  );

  test.each([["docker/postgres/Dockerfile"], ["permissions.ts"], ["search.repository.ts"]])("%p is not", (name) => {
    expect(isConventionalFileName(name)).toBe(false);
  });
});
