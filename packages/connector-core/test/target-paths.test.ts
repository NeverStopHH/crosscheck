/**
 * `toRepoRelative` is a CROSS-CONNECTOR identity function, not a Claude hook
 * detail: the repo-relative POSIX path it derives IS the target id teammates
 * match on, so two connectors deriving it differently would silently split
 * cross-agent target matching — the same argument that keeps `fingerprint()`
 * single-copy (DESIGN-agent-agnostic.md §1.2: "one implementation is the
 * point"). It therefore lives in core capture/ and reaches connectors through
 * the kit; the pins here are the behavior the Claude hooks shipped with.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { toRepoRelative } from "../src/capture/target-paths.ts";

describe("toRepoRelative", () => {
  test("resolves a relative path against cwd inside the repo", async () => {
    expect(await toRepoRelative("/repo", "/repo", "src/a.ts")).toBe("src/a.ts");
    expect(await toRepoRelative("/repo", "/repo/src", "deep/b.ts")).toBe(
      "src/deep/b.ts",
    );
  });

  test("resolves an absolute path inside the repo", async () => {
    expect(await toRepoRelative("/repo", "/anywhere", "/repo/src/a.ts")).toBe(
      "src/a.ts",
    );
  });

  test("returns null for paths outside the repo root", async () => {
    expect(await toRepoRelative("/repo", "/repo", "../outside.ts")).toBeNull();
    expect(await toRepoRelative("/repo", "/repo", "/etc/passwd")).toBeNull();
  });

  test("returns null for the repo root itself — a root is not a target", async () => {
    expect(await toRepoRelative("/repo", "/repo", "/repo")).toBeNull();
  });

  test("falls back to realpath so a symlinked worktree derives the same id", async () => {
    // Arrange: macOS hands out symlinked cwds routinely (/tmp → /private/tmp),
    // and an editor may address the repo through either name. Without the
    // fallback the two spellings derive DIFFERENT target ids and cross-agent
    // matching splits — the exact failure mode this module exists to prevent.
    const scratch = await mkdtemp(join(tmpdir(), "cx-target-paths-"));
    try {
      const real = join(scratch, "real-repo");
      await mkdir(join(real, "src"), { recursive: true });
      const link = join(scratch, "linked-repo");
      await symlink(real, link);
      const resolvedReal = await realpath(real);

      // Act + Assert: repo addressed via the symlink, file via the real path
      // (and the reverse) both land on the same repo-relative id.
      expect(
        await toRepoRelative(link, link, join(resolvedReal, "src", "a.ts")),
      ).toBe("src/a.ts");
      expect(
        await toRepoRelative(resolvedReal, resolvedReal, join(link, "src", "a.ts")),
      ).toBe("src/a.ts");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
