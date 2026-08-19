/**
 * Reading side of the spool. One data file per SESSION, and every writer of one
 * only ever APPENDS — which is what lets a reader ignore who else is writing.
 *
 * That session's hooks are the usual writer, and not the only one: `rescueTail`
 * appends bytes back onto a file whose session is gone (reap.ts), and the
 * re-append in `appendThroughHandle` recreates a file reap unlinked (write.ts).
 * A reader therefore only ever sees a file GROW: nothing shortens or rewrites
 * bytes it has already read. What can change under it is the NAME — `reap`
 * unlinks a data file and an appender recreates it — which is why every read
 * below carries the IDENTITY of the file it came from. That identity is not the
 * inode number: ext4 gives the recreated file the same one back (identity.ts).
 *
 * Carrying an identity is not enough on its own: it has to be the identity of
 * the bytes reported WITH it. `readSessionSpool` resolved the path three times
 * and could describe two files in one answer, so its reads now go through a
 * single handle (`readObservedFile`).
 *
 * Nothing in this module writes, renames, truncates or deletes anything.
 */
import { Buffer } from "node:buffer";
import { open, readdir, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

import {
  spoolCursorPath,
  spoolDataPath,
  spoolDir,
} from "../config/paths.ts";
import { readCursorOffset, sliceFrom } from "./cursor.ts";
import { readHandleFacts } from "./identity.ts";
import type { FileFacts, FileIdentity } from "./identity.ts";
import { completeLines, lineTimestampMs, toLines } from "./lines.ts";

const DATA_SUFFIX = ".jsonl";

/**
 * `FileIdentity` is satisfied structurally by `ino` + `firstLine` below, so a
 * spool can be handed straight to anything that has to prove it is still
 * talking about the file it read.
 */
export interface SessionSpool extends FileIdentity {
  readonly slug: string;
  readonly dataPath: string;
  readonly cursorPath: string;
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

/**
 * Size only, so this stays one `stat` on the append hot path — `readFileFacts`
 * would also open and read the file to fingerprint it, which an append that
 * only needs to check the cap has no use for.
 */
export const sizeOf = async (path: string): Promise<number> => {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
};

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

interface ObservedFile {
  readonly facts: FileFacts;
  /** Exactly `facts.size` bytes of the same inode — never more, never fewer. */
  readonly content: string;
}

/** The first `size` bytes of THIS handle's inode, whatever the path now names. */
const readThrough = async (
  handle: FileHandle,
  size: number,
): Promise<string> => {
  if (size <= 0) {
    return "";
  }
  const buffer = Buffer.allocUnsafe(size);
  const { bytesRead } = await handle.read(buffer, 0, size, 0);
  return buffer.subarray(0, bytesRead).toString("utf8");
};

/**
 * Facts and bytes of ONE inode, taken through a single handle.
 *
 * They used to be three separate resolutions of the path — the content, then
 * the cursor validated against a fresh look at the file, then the identity —
 * with nothing pinning any of them to the same file. `reap` unlinking a data
 * file while an appender recreates it is enough to interleave them, and the
 * result was a `SessionSpool` reporting one file's offset beside another's
 * size. `reapSlug` reads exactly that pair as `offset >= size`, "delivered in
 * full", and unlinks. test/spool-read-tear.test.ts asserts the count of such
 * self-contradictory reads is zero.
 *
 * The size is read before the bytes, and only that many bytes are taken, so a
 * file that GROWS mid-read — the lock-free append path, which is legitimate and
 * constant — is reported at its earlier length rather than half-described. That
 * is the conservative direction for both readers: bytes not seen stay pending.
 */
const readObservedFile = async (
  path: string,
): Promise<ObservedFile | null> => {
  try {
    const handle = await open(path, "r");
    try {
      const facts = await readHandleFacts(handle);
      return { facts, content: await readThrough(handle, facts.size) };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
};

/** What a slug with no data file reads as: nothing pending, nothing to prove. */
const emptySpool = (
  slug: string,
  dataPath: string,
  cursorPath: string,
): SessionSpool => ({
  slug,
  dataPath,
  cursorPath,
  ino: 0,
  firstLine: null,
  size: 0,
  mtimeMs: 0,
  offset: 0,
  pending: "",
  lines: [],
});

export const readSessionSpool = async (
  home: string,
  key: string,
  slug: string,
): Promise<SessionSpool> => {
  const dataPath = spoolDataPath(home, key, slug);
  const cursorPath = spoolCursorPath(home, key, slug);
  const observed = await readObservedFile(dataPath);
  if (observed === null) {
    return emptySpool(slug, dataPath, cursorPath);
  }
  // Against the file just read, not against the path: a cursor is only worth
  // anything for the file whose size and identity are reported beside it.
  const offset = await readCursorOffset(cursorPath, observed.facts);
  const pending = sliceFrom(completeLines(observed.content), offset);
  return {
    slug,
    dataPath,
    cursorPath,
    ino: observed.facts.ino,
    firstLine: observed.facts.firstLine,
    size: observed.facts.size,
    mtimeMs: observed.facts.mtimeMs,
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