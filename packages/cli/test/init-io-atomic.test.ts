/**
 * `writeConfigAtomically` (cli/init-io.ts) — the inits' temp-and-rename
 * write for files that keep their own mode, so it cannot be writePrivateFile
 * (which forces 0600 on a committed `.claude/settings.json` or `.mcp.json`).
 *
 * Review 2026-10-06 (L4): it hand-copied the temp shape instead of calling
 * `tempSibling`, and a write or rename that threw left the temp behind —
 * the defect writePrivateFile was fixed for, in its second copy. Temp
 * directories only; the two failures nothing on disk can arrange (a write
 * that dies part-way) are injected with `spyOn` on node:fs/promises and
 * restored in `finally`.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { isTempSiblingName } from "@crosscheck/connector-core/config/paths.ts";
import { writeConfigAtomically } from "../src/cli/init-io.ts";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-init-io-"));
  dirs.push(dir);
  return dir;
};

const failureOf = (write: Promise<void>): Promise<unknown> =>
  write.then(
    () => null,
    (thrown: unknown) => thrown,
  );

describe("writeConfigAtomically", () => {
  test("names its temp exactly as tempSibling does, beside the target", async () => {
    // Arrange: watch the rename to see which temp it moves
    const dir = await tempDir();
    const target = join(dir, "settings.json");
    const realRename = fsPromises.rename;
    const renamed: string[] = [];
    const spy = spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
      renamed.push(String(from));
      await realRename(from, to);
    });

    try {
      // Act
      await writeConfigAtomically(target, "{}\n");
    } finally {
      spy.mockRestore();
    }

    // Assert
    expect(renamed).toHaveLength(1);
    expect(dirname(renamed[0] ?? "")).toBe(dir);
    expect(isTempSiblingName(basename(renamed[0] ?? ""))).toBe(true);
  });

  test("a rename that fails removes the temp and rethrows the rename's own error", async () => {
    // Arrange: a directory where the file should be
    const dir = await tempDir();
    const target = join(dir, "settings.json");
    await mkdir(join(target, "occupied"), { recursive: true });

    // Act
    const error = await failureOf(writeConfigAtomically(target, "{}\n"));

    // Assert
    expect((error as NodeJS.ErrnoException).syscall).toBe("rename");
    expect(await readdir(dir)).toEqual(["settings.json"]);
  });

  test("a write that dies part-way removes the temp and rethrows", async () => {
    // Arrange: the temp is created and half-written, then the disk fills
    const dir = await tempDir();
    const target = join(dir, "settings.json");
    const realWriteFile = fsPromises.writeFile;
    const spy = spyOn(fsPromises, "writeFile").mockImplementation(async (path, data) => {
      await realWriteFile(path, String(data).slice(0, 1));
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    });

    try {
      // Act
      const error = await failureOf(writeConfigAtomically(target, "{}\n"));

      // Assert
      expect((error as NodeJS.ErrnoException).code).toBe("ENOSPC");
      expect(await readdir(dir)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
