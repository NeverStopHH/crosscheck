/**
 * Reading side of the spool. One data file per SESSION, and every writer of one
 * only ever APPENDS — which is what lets a reader ignore who else is writing.
 *
 * That session's hooks are the usual writer, and not the only one: `rescueTail`
 * appends bytes back onto a file whose session is gone (reap.ts), and the
 * re-append in `appendThroughHandle` recreates a file reap unlinked (write.ts).
 * A reader therefore only ever sees an inode GROW: nothing shortens or rewrites
 * bytes it has already read. What can change under it is the NAME — `reap`
 * unlinks a data file and an appender recreates it — which is why every read
 * below carries the `ino` it came from.
 *
 * Nothing in this module writes, renames, truncates or deletes anything.
 */
import { readdir, stat } from "node:fs/promises";

import {
  readTextOrNull,
  spoolCursorPath,
  spoolDataPath,
  spoolDir,
} from "../config/paths.ts";
import { readCursorOffset, sliceFrom } from "./cursor.ts";
import { completeLines, lineTimestampMs, toLines } from "./lines.ts";

const DATA_SUFFIX = ".jsonl";

export interface SessionSpool {
  readonly slug: string;
  readonly dataPath: string;
  readonly cursorPath: string;
  /**
   * Which file these bytes came from. A spool that `reap` removed and an
   * appender recreated wears the same NAME with a different inode, so anything
   * written back afterwards — the cursor above all — has to prove it is talking
   * about the file it read.
   */
  readonly ino: number;
  /**
   * PHYSICAL byte size, fragments included — what `reap` compares the cursor
   * against, so a file with a trailing torn write is never seen as delivered.
   */
  readonly size: number;
  /** Last write to the file: `reap` refuses to unlink one that was touched recently. */
  readonly mtimeMs: number;
  readonly offset: number;
  /** Complete lines from `offset` to EOF; a half-landed append stays out. */
  readonly pending: string;
  readonly lines: readonly string[];
}

export interface SpoolFileFacts {
  /** Identity of the file these facts came from — see `SessionSpool.ino`. */
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

/** Null when there is no file, which every caller reads as "nothing to do". */
export const factsOf = async (path: string): Promise<SpoolFileFacts | null> => {
  try {
    const info = await stat(path);
    return { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
};

export const sizeOf = async (path: string): Promise<number> =>
  (await factsOf(path))?.size ?? 0;

/**
 * Session slugs with a data file, sorted only so the listing is stable. This is
 * NOT delivery order: flush picks the oldest backlog, because slugs are
 * `encodeURIComponent` of a session UUID and name order is therefore arbitrary.
 */
export const listSessionSlugs = async (
  home: string,
  key: string,
): Promise<readonly string[]> => {
  try {
    const names = await readdir(spoolDir(home, key));
    return names
      .filter((name) => name.endsWith(DATA_SUFFIX))
      .map((name) => name.slice(0, -DATA_SUFFIX.length))
      .sort();
  } catch {
    return [];
  }
};

export const readSessionSpool = async (
  home: string,
  key: string,
  slug: string,
): Promise<SessionSpool> => {
  const dataPath = spoolDataPath(home, key, slug);
  const cursorPath = spoolCursorPath(home, key, slug);
  const raw = completeLines((await readTextOrNull(dataPath)) ?? "");
  const offset = await readCursorOffset(dataPath, cursorPath);
  const pending = sliceFrom(raw, offset);
  const facts = await factsOf(dataPath);
  return {
    slug,
    dataPath,
    cursorPath,
    ino: facts?.ino ?? 0,
    size: facts?.size ?? 0,
    mtimeMs: facts?.mtimeMs ?? 0,
    offset,
    pending,
    lines: toLines(pending),
  };
};

export const readAllSessionSpools = async (
  home: string,
  key: string,
): Promise<readonly SessionSpool[]> =>
  Promise.all(
    (await listSessionSlugs(home, key)).map((slug) =>
      readSessionSpool(home, key, slug),
    ),
  );

/**
 * Every undelivered record of this repo, concatenated session by session in the
 * filename order `listSessionSlugs` returns.
 *
 * That order is neither oldest-first nor delivery order — slugs are
 * `encodeURIComponent` of a session UUID. A one-hour-old backlog in `zz-oldest`
 * and a fresh record in `aa-newest` come back newest first. Callers that care
 * about age read it from the records (`oldestSpoolLineMs`) or sort the spools
 * themselves, the way `flush` does.
 */
export const readSpoolLines = async (
  home: string,
  key: string,
): Promise<readonly string[]> =>
  (await readAllSessionSpools(home, key)).flatMap((spool) => spool.lines);

export const spoolDepth = async (home: string, key: string): Promise<number> =>
  (await readSpoolLines(home, key)).length;

export const oldestSpoolLineMs = async (
  home: string,
  key: string,
): Promise<number | null> =>
  (await readSpoolLines(home, key)).reduce<number | null>((oldest, line) => {
    const ms = lineTimestampMs(line);
    if (ms === null) {
      return oldest;
    }
    return oldest === null || ms < oldest ? ms : oldest;
  }, null);