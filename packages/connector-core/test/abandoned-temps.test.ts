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
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import { chmod, lstat, lutimes, mkdir, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  ABANDONED_TEMP_MAX_AGE_MS,
  ABANDONED_TEMP_SWEEP_MAX_PER_RUN,
} from "../src/constants.ts";
import {
  configPath,
  presenceCachePath,
  sessionStatePathForSlug,
  spoolCursorPath,
  spoolPendingEndPath,
  syncStatePath,
  tempSibling,
  writePrivateFile,
} from "../src/config/paths.ts";
import { sweepAbandonedTemps } from "../src/state/temp-sweep.ts";
import { makeHome, seedAbandonedTemps } from "./helpers.ts";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const KEY = "0123456789abcdef";
const OTHER_KEY = "fedcba9876543210";
const SLUG = "session-1";
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const ABANDONED_MS = ABANDONED_TEMP_MAX_AGE_MS + MINUTE_MS;
const IN_FLIGHT_MS = ABANDONED_TEMP_MAX_AGE_MS - MINUTE_MS;
/** A caller with all the time in the world: only the cap can stop the sweep. */
const ROOM = (): number => Number.POSITIVE_INFINITY;

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

  /**
   * The two failures no filesystem state can arrange on demand — a write that
   * dies part-way (ENOSPC) and a refused chmod — injected at the module
   * boundary. `spyOn` on node:fs/promises reaches paths.ts's named imports
   * in bun; each spy is restored in `finally`, so no other test sees it.
   */
  test("removes its temp when the write itself dies part-way, and rethrows", async () => {
    // Arrange: the temp is created and half-written, then the disk fills
    const home = await tempHome("temp-cleanup-write");
    const target = syncStatePath(home, KEY);
    await mkdir(dirname(target), { recursive: true });
    const realWriteFile = fsPromises.writeFile;
    const spy = spyOn(fsPromises, "writeFile").mockImplementation(async (path, data) => {
      await realWriteFile(path, String(data).slice(0, 1));
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    });

    try {
      // Act
      const error: unknown = await writePrivateFile(target, "{}\n").then(
        () => null,
        (thrown: unknown) => thrown,
      );

      // Assert: the write's own error, and no temp left behind
      expect((error as NodeJS.ErrnoException).code).toBe("ENOSPC");
      expect(await readdir(dirname(target))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  test("removes its temp when chmod is refused, and rethrows", async () => {
    // Arrange: the temp is written whole, then chmod fails
    const home = await tempHome("temp-cleanup-chmod");
    const target = syncStatePath(home, KEY);
    const spy = spyOn(fsPromises, "chmod").mockImplementation(async () => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });

    try {
      // Act
      const error: unknown = await writePrivateFile(target, "{}\n").then(
        () => null,
        (thrown: unknown) => thrown,
      );

      // Assert
      expect((error as NodeJS.ErrnoException).code).toBe("EPERM");
      expect(await readdir(dirname(target))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("sweepAbandonedTemps covers every directory writePrivateFile litters", () => {
  test("an abandoned temp in state/ goes; the file it was replacing stays", async () => {
    // Arrange
    const home = await tempHome("sweep-state");
    const real = await seed(syncStatePath(home, KEY), ABANDONED_MS);
    const temp = await seed(tempSibling(real), ABANDONED_MS);

    // Act
    await sweepAbandonedTemps(home, NOW, ROOM);

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
    await sweepAbandonedTemps(home, NOW, ROOM);

    // Assert
    expect(await exists(temp)).toBe(false);
    expect(await exists(real)).toBe(true);
  });

  test("an abandoned config.json temp in the home root goes; config.json stays", async () => {
    // Arrange: SessionStart rewrites config.json (rememberDeveloper) inside
    // its budget race, so its temp — API key and all — can be abandoned too
    const home = await tempHome("sweep-root");
    const real = await seed(configPath(home), ABANDONED_MS);
    const temp = await seed(tempSibling(real), ABANDONED_MS);

    // Act
    await sweepAbandonedTemps(home, NOW, ROOM);

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
    await sweepAbandonedTemps(home, NOW, ROOM);

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
    await sweepAbandonedTemps(home, NOW, ROOM);

    // Assert
    expect(await exists(markerTemp)).toBe(false);
    expect(await exists(cursorTemp)).toBe(false);
    expect(await exists(marker)).toBe(true);
    expect(await exists(cursor)).toBe(true);
  });
});

describe("sweepAbandonedTemps deletes only what is certainly abandoned", () => {
  test("the bound is a day, in absolute hours: a temp 23 h old stays, one 25 h old goes", async () => {
    // Arrange: ages written as hours, NOT derived from the constant — every
    // other test here moves with ABANDONED_TEMP_MAX_AGE_MS, so only this one
    // notices when it is set to a minute or to zero
    const home = await tempHome("sweep-absolute-age");
    const state = dirname(syncStatePath(home, KEY));
    const young = await seed(join(state, `${KEY}.json.tmp-1-young`), 23 * HOUR_MS);
    const old = await seed(join(state, `${KEY}.json.tmp-2-old`), 25 * HOUR_MS);

    // Act
    await sweepAbandonedTemps(home, NOW, ROOM);

    // Assert
    expect(await exists(young)).toBe(true);
    expect(await exists(old)).toBe(false);
  });

  test("a temp younger than ABANDONED_TEMP_MAX_AGE_MS stays: its writer may still rename it", async () => {
    // Arrange
    const home = await tempHome("sweep-young");
    const temp = await seed(tempSibling(syncStatePath(home, KEY)), IN_FLIGHT_MS);

    // Act
    await sweepAbandonedTemps(home, NOW, ROOM);

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
      // The dot before `tmp-` is literal: an unescaped `.` would take these
      "notesXtmp-123-abcdefgh",
      "notes-tmp-123-abcdefgh",
    ];
    for (const name of names) {
      await seed(join(state, name), 100 * ABANDONED_MS);
    }
    const shapedDirectory = join(state, `${KEY}.json.tmp-123-abcdefgh`);
    await mkdir(shapedDirectory);
    const when = new Date(NOW.getTime() - 100 * ABANDONED_MS);
    await utimes(shapedDirectory, when, when);

    // Act
    await sweepAbandonedTemps(home, NOW, ROOM);

    // Assert
    expect((await readdir(state)).sort()).toEqual(
      [...names, basename(shapedDirectory)].sort(),
    );
  });
});

describe("sweepAbandonedTemps never touches a symlink", () => {
  test("a temp-shaped symlink stays, and so does the file it points at, however old", async () => {
    // Arrange: an old symlink named exactly like a temp, pointing at an old
    // file outside every swept directory
    const home = await tempHome("sweep-symlink");
    const victim = await seed(join(home, "elsewhere", "victim.json"), 100 * ABANDONED_MS);
    const link = join(dirname(syncStatePath(home, KEY)), `${KEY}.json.tmp-9-link`);
    await mkdir(dirname(link), { recursive: true });
    await symlink(victim, link);
    const when = new Date(NOW.getTime() - 100 * ABANDONED_MS);
    await lutimes(link, when, when);

    // Act
    await sweepAbandonedTemps(home, NOW, ROOM);

    // Assert: writePrivateFile never makes a link, so a link is never its temp
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await exists(victim)).toBe(true);
  });

  /**
   * An old temp in a directory OUTSIDE the home, reached only through a link
   * — under `nested`, because spool/ holds its temps one directory deeper.
   */
  const outsideTemp = async (
    home: string,
    nested: readonly string[] = [],
  ): Promise<{ dir: string; temp: string }> => {
    const dir = join(home, "..", `${basename(home)}-outside`);
    homes.push(dir);
    const temp = await seed(join(dir, ...nested, `${KEY}.json.tmp-7-outside`), ABANDONED_MS);
    return { dir, temp };
  };

  for (const [name, nested] of [
    ["state", []],
    ["sessions", []],
    ["cache", []],
    ["spool", [KEY]],
  ] as const) {
    test(`a symlinked ${name}/ is not followed: the temp behind it stays`, async () => {
      // Arrange: <home>/<name> is a link to a directory somewhere else
      const home = await tempHome(`sweep-link-${name}`);
      const outside = await outsideTemp(home, nested);
      await symlink(outside.dir, join(home, name));

      // Act
      await sweepAbandonedTemps(home, NOW, ROOM);

      // Assert
      expect(await exists(outside.temp)).toBe(true);
    });
  }

  test("a symlinked spool/<key>/ is not followed: the temp behind it stays", async () => {
    // Arrange
    const home = await tempHome("sweep-link-spool-key");
    const outside = await outsideTemp(home);
    await mkdir(join(home, "spool"), { recursive: true });
    await symlink(outside.dir, join(home, "spool", KEY));

    // Act
    await sweepAbandonedTemps(home, NOW, ROOM);

    // Assert
    expect(await exists(outside.temp)).toBe(true);
  });
});

describe("sweepAbandonedTemps stays inside its caller's budget", () => {
  test("removes at most ABANDONED_TEMP_SWEEP_MAX_PER_RUN per run, so a backlog drains over successive runs", async () => {
    // Arrange: fifty more orphans than one run may remove
    const home = await tempHome("sweep-cap");
    const state = dirname(syncStatePath(home, KEY));
    await seedAbandonedTemps(state, ABANDONED_TEMP_SWEEP_MAX_PER_RUN + 50, ABANDONED_MS, NOW);

    // Act + Assert: the first run stops at the cap, the second takes the rest
    await sweepAbandonedTemps(home, NOW, ROOM);
    expect(await readdir(state)).toHaveLength(50);
    await sweepAbandonedTemps(home, NOW, ROOM);
    expect(await readdir(state)).toHaveLength(0);
  });

  test("removes nothing once the caller's spare budget is spent", async () => {
    // Arrange: the flush ran to its deadline and left no spare
    const home = await tempHome("sweep-spent");
    const temps = await seedAbandonedTemps(dirname(syncStatePath(home, KEY)), 3, ABANDONED_MS, NOW);

    // Act
    await sweepAbandonedTemps(home, NOW, () => 0);

    // Assert: next session's sweep, not this one's reserve
    for (const temp of temps) {
      expect(await exists(temp)).toBe(true);
    }
  });
});

describe("sweepAbandonedTemps never fails its caller", () => {
  test("a home with none of the directories is a no-op", async () => {
    // Arrange
    const home = await tempHome("sweep-empty");

    // Act + Assert
    expect(await sweepAbandonedTemps(home, NOW, ROOM)).toBeUndefined();
  });

  test.skipIf(isRoot)("a temp it may not remove is skipped and every other directory is still swept", async () => {
    // Arrange: state/ read-only, so its temp cannot be unlinked (EACCES)
    const home = await tempHome("sweep-eacces");
    const stuck = await seed(tempSibling(syncStatePath(home, KEY)), ABANDONED_MS);
    const free = await seed(tempSibling(sessionStatePathForSlug(home, SLUG)), ABANDONED_MS);
    await chmod(dirname(stuck), 0o500);

    try {
      // Act
      const outcome = await sweepAbandonedTemps(home, NOW, ROOM).then(
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

  test.skipIf(isRoot)("a directory it may not list is skipped and every other directory is still swept", async () => {
    // Arrange: state/ mode 000, so even its listing is refused (EACCES)
    const home = await tempHome("sweep-unlistable");
    const hidden = await seed(tempSibling(syncStatePath(home, KEY)), ABANDONED_MS);
    const free = await seed(tempSibling(sessionStatePathForSlug(home, SLUG)), ABANDONED_MS);
    await chmod(dirname(hidden), 0o000);

    try {
      // Act
      const outcome = await sweepAbandonedTemps(home, NOW, ROOM).then(
        () => "resolved",
        () => "rejected",
      );

      // Assert
      expect(outcome).toBe("resolved");
      expect(await exists(free)).toBe(false);
    } finally {
      await chmod(dirname(hidden), 0o700);
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
      sweepAbandonedTemps(home, NOW, ROOM),
      sweepAbandonedTemps(home, NOW, ROOM),
    ]);

    // Assert
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
    for (const temp of temps) {
      expect(await exists(temp)).toBe(false);
    }
  });
});
