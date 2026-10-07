/**
 * `readText` keeps apart the states `readTextOrNull` folds into one null: a
 * file that is ABSENT, and one that exists but cannot be read (review
 * 2026-10-05). The second review found a file inside an untraversable
 * directory still reading as absent — `Bun.file().exists()` answers false on
 * EACCES — so a mode-000 `~/.claude` read as "no user-level install".
 *
 * Root ignores permission bits, so the locked cases cannot be staged as root.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readText } from "../src/config/paths.ts";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0, dirs.length)) {
    await chmod(dir, 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-read-text-"));
  dirs.push(dir);
  return dir;
};

const isRoot = process.getuid?.() === 0;

describe("readText", () => {
  test("a missing file is absent, and so is a path under a missing directory", async () => {
    // Arrange
    const dir = await tempDir();

    // Act + Assert
    expect(await readText(join(dir, "settings.json"))).toEqual({ kind: "absent" });
    expect(await readText(join(dir, "nowhere", "settings.json"))).toEqual({ kind: "absent" });
  });

  test("a readable file is its text", async () => {
    // Arrange
    const dir = await tempDir();
    await writeFile(join(dir, "settings.json"), "{}\n", "utf8");

    // Act + Assert
    expect(await readText(join(dir, "settings.json"))).toEqual({ kind: "text", text: "{}\n" });
  });

  test("a directory where a file should be is unreadable, not absent", async () => {
    // Arrange
    const dir = await tempDir();
    await mkdir(join(dir, "settings.json"));

    // Act + Assert
    expect(await readText(join(dir, "settings.json"))).toEqual({ kind: "unreadable" });
  });

  test.skipIf(isRoot)("a mode-000 file is unreadable", async () => {
    // Arrange
    const dir = await tempDir();
    const path = join(dir, "settings.json");
    await writeFile(path, "{}\n", "utf8");
    await chmod(path, 0o000);

    // Act
    const read = await readText(path);
    await chmod(path, 0o600);

    // Assert
    expect(read).toEqual({ kind: "unreadable" });
  });

  test.skipIf(isRoot)("a file inside a mode-000 directory is unreadable, not absent", async () => {
    // Arrange: the locked ~/.claude shape
    const dir = await tempDir();
    const claudeDir = join(dir, ".claude");
    await mkdir(claudeDir);
    await writeFile(join(claudeDir, "settings.json"), "{}\n", "utf8");
    await chmod(claudeDir, 0o000);

    // Act
    const read = await readText(join(claudeDir, "settings.json"));
    await chmod(claudeDir, 0o755);

    // Assert
    expect(read).toEqual({ kind: "unreadable" });
  });
});
