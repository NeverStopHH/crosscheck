/**
 * The only place a spool DATA file is ever removed. Three conditions guard the
 * unlink, and each one was a way records went missing:
 *
 * 1. No session state file under `~/.crosscheck/sessions/` for that slug. Every
 *    appender writes its state BEFORE its first append (session-start.ts,
 *    post-tool-use.ts), so a slug with no state file has no appender that ever
 *    announced itself. That is necessary but NOT sufficient, and the gap is not
 *    hypothetical: SessionEnd deletes the state, and a PostToolUse still in
 *    flight appends after it.
 * 2. The file is not empty — for the DELIVERED branch only. `open(path, "a")`
 *    creates a zero-length file before the first write, and `offset >= size`
 *    reads that as fully delivered. The expiry branch removes an empty file
 *    quite deliberately, which is what stops them accumulating.
 * 3. The file has been untouched for SPOOL_REAP_GRACE_MS, so reap only takes
 *    the shot at files nothing has written to in seconds.
 *
 * What that buys, stated honestly: it makes the removal race RARE, not
 * impossible. An appender can open a file that has been quiet for hours, so no
 * amount of grace rules the overlap out — the unlink window measures p50 70 µs,
 * p99 230 µs, and losses were reproduced at a 0.49 ms open→write gap and at 76
 * records in 5760 under load.
 *
 * Two overlaps are possible, and each is recovered where it is visible:
 *   - an appender between its open and its write ends up writing to an inode
 *     with no name — it learns that from `nlink` and re-appends (write.ts);
 *   - an append that completes AFTER the size check below but before the unlink
 *     is invisible to that appender and is put back here, by `rescueTail`.
 * The two can catch the same write, in which case that record is recovered
 * twice and delivered twice. Recovery is deliberately at-least-once — see
 * `rescueTail` below for why a duplicate costs nothing at the hub.
 *
 * No data file is ever renamed, truncated or rewritten here: they are deleted
 * whole or left completely alone. (The two per-repo aggregates ARE rewritten in
 * place — `archive.dropsummary` and `unclosed.endsummary` — which is safe
 * because only this module writes them, only under the flush lock, and nothing
 * appends to them.)
 *
 * "Under the flush lock" is load-bearing for those two, and it did not hold:
 * the lock was taken from whoever held it once its mtime aged past
 * SPOOL_LOCK_STALE_MS, so two reaps could be inside at once and one
 * read-modify-write of an aggregate could lose the other's fold. It holds now
 * because a claim whose holder process is still running is never taken
 * (spool/lock.ts). Read that file before weakening the rule: these two
 * rewrites are what it protects.
 *
 * VERIFY: bun test test/spool-lock.test.ts 2>&1 | grep -c '^(fail)'
 * PRINTS: 0
 *
 * Reap also retires the `.pending-end` markers SessionEnd leaves: one hub call
 * each once that session's backlog is gone, and no call at all once a marker is
 * older than MAX_SPOOL_AGE_DAYS.
 */
import { Buffer } from "node:buffer";
import { open, readdir, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import {
  MAX_SPOOL_AGE_DAYS,
  MS_PER_DAY,
  SPOOL_REAP_GRACE_MS,
} from "../constants.ts";
import {
  readJsonOrNull,
  removeFile,
  sessionStatePathForSlug,
  spoolDataPath,
  spoolDir,
  spoolFlushLockPath,
  spoolPendingEndPath,
} from "../config/paths.ts";
import {
  DROPS_SUFFIX,
  archiveLedger,
  newestDropMs,
  recordDrop,
} from "./drops.ts";
import { listSessionSlugs, readSessionSpool } from "./files.ts";
import type { SessionSpool } from "./files.ts";
import { isSameFile, readHandleFacts } from "./identity.ts";
import { byteLength, completeLines, toLines } from "./lines.ts";
import { withLock } from "./lock.ts";
import { recordUnclosedSession } from "./unclosed.ts";
import { appendOnce } from "./write.ts";

export interface ReapResult {
  /** Files removed because everything in them reached the hub. */
  readonly delivered: number;
  /** Files removed past MAX_SPOOL_AGE_DAYS with records still undelivered. */
  readonly expired: number;
  /** Records those expired files gave up, all of them counted in `.drops`. */
  readonly dropped: number;
}

const NOTHING_REAPED: ReapResult = { delivered: 0, expired: 0, dropped: 0 };

const isSessionLive = async (home: string, slug: string): Promise<boolean> =>
  Bun.file(sessionStatePathForSlug(home, slug)).exists();

const isOlderThanMaxAge = async (path: string, now: Date): Promise<boolean> => {
  try {
    const { mtimeMs } = await stat(path);
    return now.getTime() - mtimeMs > MAX_SPOOL_AGE_DAYS * MS_PER_DAY;
  } catch {
    return false;
  }
};

/**
 * The last thing checked before any unlink, deliberately. A session that came
 * back to life, or a file that grew since it was read, means an appender may be
 * holding this path — and a file with a VISIBLE appender behind it is never
 * deleted. Skipping costs nothing: the next SessionStart reaps it instead.
 *
 * The mtime check narrows the window; it does not close it. An appender that
 * opened this path before the unlink still writes to the unlinked inode however
 * long the file had been quiet, because a quiet file is exactly what an
 * appender opens first. That write is recovered where it happens, by the
 * `nlink` check in write.ts.
 */
const isSafeToRemove = async (
  home: string,
  spool: SessionSpool,
  handle: FileHandle,
  now: Date,
): Promise<boolean> => {
  if (await isSessionLive(home, spool.slug)) {
    return false;
  }
  // Through the HANDLE, not the path: this is the inode about to be unlinked,
  // and a path can point at a different file by the time we look again.
  //
  // The handle being pinned to one inode is what makes the READ trustworthy; it
  // is not what makes the comparison sound. `spool.ino` came from an earlier
  // stat of the PATH, so this is the same remembered-ino-versus-fresh-stat shape
  // that broke the cursor, and an inode number reused by a file recreated in
  // between would compare equal on ext4. Hence `isSameFile`, which also requires
  // the first line to match (spool/identity.ts). Size and the quiescence grace
  // stay: they answer a different question — whether the file GREW or was
  // touched since it was read — which identity alone does not.
  const facts = await readHandleFacts(handle);
  return (
    isSameFile(facts, spool) &&
    facts.size === spool.size &&
    now.getTime() - facts.mtimeMs >= SPOOL_REAP_GRACE_MS
  );
};

/** Bytes the file grew by after `from`, as whole lines plus any torn remainder. */
const readTail = async (
  handle: FileHandle,
  from: number,
  to: number,
): Promise<string> => {
  const buffer = Buffer.allocUnsafe(to - from);
  const { bytesRead } = await handle.read(buffer, 0, to - from, from);
  return buffer.subarray(0, bytesRead).toString("utf8");
};

/**
 * Puts back the records an appender added between the size check above and the
 * unlink below — the reap-side half of the race write.ts fights on the append
 * side.
 *
 * The handle outlives the unlink, so those bytes are still readable off the
 * orphaned inode: they are read back and appended to the path, which recreates
 * the file. Nothing already delivered comes back by that, and the reason has to
 * hold on BOTH branches that reach here — a delivered file, where the cursor is
 * at the size, and an expired one, where it is behind it. It does: this reads
 * only bytes ABOVE `spool.size`, and a cursor is never trusted above its own
 * file's size — `readCursorOffset` returns 0 for an offset past the end rather
 * than clamping it (cursor.ts) — so whatever governed delivery was at most
 * `spool.size` and every byte put back here is past it. Same argument write.ts
 * makes from the append side, with the same expiry caveat: on that branch the
 * records BELOW `spool.size` were counted as dropped by `reapSlug` a moment
 * ago, and that count covers only the lines it read, so the bytes put back here
 * are in neither set — neither sent nor already counted as lost.
 *
 * They CAN be sent twice, though, and this handle is why: an appender whose
 * write landed in the same gap finds `nlink === 0` afterwards and re-appends
 * the identical bytes itself (write.ts). Both copies then reach the hub, which
 * dedups them on a natural key — see appendThroughHandle for the key per kind.
 * Recovering twice is the side to err on; the alternative is a lost record.
 *
 * The window is small — measured p50 70 µs, p99 230 µs — and not empty: it cost
 * 15 records in 5760 under load with the append side already fixed.
 *
 * Exported so a test can hand it the one state that matters — a handle on an
 * orphaned inode that grew — which no caller can arrange from outside.
 */
export const rescueTail = async (
  home: string,
  key: string,
  spool: SessionSpool,
  handle: FileHandle,
  now: Date,
): Promise<void> => {
  const { size } = await handle.stat();
  if (size <= spool.size) {
    return;
  }
  const tail = await readTail(handle, spool.size, size);
  const whole = completeLines(tail);
  if (whole.length > 0 && (await appendOnce(spool.dataPath, whole)) !== "written") {
    await recordDrop(home, key, spool.slug, toLines(whole).length, "write-failed", now);
  }
  // BYTES on both sides: a `length` here would read every multi-byte character
  // as a missing byte and report a torn write that never happened.
  if (byteLength(whole) < byteLength(tail)) {
    // A write that had not landed whole when the name went: the bytes are real,
    // the record they belong to is not readable, and it is counted rather than
    // quietly discarded.
    await recordDrop(home, key, spool.slug, 1, "short-write", now);
  }
};

const removeSessionData = async (
  home: string,
  key: string,
  spool: SessionSpool,
  handle: FileHandle,
  now: Date,
): Promise<void> => {
  // Cursor first: a crash between the two leaves a data file with no cursor,
  // which re-sends. The other order would leave a cursor that a recreated file
  // could be read against, and skipping records is the unrecoverable direction.
  await removeFile(spool.cursorPath);
  await removeFile(spool.dataPath);
  await rescueTail(home, key, spool, handle, now);
};

/** Null when the file is gone or unreadable, which reads as "nothing to reap". */
const openForRemoval = async (path: string): Promise<FileHandle | null> => {
  try {
    return await open(path, "r");
  } catch {
    return null;
  }
};

const reapSlug = async (
  home: string,
  key: string,
  slug: string,
  now: Date,
): Promise<ReapResult> => {
  if (await isSessionLive(home, slug)) {
    return NOTHING_REAPED;
  }
  const spool = await readSessionSpool(home, key, slug);
  // `size > 0` first, because an EMPTY file would otherwise read as `0 >= 0` —
  // fully delivered — and `open(path, "a")` creates exactly that before an
  // appender's first write. Such a file was reapable with no flush, no cursor
  // and nothing delivered. It has nothing to deliver and no reason to go; the
  // age branch below still stops empty files from accumulating.
  const isDelivered = spool.size > 0 && spool.offset >= spool.size;
  const isExpired =
    !isDelivered && (await isOlderThanMaxAge(spool.dataPath, now));
  if (!isDelivered && !isExpired) {
    return NOTHING_REAPED;
  }
  // Held across every check and the unlink itself, so what the checks saw and
  // what the unlink removes are provably the same file.
  const handle = await openForRemoval(spool.dataPath);
  if (handle === null) {
    return NOTHING_REAPED;
  }
  try {
    if (!(await isSafeToRemove(home, spool, handle, now))) {
      return NOTHING_REAPED;
    }
    if (!isExpired) {
      await removeSessionData(home, key, spool, handle, now);
      return { delivered: 1, expired: 0, dropped: 0 };
    }
    // Counted before the bytes go, and into a file the removal does not touch.
    await recordDrop(home, key, slug, spool.lines.length, "expired", now);
    await removeSessionData(home, key, spool, handle, now);
    return { delivered: 0, expired: 1, dropped: spool.lines.length };
  } finally {
    await handle.close();
  }
};

/**
 * A `.drops` ledger deliberately outlives the data file it belongs to, so a
 * drop stays visible to `doctor` after the session is gone. This is what
 * finally bounds it.
 *
 * Age alone must not make the NUMBER disappear: nothing marks a ledger as seen,
 * so a developer who was away for two weeks after an outage would come back to
 * a clean `doctor` that had quietly deleted the evidence. The per-batch detail
 * ages out; the total is folded into an aggregate that does not.
 */
const reapOrphanDrops = async (
  home: string,
  key: string,
  slug: string,
  now: Date,
): Promise<void> => {
  const dropsPath = join(spoolDir(home, key), `${slug}${DROPS_SUFFIX}`);
  // Age is taken from the newest entry INSIDE the ledger, not from the file's
  // mtime, so retention is measured on the clock that WROTE the entries. The
  // two only agree while the injected clock and the filesystem's agree: reap
  // writes an expiry drop and reaches this sweep in the same pass, and an
  // mtime rule reading a `now` that runs ahead of the filesystem would delete
  // the line it had just written.
  const newest = await newestDropMs(dropsPath);
  if (newest === null || now.getTime() - newest <= MAX_SPOOL_AGE_DAYS * MS_PER_DAY) {
    return;
  }
  if (await isSessionLive(home, slug)) {
    return;
  }
  if (await Bun.file(spoolDataPath(home, key, slug)).exists()) {
    return;
  }
  // Folded BEFORE the bytes go, so a crash in between costs a duplicate total
  // at worst — over-reporting a drop is the honest direction to fail in.
  await archiveLedger(home, key, dropsPath);
  await removeFile(dropsPath);
};

export const PENDING_END_SUFFIX = ".pending-end";

const PendingEndSchema = z.looseObject({
  crosscheckSessionId: z.string().min(1),
  at: z.string().min(1),
});

/**
 * Ends the session a marker names. Returning false leaves the marker in place —
 * a hub that did not answer, or a hook with no budget left, must not be able to
 * make a deferred end disappear.
 */
export type DeferredEnder = (
  crosscheckSessionId: string,
) => Promise<boolean>;

const pendingEndSlugs = async (
  home: string,
  key: string,
): Promise<readonly string[]> => {
  try {
    return (await readdir(spoolDir(home, key)))
      .filter((name) => name.endsWith(PENDING_END_SUFFIX))
      .map((name) => name.slice(0, -PENDING_END_SUFFIX.length));
  } catch {
    return [];
  }
};

const markerDeferredAt = (at: string): Date | null => {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : new Date(ms);
};

/**
 * The second choice when the stamp inside a marker cannot be parsed, and it
 * means the same thing that stamp does: `recordPendingEnd` writes a marker once
 * and nothing ever rewrites it, so its mtime IS the moment SessionEnd deferred.
 */
const markerWrittenAt = async (path: string): Promise<Date | null> => {
  try {
    const { mtimeMs } = await stat(path);
    return new Date(mtimeMs);
  } catch {
    return null;
  }
};

/**
 * The same bound every other spool artifact obeys, applied to the one that used
 * to have none. Without it a hub that stays slow keeps a marker per session for
 * good, and each surviving marker costs `reap` a lookup on every SessionStart.
 *
 * Age comes from when the end was DEFERRED, never from when it expired, so the
 * clock runs from the end that never landed and an injected or skewed clock is
 * read the same way the drop ledger reads its own entries. The caller resolves
 * that one moment for both users of it — this bound and the count `doctor`
 * renders (unclosed.ts) — so neither can be measured off a different event.
 */
const isMarkerExpired = (deferredAt: Date, now: Date): boolean =>
  now.getTime() - deferredAt.getTime() > MAX_SPOOL_AGE_DAYS * MS_PER_DAY;

/**
 * The other half of SessionEnd's deferral: that hook leaves a marker instead of
 * telling the hub a session is finished while records it produced are still on
 * disk. Here is where the hub finally hears about it — the backlog is gone, so
 * the claim "this session is done" is true when it is made.
 *
 * Ending from here is expressible because `POST /api/sessions/:id/end` is
 * scoped to the authenticated developer, not to the session doing the asking
 * (server/src/routes/sessions.ts), and is idempotent for an already-ended one.
 *
 * A marker leaves this function in exactly one of four ways: spent on a
 * successful end, discarded because no session id can be read out of it,
 * retired and counted because it aged out, or left where it is for a later
 * SessionStart. Only the unreadable one loses information, and there was none
 * in it to lose.
 */
const endDeferredSession = async (
  home: string,
  key: string,
  slug: string,
  ender: DeferredEnder | undefined,
  now: Date,
): Promise<void> => {
  // A state file again means the same session id came back: it will end itself.
  if (await isSessionLive(home, slug)) {
    return;
  }
  const path = spoolPendingEndPath(home, key, slug);
  const parsed = PendingEndSchema.safeParse(await readJsonOrNull(path));
  if (!parsed.success) {
    // Nothing can be ended from an id that cannot be read, and a marker nobody
    // can act on would otherwise sit in the spool directory for good.
    await removeFile(path);
    return;
  }
  // The moment SessionEnd deferred, resolved once: the stamp the marker
  // carries, or the mtime of a file written once and never rewritten when that
  // stamp is unreadable. Both readers below take THIS value, so the age a
  // developer eventually reads cannot mean two different things. Null only if
  // the marker vanished between the read above and this stat — and a marker
  // that is already gone needs neither retiring nor counting.
  const deferredAt =
    markerDeferredAt(parsed.data.at) ?? (await markerWrittenAt(path));
  if (deferredAt !== null && isMarkerExpired(deferredAt, now)) {
    // Retired without a hub call, deliberately. This branch runs BEFORE the
    // backlog check below — that is what makes the bound unconditional — so
    // nothing here proves the session's records ever arrived, and "this session
    // is done" is exactly the claim SessionEnd refuses to make while its work
    // is still on disk. The call would also spend the reserve the hosting hook
    // holds for its briefing. Counted first, into a file this removal does not
    // touch, so what is lost is the retry, never the fact.
    await recordUnclosedSession(home, key, deferredAt);
    await removeFile(path);
    return;
  }
  // Only a caller with a hub and a budget can offer one; without it the marker
  // waits for a SessionStart that can, and ages out here in the meantime.
  if (ender === undefined) {
    return;
  }
  const spool = await readSessionSpool(home, key, slug);
  if (spool.lines.length > 0) {
    return;
  }
  if (!(await ender(parsed.data.crosscheckSessionId))) {
    return;
  }
  await removeFile(path);
};

/**
 * True when a `.pending-end` marker exists that a reap run by THIS hook could
 * actually spend: its session has not come back to life and its own backlog is
 * gone. The hosting hook holds one request timeout of spare back from the
 * drain for it — without that, any start with something to flush hands the
 * drain the whole spare, and `endDeferredSession`'s ender reads zero room at
 * the end of every single hook. Registration appends a work-context record on
 * EVERY start, so against a hub slower than the leftover spare the deferred
 * end would starve to its MAX_SPOOL_AGE_DAYS age-out: a livelock, not a race
 * (connector-claude/test/hook-budget.test.ts pins it through the fixture's
 * latency dial, and a mutation-check entry holds this probe honest).
 *
 * A marker whose own backlog is still on disk holds nothing back — draining is
 * exactly what that marker is waiting for, so the drain keeps its full spare.
 * Local file reads only (readdir, a state-file stat, a spool read): the probe
 * costs microseconds against budgets measured in hundreds of milliseconds.
 */
export const hasSpendablePendingEnd = async (
  home: string,
  key: string,
): Promise<boolean> => {
  for (const slug of await pendingEndSlugs(home, key)) {
    if (await isSessionLive(home, slug)) {
      continue;
    }
    const spool = await readSessionSpool(home, key, slug);
    if (spool.lines.length === 0) {
      return true;
    }
  }
  return false;
};

const total = (results: readonly ReapResult[]): ReapResult =>
  results.reduce(
    (sum, result) => ({
      delivered: sum.delivered + result.delivered,
      expired: sum.expired + result.expired,
      dropped: sum.dropped + result.dropped,
    }),
    NOTHING_REAPED,
  );

const dropSlugs = async (
  home: string,
  key: string,
): Promise<readonly string[]> => {
  try {
    return (await readdir(spoolDir(home, key)))
      .filter((name) => name.endsWith(DROPS_SUFFIX))
      .map((name) => name.slice(0, -DROPS_SUFFIX.length));
  } catch {
    return [];
  }
};

/**
 * Runs from SessionStart under the flush lock, whose failure mode is a harmless
 * skip.
 *
 * A cursor left behind by a data file that is already gone needs no cleanup:
 * `readCursorOffset` only trusts a cursor that provably belongs to the live
 * data file — inode AND first line, because ext4 hands a recreated file the
 * same inode number back (spool/identity.ts) — so a recreated file, by a later
 * session or by the append path recovering from an unlink, reads as offset 0
 * and re-sends rather than skips.
 *
 * `endDeferred` is optional because only a caller with a hub and a budget can
 * supply one; without it a marker cannot be spent, but it is still walked, so
 * the age bound on markers does not depend on who called.
 */
export const reapSpool = async (
  home: string,
  key: string,
  now: Date,
  endDeferred?: DeferredEnder,
): Promise<ReapResult> =>
  withLock<ReapResult>(
    spoolFlushLockPath(home, key),
    NOTHING_REAPED,
    async () => {
      const reaped = total(
        await Promise.all(
          (await listSessionSlugs(home, key)).map((slug) =>
            reapSlug(home, key, slug, now),
          ),
        ),
      );
      // After the reaping, so a spool emptied in this very pass counts as
      // drained. Sequential rather than parallel: each one may cost a hub call
      // out of the hook's spare time.
      for (const slug of await pendingEndSlugs(home, key)) {
        await endDeferredSession(home, key, slug, endDeferred, now);
      }
      for (const slug of await dropSlugs(home, key)) {
        await reapOrphanDrops(home, key, slug, now);
      }
      return reaped;
    },
  );