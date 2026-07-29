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
 *
 * WHEN A CLAIM MAY BE TAKEN. Age alone answered this, and age cannot tell a
 * holder that is SLOW from one that is GONE. A flush that stayed inside the
 * section longer than SPOOL_LOCK_STALE_MS was robbed mid-request, and the
 * thief's release then deleted the lock outright, so every later arrival walked
 * in unopposed. Two things fix that, and both NARROW the steal condition rather
 * than add machinery:
 *
 *   1. Age is measured on `Date.now()`. The other side of the subtraction is a
 *      filesystem mtime, so a caller-injected clock compared against it was not
 *      measuring elapsed time at all: a clock a month ahead retired a lock that
 *      was zero milliseconds old, on the first attempt. `withLock` therefore
 *      takes no clock — there is none left to inject.
 *   2. A claim whose holder PROCESS is still running is never taken, whatever
 *      its mtime says. The token already names that process (`mintToken`), so
 *      this asks the operating system the question age was standing in for.
 *
 * The liveness test can only VETO a steal, never authorise one. A token naming
 * no readable pid falls back to the age rule, which keeps a corrupt or
 * truncated lock file from wedging flush for the life of the repo; and the
 * create gap stays protected exactly as before, because a lock that was just
 * made has a fresh mtime and `stealLock` still refuses to remove a file whose
 * token changed under it. Nothing here deletes a lock it failed to read.
 *
 * VERIFY: bun test test/spool-lock.test.ts 2>&1 | grep -c '^(fail)'
 * PRINTS: 0
 *
 * What this cannot see is a holder in another pid namespace — a container
 * sharing CROSSCHECK_HOME with its host — where a pid means nothing. That case
 * is no better than it was and no worse: the age rule alone still governs it.
 *
 * WHAT "STILL RUNNING" HAD TO BE TAUGHT. The OS answers yes for a process that
 * has already EXITED: a zombie's entry stays in the process table until its
 * parent wait()s for it, and `process.kill(pid, 0)` succeeds against that entry.
 * That is what a crashed hook leaves behind whenever whatever started it is
 * still alive — no pid reuse involved, only a crash with a parent that lingers —
 * and read as ALIVE it wedged the lock permanently. A zombie is therefore
 * retired as dead. Asking the OS instead of guessing from a clock is the whole
 * point of the rule above, and a liveness test that calls an exited process
 * alive is not doing what its name says.
 *
 * WHAT IT COSTS, AND WHY NO HOOK PAYS IT. The zombie state costs a `ps` process
 * on macOS; on Linux it is a read of /proc and costs no process at all. Every
 * hook takes this lock, so charging that per acquisition would spend a process
 * on every hook forever to answer a question that almost never changes
 * anything. It is asked only where it can: after a claim has been found older
 * than SPOOL_LOCK_STALE_MS, and after the cheap `kill(pid, 0)` has already said
 * the pid exists. An acquire that creates its own lock — every uncontended one,
 * which is every normal one — returns before either check, and the test named
 * below runs 2000 of them behind a `ps` that records every call it gets:
 *
 * VERIFY: bun test test/spool-lock.test.ts -t "spawns no process" 2>&1 | grep -oE '[0-9]+ pass'
 * PRINTS: 1 pass
 *
 * A wedged lock is probed ONCE, not once per retry, which is what the memo
 * below is for; the test named "spends ONE probe" pins that at 1 call across
 * SPOOL_LOCK_RETRIES + 1 attempts ON macOS. On Linux the same test pins 0,
 * because a /proc read spawns nothing for the counting shim to see — so the
 * memo is currently unguarded there, and a regression that read /proc once per
 * retry would go unnoticed. Closing that needs a different probe (counting the
 * read, or injecting processState); this branch does not carry one.
 * MEASURED ONCE on 2026-07-29, and not a
 * figure this tree will reproduce exactly: one probe took 1.087 ms on macOS
 * (bun 1.3.13, the `ps`) against 0.002 ms on Linux (oven/bun:1, the /proc
 * read), where `kill(pid, 0)` costs 0.0009 ms and 0.0005 ms.
 *
 * What remains unretirable is a crashed holder's pid REUSED by an unrelated
 * long-lived process: that one is alive and is not a zombie, so nothing here can
 * tell it from the holder it replaced. Flush and reap are then deferred for as
 * long as the impostor lives, which is a silent stall, so `doctor` reports it:
 * `readLockHolder` below is what that check reads.
 */
import { readFileSync } from "node:fs";
import { open, rm } from "node:fs/promises";
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

const HOLDER_SEPARATOR = ":";

const mintToken = (): string =>
  `${process.pid}${HOLDER_SEPARATOR}${Math.random().toString(36).slice(2, 12)}\n`;

/**
 * The pid a token names, or null when it names none — a truncated write, a
 * hand-written file, or the empty file `createLock` leaves between its `open`
 * and its write.
 *
 * Zero and negatives are rejected rather than parsed, because `process.kill`
 * reads those as process GROUPS: asking whether "the whole group" exists would
 * answer yes for every lock ever written, and no claim would ever be retired.
 */
export const lockHolderPid = (token: string | null): number | null => {
  if (token === null) {
    return null;
  }
  const separator = token.indexOf(HOLDER_SEPARATOR);
  if (separator <= 0) {
    return null;
  }
  const pid = Number(token.slice(0, separator));
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
};

/**
 * Whether that process still EXISTS. Signal 0 runs the existence and permission
 * checks and delivers nothing.
 *
 * EPERM is ALIVE: it means the process is there and belongs to somebody else.
 * Only ESRCH says nobody is home, and reading a permission error as death is
 * how this check would hand a live holder's lock away.
 *
 * Existence is not liveness. A zombie exists, and this returns true for one;
 * `isProcessZombie` is what separates the two, and every caller that decides a
 * steal has to ask both. This one is a syscall and free; that one is not.
 */
export const isProcessRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const ZOMBIE_STATE = "Z";
/** `/proc/<pid>/stat` is "<pid> (<comm>) <state> ...", and comm may hold ')'. */
const LINUX_STATE_OFFSET = 2;

/**
 * The state character the OS reports for a pid, or null when it will not say.
 *
 * Linux answers from /proc, which is a file read and spawns nothing. Everywhere
 * else the answer costs a `ps`. Both are behind the age gate — see the header.
 */
const processState = (pid: number): string | null => {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // Read from after the LAST ')': a process may be named "(ev)il)".
      const commEnd = stat.lastIndexOf(")");
      return commEnd < 0
        ? null
        : (stat.charAt(commEnd + LINUX_STATE_OFFSET) || null);
    } catch {
      return null;
    }
  }
  try {
    const probe = Bun.spawnSync({
      cmd: ["ps", "-o", "state=", "-p", String(pid)],
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    // `ps` reports "Z" alone or decorated, as in "Z+"; the first char is the
    // state and the rest are flags.
    return probe.stdout.toString().trim().charAt(0) || null;
  } catch {
    return null;
  }
};

/**
 * Whether that pid has EXITED and is merely still listed — a zombie, waiting
 * for a parent that has not called wait(). `process.kill(pid, 0)` succeeds for
 * one, which is why this question has to be asked separately at all.
 *
 * A probe that cannot answer says NO, and the holder stays counted as alive.
 * Like `isProcessRunning`, this may only VETO a steal, never authorise one:
 * an unreadable /proc or a missing `ps` must not become a licence to take a
 * running holder's lock away.
 */
export const isProcessZombie = (pid: number): boolean =>
  processState(pid) === ZOMBIE_STATE;

/**
 * One acquisition's answers about one pid, so a wedged lock is probed once
 * rather than once per retry.
 *
 * `acquireLock` retries, and every retry that finds the same live holder would
 * otherwise pay for the same `ps` again. The map is made inside a single
 * acquisition and thrown away with it, so nothing here outlives the call and no
 * answer is ever reused across hooks.
 */
type ZombieMemo = Map<number, boolean>;

const isZombie = (pid: number, memo: ZombieMemo): boolean => {
  const remembered = memo.get(pid);
  if (remembered !== undefined) {
    return remembered;
  }
  const zombie = isProcessZombie(pid);
  memo.set(pid, zombie);
  return zombie;
};

interface LockClaim {
  readonly ageMs: number;
  readonly token: string;
}

/**
 * The age and the token of ONE inode, read through a single handle.
 *
 * Two reads of the PATH could straddle a release and a re-create and report the
 * old file's age beside the new file's token — the same two-files-one-answer
 * shape that broke `readSessionSpool` (spool/files.ts). A handle cannot: it is
 * pinned to the inode it opened, so a lock replaced underneath is simply not
 * the one measured here, and `stealLock` then finds a different token at the
 * path and leaves it alone.
 */
const readLockClaim = async (path: string): Promise<LockClaim | null> => {
  try {
    const handle = await open(path, "r");
    try {
      const info = await handle.stat();
      return {
        // Date.now(), never a caller's clock: `info.mtimeMs` is the
        // filesystem's, and a subtraction across two clocks is not an age.
        ageMs: Date.now() - info.mtimeMs,
        token: await handle.readFile("utf8"),
      };
    } finally {
      await handle.close();
    }
  } catch {
    // ENOENT or any other failure: a lock we cannot see is never ours to
    // delete. Deleting on ENOENT is exactly how two writers used to collide.
    return null;
  }
};

export interface LockHolder {
  /** Null when the token names no readable pid. */
  readonly pid: number | null;
  readonly ageMs: number;
  /**
   * False for a pid that is gone, for one that has exited and is only still
   * listed, and for a token that names none — the three cases the next
   * acquisition takes the lock away from.
   */
  readonly isRunning: boolean;
}

/**
 * Who holds the lock right now, for `doctor` to report. Never consulted to
 * decide a steal — `stealableToken` owns that — so a check reading this cannot
 * change what the lock does.
 *
 * It asks the zombie question unconditionally, where the steal path asks it
 * only past the age gate. `doctor` runs once, at a human's request, and no hook
 * budget is behind it; being right about the holder is worth one `ps` there.
 */
export const readLockHolder = async (
  path: string,
): Promise<LockHolder | null> => {
  const claim = await readLockClaim(path);
  if (claim === null) {
    return null;
  }
  const pid = lockHolderPid(claim.token);
  return {
    pid,
    ageMs: claim.ageMs,
    isRunning: pid !== null && isProcessRunning(pid) && !isProcessZombie(pid),
  };
};

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

/**
 * Token of a claim that may be taken, or null when there is nothing to steal.
 *
 * Both conditions have to hold. The age says the claim LOOKS abandoned; the
 * holder's absence says it IS. A running holder keeps its lock however old the
 * mtime is, and that is the whole of the mutual-exclusion guarantee.
 *
 * The age gate is also what keeps the zombie question off every hook: a claim
 * inside SPOOL_LOCK_STALE_MS returns above without asking anything about a
 * holder, and a pid the OS has already forgotten is settled by the free check
 * before the paid one is reached.
 */
const stealableToken = async (
  path: string,
  zombies: ZombieMemo,
): Promise<string | null> => {
  const claim = await readLockClaim(path);
  if (claim === null || claim.ageMs <= SPOOL_LOCK_STALE_MS) {
    return null;
  }
  const pid = lockHolderPid(claim.token);
  if (pid === null) {
    return claim.token;
  }
  return isProcessRunning(pid) && !isZombie(pid, zombies) ? null : claim.token;
};

/** Removes a lock only while it still carries the token the check above saw. */
const stealLock = async (path: string, observed: string): Promise<void> => {
  if ((await readTextOrNull(path)) !== observed) {
    return;
  }
  await rm(path, { force: true });
};

/** Returns the holder's token, or null when the lock stayed busy. */
const acquireLock = async (
  path: string,
  retries: number = SPOOL_LOCK_RETRIES,
): Promise<string | null> => {
  await ensureDir(dirname(path));
  const token = mintToken();
  const zombies: ZombieMemo = new Map();
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (await createLock(path, token)) {
      return token;
    }
    const stealable = await stealableToken(path, zombies);
    if (stealable !== null) {
      await stealLock(path, stealable);
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
  fallback: T,
  action: () => Promise<T>,
  retries: number = SPOOL_LOCK_RETRIES,
): Promise<T> => {
  const token = await acquireLock(path, retries);
  if (token === null) {
    return fallback;
  }
  try {
    return await action();
  } finally {
    await releaseLock(path, token);
  }
};