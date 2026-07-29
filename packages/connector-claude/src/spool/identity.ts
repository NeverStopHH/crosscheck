/**
 * WHICH FILE a remembered offset or size belongs to, on a filesystem that
 * reuses inode numbers.
 *
 * An inode number alone cannot answer that. ext4 hands the number of a deleted
 * file straight back to the next file created in its place — measured 20/20 in
 * 20 delete+recreate trials on the CI image (oven/bun:1, overlayfs) — while
 * APFS did not once in the same 20, which is why every check that rested on
 * `ino` held on a developer's Mac and silently failed on the hubs' Linux.
 *
 * The authority here is the file's FIRST LINE. It is the first record ever
 * appended to that file, and for a spool data file it never changes afterwards:
 * write.ts is the only writer and only ever appends, nothing truncates or
 * rewrites, and `reap` removes files whole. A file removed and recreated at the
 * same path starts its record sequence over, so its first line is a DIFFERENT
 * record — and every record this connector spools is an envelope whose `id` is
 * `env_` + `crypto.randomUUID()` (capture/records.ts), so two distinct records
 * never serialise to the same line.
 *
 * `ino` is kept alongside it as a cheap pre-filter. It is not load-bearing:
 * every comparison below requires BOTH to agree, so a filesystem that reuses
 * inodes is caught by the hash, and one that never reuses them merely rejects a
 * beat earlier.
 *
 * WHY THERE IS NO `dev` HERE. An inode number is unique only within one
 * filesystem, so `ino` without `st_dev` is not an identity across devices, and
 * two files on two filesystems can share one — two tmpfs mounts hand out the
 * same low inode numbers immediately. That mechanism is real. It is still not
 * worth a field, for two reasons that are checkable rather than argued:
 *
 *   1. A repo's spool cannot span two filesystems. Every artifact in it is a
 *      FILE created directly in the one directory `spoolDir` names; not one of
 *      them is a subdirectory that could be a mount point of its own. A
 *      symlinked CROSSCHECK_HOME relocates that directory whole, it does not
 *      split it.
 *      VERIFY: grep -c "join(spoolDir" src/config/paths.ts
 *      PRINTS: 8
 *   2. `ino` is never compared ACROSS files. Every comparison is two
 *      observations of the SAME path at two moments, so for `dev` to differ,
 *      the mount under one path would have to change between them.
 *      VERIFY: grep -rn "isSameFil[e](" src | grep -c .
 *      PRINTS: 3
 *      (the bracket keeps this line from counting itself.)
 *
 * The first line also defeats the collision on its own: two files that merely
 * share an inode number have different first records, so `isSameFile` says
 * false. Forcing a false MATCH needs identical first lines as well, which
 * within one path is exactly the write.ts orphan re-append named below — and a
 * `dev` field would not catch that one either, because it is the same path on
 * the same filesystem. Adding `dev` would be a field that can only ever reject,
 * in a place where nothing wrong is currently accepted.
 *
 * WHAT WOULD BREAK IT, stated plainly:
 *   - anything that prepends to, truncates or rewrites a spool data file; the
 *     first line would stop being fixed for the life of the file;
 *   - envelope ids ceasing to be random per record, which is what makes two
 *     files' first lines differ;
 *   - the orphan recovery in write.ts, which re-appends the IDENTICAL payload
 *     to the file it recreates. That is the one way two files at one path can
 *     share a first line, and it needs the earlier file to have been empty
 *     before that payload landed. It is narrower than what `ino` alone missed,
 *     and it is NOT claimed here to be impossible.
 */
import { Buffer } from "node:buffer";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

import {
  FIRST_LINE_HASH_CHARS,
  FIRST_LINE_PROBE_BYTES,
} from "../constants.ts";

const NEWLINE = 0x0a;

export interface FileIdentity {
  readonly ino: number;
  /**
   * Hash of the first line, or null while no record has landed WHOLE yet — a
   * file `open(path, "a")` created but has not been written to, or one whose
   * very first write was torn. Null never compares equal to anything, so a
   * cursor is refused rather than believed in that state, and there is nothing
   * to deliver from such a file anyway: `completeLines` yields no line until
   * the first newline lands (lines.ts).
   */
  readonly firstLine: string | null;
}

export interface FileFacts extends FileIdentity {
  /** PHYSICAL byte size, fragments included. */
  readonly size: number;
  readonly mtimeMs: number;
}

const hashOf = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256")
    .update(bytes)
    .digest("hex")
    .slice(0, FIRST_LINE_HASH_CHARS);

/**
 * Hash of the bytes before the first newline.
 *
 * Two cases have no newline in the probe, and they are not the same thing. A
 * SHORT read means the file ends before any newline: the first record has not
 * landed whole, the value is not stable yet, and null says so. A FULL read
 * means the first line is longer than the probe: those bytes are already final,
 * because the file only ever grows past them, so their hash is a stable
 * fingerprint. Returning null there instead would refuse that file's cursor
 * forever, which is a slow way to lose its records to expiry.
 */
const firstLineHash = (probe: Uint8Array): string | null => {
  const newline = probe.indexOf(NEWLINE);
  if (newline !== -1) {
    return hashOf(probe.subarray(0, newline));
  }
  return probe.length < FIRST_LINE_PROBE_BYTES ? null : hashOf(probe);
};

/** Facts of the inode this HANDLE holds, which no rename or unlink can change. */
export const readHandleFacts = async (
  handle: FileHandle,
): Promise<FileFacts> => {
  const info = await handle.stat();
  const buffer = Buffer.allocUnsafe(FIRST_LINE_PROBE_BYTES);
  const { bytesRead } = await handle.read(buffer, 0, FIRST_LINE_PROBE_BYTES, 0);
  return {
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    firstLine: firstLineHash(buffer.subarray(0, bytesRead)),
  };
};

/** Null when there is no file, which every caller reads as "nothing to do". */
export const readFileFacts = async (
  path: string,
): Promise<FileFacts | null> => {
  try {
    const handle = await open(path, "r");
    try {
      return await readHandleFacts(handle);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
};

/**
 * Whether two observations describe the same file — the same inode AND the same
 * first record. A file that is gone matches nothing.
 *
 * Two files with NO first line — both empty, or both torn before their first
 * newline — match on the inode alone, and that is deliberate: `reap` has to be
 * able to retire an aged-out empty file, which is what stops empty files
 * accumulating, and there is nothing in one to lose by being wrong. No caller
 * that trusts an OFFSET rests on this: `writeCursorOffset` refuses a file with
 * no first line outright, and a stored cursor always carries a hash, which
 * never equals null.
 */
export const isSameFile = (
  left: FileIdentity | null,
  right: FileIdentity | null,
): boolean =>
  left !== null &&
  right !== null &&
  left.ino === right.ino &&
  left.firstLine === right.firstLine;