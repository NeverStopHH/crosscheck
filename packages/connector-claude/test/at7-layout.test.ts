import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createWorkRoot,
  newAttemptId,
  pathWithout,
  relativeTo,
} from "../bench/at7/layout.ts";

/**
 * Where an attempt lives, and how its paths are read back:
 *   - M9: macOS `tmpdir()` is `/var/folders/…` but a child's cwd is the real
 *     `/private/var/folders/…`, so a path relativized against the unresolved
 *     root stayed absolute. The work root is realpath'd, and relativizing
 *     accepts both spellings.
 *   - A2.4: the working directory sits under an OPAQUE per-attempt id, and no
 *     agent-visible PATH entry names the harness checkout.
 */
describe("relativeTo", () => {
  test("strips the real root", () => {
    // Act / Assert
    expect(relativeTo("/private/var/x/slugkit", ["/private/var/x/slugkit/src/slug.ts"])).toEqual([
      "src/slug.ts",
    ]);
  });

  test("strips the /private-less alias of a real /private root", () => {
    // Act / Assert
    expect(relativeTo("/private/var/x/slugkit", ["/var/x/slugkit/test/slug.test.ts"])).toEqual([
      "test/slug.test.ts",
    ]);
  });

  test("strips the /private alias of an unresolved /var root", () => {
    // Act / Assert
    expect(relativeTo("/var/x/slugkit", ["/private/var/x/slugkit/src/slug.ts"])).toEqual([
      "src/slug.ts",
    ]);
  });

  test("leaves relative paths and paths outside the root as they are", () => {
    // Act / Assert
    expect(relativeTo("/r/slugkit", ["src/slug.ts", "/home/u/.crosscheck/config.json"])).toEqual([
      "src/slug.ts",
      "/home/u/.crosscheck/config.json",
    ]);
  });

  test("does not strip a sibling that merely shares the prefix", () => {
    // Act / Assert
    expect(relativeTo("/r/slugkit", ["/r/slugkit-other/x.ts"])).toEqual(["/r/slugkit-other/x.ts"]);
  });
});

describe("newAttemptId", () => {
  test("is twelve lowercase hex characters, which cannot spell a cue (A2.4)", () => {
    // Act
    const ids = Array.from({ length: 50 }, newAttemptId);

    // Assert
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{12}$/);
    }
    expect(new Set(ids).size).toBe(50);
  });
});

describe("pathWithout", () => {
  test("drops PATH entries inside the harness checkout, keeps the rest in order", () => {
    // Act
    const path = pathWithout(
      "/w/crosscheck-at7/node_modules/.bin:/usr/bin:/w/crosscheck-at7:/bin",
      "/w/crosscheck-at7",
    );

    // Assert
    expect(path).toBe("/usr/bin:/bin");
  });
});

describe("createWorkRoot", () => {
  let dir: string;
  let linked: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "layout-"));
    await mkdir(join(dir, "real"));
    linked = join(dir, "link");
    await symlink(join(dir, "real"), linked);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("creates <realpath(base)>/<id>, resolving every symlink in the base (M9)", async () => {
    // Act
    const root = await createWorkRoot(linked, "0123456789ab");

    // Assert
    expect(root).toBe(join(await realpath(join(dir, "real")), "0123456789ab"));
  });

  test("refuses an id whose directory already exists", async () => {
    // Arrange
    await createWorkRoot(linked, "aaaaaaaaaaaa");

    // Act / Assert
    expect(createWorkRoot(linked, "aaaaaaaaaaaa")).rejects.toThrow();
  });
});
