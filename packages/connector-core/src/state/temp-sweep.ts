/**
 * Removing the temp siblings `writePrivateFile` abandoned (pilot finding,
 * 2026-10-06).
 *
 * Every atomic write under the crosscheck home goes through
 * `<path>.tmp-<pid>-<rand>` and a rename. Two things left that temp behind for
 * good, and neither is exotic:
 *   - the writer dies between its write and its rename. Routine, not a crash:
 *     a hook binary exits the moment its budget race answers
 *     (connector-claude hooks/runner.ts runHookWith, cli bin/crosscheck.ts
 *     emitAndExit), abandoning whatever write was still in flight;
 *   - a step after the temp exists throws. writePrivateFile now removes its
 *     own temp on that path; this sweep is for the writer that never got to
 *     run its catch.
 * The pilot machine had 40 in `state/` (0.7 h to 925 h old, 0 or 237 bytes),
 * 3 in `sessions/` and a `.pending-end` one in its spool, and was still
 * producing them. Small, and unbounded — and what we keep on disk is bounded.
 *
 * WHAT IT MAY DELETE: a regular file whose name is EXACTLY the tempSibling
 * shape (`isTempSiblingName`, config/paths.ts) and whose mtime is older than
 * ABANDONED_TEMP_MAX_AGE_MS, in a directory a hook-path writer points
 * writePrivateFile at. Nothing reads a temp name, so a temp past that age has
 * no reader and — the constant carries the argument — no writer either. Any
 * other name is never touched, whatever its age; a directory never is.
 *
 * Fail-open throughout, like the session-state reap it runs beside: a
 * directory that cannot be listed, a file that vanished, an unlink that is
 * refused all skip that one thing and cost nothing else. Two sweeps at once
 * are safe: the loser's `rm` of a file the winner removed is `force`d into a
 * no-op, and a stat that loses the race lands in the same per-file catch.
 */
import type { Dirent } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  ABANDONED_TEMP_MAX_AGE_MS,
  ABANDONED_TEMP_SWEEP_MAX_PER_RUN,
} from "../constants.ts";
import { isTempSiblingName } from "../config/paths.ts";

/** Absent or unlistable reads as empty: nothing this run can sweep there. */
const listEntries = async (dir: string): Promise<readonly Dirent[]> => {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/**
 * Listed rather than taken from the caller, so the spool of a repo nobody
 * opens any more is swept too — its temps are as abandoned as anybody's.
 */
const spoolDirectories = async (home: string): Promise<readonly string[]> =>
  (await listEntries(join(home, "spool")))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(home, "spool", entry.name));

/**
 * Where hook-path writers point writePrivateFile: per-repo state (sync,
 * fired markers, landing fetch, conference counters), session state and the
 * intent prompt beside it, the presence cache SessionStart and the statusline
 * both write inside a budget race, and every repo's spool (cursors, drop
 * aggregates, `.pending-end` markers — SessionEnd writes those through
 * writePrivateFile too, so their temps carry the same shape).
 *
 * NOT the CLI's own destinations (`config.json` at the home root,
 * `conferences/`, `backups/`): those writers are commands a person runs to
 * completion, not hooks a budget race abandons. A directory joins this list
 * on the evidence each of these four has — a writer that can be abandoned.
 */
const sweptDirectories = async (home: string): Promise<readonly string[]> => [
  join(home, "state"),
  join(home, "sessions"),
  join(home, "cache"),
  ...(await spoolDirectories(home)),
];

/** True when this call removed the file (or found it already gone). */
const removeIfAbandoned = async (path: string, now: Date): Promise<boolean> => {
  try {
    const { mtimeMs } = await lstat(path);
    if (now.getTime() - mtimeMs > ABANDONED_TEMP_MAX_AGE_MS) {
      await rm(path, { force: true });
      return true;
    }
    return false;
  } catch {
    // Refused (EACCES), or gone under a concurrent sweep: this one file
    // stays, and the next SessionStart looks again.
    return false;
  }
};

/**
 * One readdir per directory and one lstat per temp-shaped name; an ordinary
 * file costs nothing beyond its entry in the listing, because the name is
 * tested before any syscall. Runs where each connector already does its
 * session-start maintenance, so a machine running only one of them is still
 * swept: the Claude and Cursor SessionStart hooks after the briefing is in
 * hand (connector-claude hooks/session-start.ts, connector-cursor
 * handlers/session-start.ts), and the ACP proxy's child-exit drain, off the
 * wire, which is where that connector reaps (connector-acp capture/engine.ts).
 *
 * BOUNDED TWICE, because two of those three callers run inside a budget race
 * whose loser is the briefing. ABANDONED_TEMP_SWEEP_MAX_PER_RUN bounds the
 * work; `spareMs` — the caller's HookBudget.spareMs, or ACP's exit budget —
 * bounds the time, and the sweep stops before the next syscall once it reads
 * zero. What a hook still holds when that happens is its reserve, one request
 * timeout (400 ms by default), and the reserve is what carries the briefing
 * out; the sweep never spends it. MEASURED 2026-10-06 (bun 1.3.13, M4 Max,
 * temp home with 200 ordinary files across five directories): nothing to
 * sweep 0.25 ms; the pilot machine's whole backlog of 44 orphans 1.9 ms; a
 * full run of 100 removals about 5.5 ms — none of it taken from the reserve.
 */
export const sweepAbandonedTemps = async (
  home: string,
  now: Date,
  spareMs: () => number,
): Promise<void> => {
  let removed = 0;
  const hasRoom = (): boolean =>
    removed < ABANDONED_TEMP_SWEEP_MAX_PER_RUN && spareMs() > 0;
  for (const dir of await sweptDirectories(home)) {
    if (!hasRoom()) {
      return;
    }
    for (const entry of await listEntries(dir)) {
      // Regular files only: writePrivateFile makes nothing else, and a
      // temp-shaped directory or symlink is somebody else's to keep.
      if (!entry.isFile() || !isTempSiblingName(entry.name)) {
        continue;
      }
      if (!hasRoom()) {
        return;
      }
      if (await removeIfAbandoned(join(dir, entry.name), now)) {
        removed += 1;
      }
    }
  }
};
