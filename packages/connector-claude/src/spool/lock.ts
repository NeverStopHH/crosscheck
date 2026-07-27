/**
 * Mutual exclusion for flush and reap, and for nothing else. Appends do not
 * take it — see append.ts.
 *
 * Both holders fail the same harmless way: a flush that cannot take the lock
 * skips and the next hook retries, a reap that cannot take it leaves the files
 * for the next SessionStart. That is the only reason a lock is tolerable here
 * at all; on the append path its failure mode was a lost record.
 *
 * Every lock carries the identity of its holder, because an earlier version
 * stole on any `stat` error (ENOENT included) and therefore deleted whatever
 * lock happened to exist in the gap between one holder releasing and the next
 * one creating — two "holders" in the critical section at once.
 */
import { open, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import {
  PRIVATE_FILE_MODE,
  SPOOL_LOCK_RETRIES,
  SPOOL_LOCK_RETRY_DELAY_MS,
  SPOOL_LOCK_STALE_MS,
} from "../constants.ts";
import { ensureDir, readTextOrNull } from "../config/paths.ts";

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const mintToken = (): string =>
  `${process.pid}:${Math.random().toString(36).slice(2, 12)}\n`;

/**
 * `wx` gives exclusive creation, and the read-back turns "my create succeeded"
 * into "the lock on disk is still mine" — a third process may have stolen and
 * recreated it in between.
 */
const createLock = async (path: string, token: string): Promise<boolean> => {
  try {
    const handle = await open(path, "wx", PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(token);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
  return (await readTextOrNull(path)) === token;
};

/** Token of a lock past its stale deadline, or null when there is nothing to steal. */
const staleLockToken = async (
  path: string,
  now: Date,
): Promise<string | null> => {
  try {
    const info = await stat(path);
    if (now.getTime() - info.mtimeMs <= SPOOL_LOCK_STALE_MS) {
      return null;
    }
  } catch {
    // ENOENT or any other stat failure: a lock we cannot see is never ours to
    // delete. Deleting on ENOENT is exactly how two writers used to collide.
    return null;
  }
  return readTextOrNull(path);
};

/** Removes a lock only while it still carries the token the staleness check saw. */
const stealLock = async (path: string, observed: string): Promise<void> => {
  if ((await readTextOrNull(path)) !== observed) {
    return;
  }
  await rm(path, { force: true });
};

/** Returns the holder's token, or null when the lock stayed busy. */
const acquireLock = async (
  path: string,
  now: Date,
  retries: number = SPOOL_LOCK_RETRIES,
): Promise<string | null> => {
  await ensureDir(dirname(path));
  const token = mintToken();
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (await createLock(path, token)) {
      return token;
    }
    const stale = await staleLockToken(path, now);
    if (stale !== null) {
      await stealLock(path, stale);
      if (await createLock(path, token)) {
        return token;
      }
    }
    if (attempt < retries) {
      await delay(SPOOL_LOCK_RETRY_DELAY_MS);
    }
  }
  return null;
};

/** A lock that is no longer ours belongs to whoever stole it — leave it alone. */
const releaseLock = async (
  path: string,
  token: string,
): Promise<void> => {
  if ((await readTextOrNull(path)) !== token) {
    return;
  }
  await rm(path, { force: true });
};

export const withLock = async <T>(
  path: string,
  now: Date,
  fallback: T,
  action: () => Promise<T>,
  retries: number = SPOOL_LOCK_RETRIES,
): Promise<T> => {
  const token = await acquireLock(path, now, retries);
  if (token === null) {
    return fallback;
  }
  try {
    return await action();
  } finally {
    await releaseLock(path, token);
  }
};