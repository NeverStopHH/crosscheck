/**
 * Abandoned temp siblings (pilot finding, 2026-10-06).
 *
 * `writePrivateFile` writes `<path>.tmp-<pid>-<rand>` and renames it over
 * `<path>`. A pilot machine had 40 such files in `state/` (0.7 h to 925 h
 * old, 0 or 237 bytes), 3 in `sessions/` and a `.pending-end` one in its
 * spool, and was still producing them: a hook binary exits the moment its
 * budget race answers, abandoning a write between its `writeFile` and its
 * `rename`, and a write whose `rename` threw never removed its temp at all.
 * Nothing swept them, so they grew without bound.
 *
 * Temp homes only (helpers.ts makeHome); the clock is injected, and every
 * age below is set on the file with `utimes` against that clock.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { ABANDONED_TEMP_MAX_AGE_MS } from "../src/constants.ts";
import {
  presenceCachePath,
  sessionStatePathForSlug,
  spoolCursorPath,
  spoolPendingEndPath,
  syncStatePath,
  tempSibling,
  writePrivateFile,
} from "../src/config/paths.ts";
import { sweepAbandonedTemps } from "../src/state/temp-sweep.ts";
import { makeHome } from "./helpers.ts";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const KEY = "0123456789abcdef";
const OTHER_KEY = "fedcba9876543210";
const SLUG = "session-1";
const MINUTE_MS = 60_000;
const ABANDONED_MS = ABANDONED_TEMP_MAX_AGE_MS + MINUTE_MS;
const IN_FLIGHT_MS = ABANDONED_TEMP_MAX_AGE_MS - MINUTE_MS;

const isRoot = process.getuid?.() === 0;

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
  homes.length = 0;
});

const tempHome = async (label: string): Promise<string> => {
  const home = await makeHome(label);
  homes.push(home);
  return home;
};

/** A file whose mtime is `ageMs` before NOW, its directory created as needed. */
const seed = async (path: string, ageMs: number): Promise<string> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "{}\n", "utf8");
  const when = new Date(NOW.getTime() - ageMs);
  await utimes(path, when, when);
  return path;
};

const exists = (path: string): Promise<boolean> => Bun.file(path).exists();

describe("writePrivateFile when a step after creating the temp fails", () => {
  test("removes its temp sibling and rethrows the original error", async () => {
    // Arrange: a directory where the file should be, so the rename throws
    const home = await tempHome("temp-cleanup");
    const target = syncStatePath(home, KEY);
    await mkdir(join(target, "occupied"), { recursive: true });

    // Act
    const error: unknown = await writePrivateFile(target, "{}\n").then(
      () => null,
      (thrown: unknown) => thrown,
    );

    // Assert: the rename's own error reached the caller, and nothing but the
    // pre-existing directory is left beside it
    expect(error).toBeInstanceOf(Error);
    expect((error as NodeJS.ErrnoException).syscall).toBe("rename");
    expect(await readdir(dirname(target))).toEqual([basename(target)]);
  });
});

describe("sweepAbandonedTemps covers every directory writePrivateFile litters", () => {
  test("an abandoned temp in state/ goes; the file it was replacing stays", async () => {
    // Arrange
    const home = await tempHome("sweep-state");
    const real = await seed(syncStatePath(home, KEY), ABANDONED_MS);
    const temp = await seed(tempSibling(real), ABANDONED_MS);

    // Act
    await sweepAbandonedTemps(home, NOW);

    // Assert
    expect(await exists(temp)).toBe(false);
    expect(await exists(real)).toBe(true);
  });

  test("an abandoned temp in sessions/ goes; the session state stays", async () => {
    // Arrange
    const home = await tempHome("sweep-sessions");
    const real = await seed(sessionStatePathForSlug(home, SLUG), ABANDONED_MS);
    const temp = await seed(tempSibling(real), ABANDONED_MS);

    // Act
    await sweepAbandonedTemps(home, NOW);

    // Assert
    expect(await exists(temp)).toBe(false);
    expect(await exists(real)).toBe(true);
  });

  test("an abandoned temp in cache/ goes; the presence cache stays", async () => {
    // Arrange
    const home = await tempHome("sweep-cache");
    const real = await seed(presenceCachePath(home, KEY), ABANDONED_MS);
    const temp = await seed(tempSibling(real), ABANDONED_MS);

    // Act
    await sweepAbandonedTemps(home, NOW);

    // Assert
    expect(await exists(temp)).toBe(false);
    expect(await exists(real)).toBe(true);
  });

  test("abandoned temps go from EVERY spool/<key>/, including a .pending-end marker's", async () => {
    // Arrange: two repos' spools — the marker's temp has the same shape
    // because SessionEnd writes the marker through writePrivateFile
    // (flows/end-session.ts)
    const home = await tempHome("sweep-spool");
    const marker = await seed(spoolPendingEndPath(home, KEY, SLUG), ABANDONED_MS);
    const markerTemp = await seed(tempSibling(marker), ABANDONED_MS);
    const cursor = await seed(spoolCursorPath(home, OTHER_KEY, SLUG), ABANDONED_MS);
    const cursorTemp = await seed(tempSibling(cursor), ABANDONED_MS);

    // Act
    await sweepAbandonedTemps(home, NOW);

    // Assert
    expect(await exists(markerTemp)).toBe(false);
    expect(await exists(cursorTemp)).toBe(false);
    expect(await exists(marker)).toBe(true);
    expect(await exists(cursor)).toBe(true);
  });
});

describe("sweepAbandonedTemps deletes only what is certainly abandoned", () => {
  test("a temp younger than ABANDONED_TEMP_MAX_AGE_MS stays: its writer may still rename it", async () => {
    // Arrange
    const home = await tempHome("sweep-young");
    const temp = await seed(tempSibling(syncStatePath(home, KEY)), IN_FLIGHT_MS);

    // Act
    await sweepAbandonedTemps(home, NOW);

    // Assert
    expect(await exists(temp)).toBe(true);
  });

  test("a file that is not exactly the temp shape is never touched, however old", async () => {
    // Arrange: the real names that live in state/, and every near miss of
    // `<name>.tmp-<digits>-<base36, at most 8>` — all of them ancient
    const home = await tempHome("sweep-shape");
    const state = dirname(syncStatePath(home, KEY));
    const names = [
      `${KEY}.json`,
      `${KEY}-hooks.json`,
      `${KEY}-conference.json.lock`,
      "notes.tmp",
      "notes.tmp-",
      "notes.tmp-123",
      "notes.tmp-123-",
      "notes.tmp-12a-abcdefgh",
      "notes.tmp-123-ABCDEFGH",
      "notes.tmp-123-abcdefghi",
      "notes.tmp-123-abcdefgh.json",
      "notes.tmp-123-abc_def",
      "notes.bak-123-abcdefgh",
      ".tmp-123-abcdefgh",
    ];
    for (const name of names) {
      await seed(join(state, name), 100 * ABANDONED_MS);
    }
    const shapedDirectory = join(state, `${KEY}.json.tmp-123-abcdefgh`);
    await mkdir(shapedDirectory);
    const when = new Date(NOW.getTime() - 100 * ABANDONED_MS);
    await utimes(shapedDirectory, when, when);

    // Act
    await sweepAbandonedTemps(home, NOW);

    // Assert
    expect((await readdir(state)).sort()).toEqual(
      [...names, basename(shapedDirectory)].sort(),
    );
  });
});

describe("sweepAbandonedTemps never fails its caller", () => {
  test("a home with none of the directories is a no-op", async () => {
    // Arrange
    const home = await tempHome("sweep-empty");

    // Act + Assert
    expect(await sweepAbandonedTemps(home, NOW)).toBeUndefined();
  });

  test.skipIf(isRoot)("a temp it may not remove is skipped and every other directory is still swept", async () => {
    // Arrange: state/ read-only, so its temp cannot be unlinked (EACCES)
    const home = await tempHome("sweep-eacces");
    const stuck = await seed(tempSibling(syncStatePath(home, KEY)), ABANDONED_MS);
    const free = await seed(tempSibling(sessionStatePathForSlug(home, SLUG)), ABANDONED_MS);
    await chmod(dirname(stuck), 0o500);

    try {
      // Act
      const outcome = await sweepAbandonedTemps(home, NOW).then(
        () => "resolved",
        () => "rejected",
      );

      // Assert
      expect(outcome).toBe("resolved");
      expect(await exists(stuck)).toBe(true);
      expect(await exists(free)).toBe(false);
    } finally {
      await chmod(dirname(stuck), 0o700);
    }
  });

  test("two sweeps at once both finish and the temp is gone", async () => {
    // Arrange
    const home = await tempHome("sweep-race");
    const temps = await Promise.all(
      ["a", "b", "c", "d"].map((slug) =>
        seed(tempSibling(sessionStatePathForSlug(home, slug)), ABANDONED_MS),
      ),
    );

    // Act
    const outcomes = await Promise.allSettled([
      sweepAbandonedTemps(home, NOW),
      sweepAbandonedTemps(home, NOW),
    ]);

    // Assert
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
    for (const temp of temps) {
      expect(await exists(temp)).toBe(false);
    }
  });
});
