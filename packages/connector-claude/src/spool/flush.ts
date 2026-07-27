/**
 * Delivery. Reads, sends, and moves a cursor — it never touches the bytes of a
 * data file, so an appender running alongside it has nothing to lose.
 *
 * Sessions are served OLDEST BACKLOG FIRST, and the loop keeps going until the
 * spool is empty or the budget is spent. Both properties are load-bearing: with
 * one batch per call taken in filename order, a live session whose slug sorted
 * earlier consumed every batch and an older backlog never advanced at all.
 *
 * The budget comes FROM THE CALLER, in wall-clock milliseconds. A hook passes
 * what is left of its own after reserving the work it still owes the developer,
 * because a drain that outlives its host takes the briefing or the `end` call
 * down with it.
 *
 * The lock keeps two flushers from sending the same batch twice, and keeps a
 * reap out while one is running — `reap` takes the same path (spool/reap.ts).
 * Its failure mode is "skip this time": a flush that cannot take the lock
 * returns `locked` and the next hook retries. Skipping loses nothing, which is
 * why appends are allowed to ignore the lock entirely.
 */
import {
  MAX_FLUSH_BATCHES_PER_HOOK,
  MAX_INGEST_BATCH,
} from "../constants.ts";
import { spoolFlushLockPath } from "../config/paths.ts";
import { withProducer } from "../capture/records.ts";
import { postRecords } from "../http/hub.ts";
import type { HubContext } from "../http/client.ts";
import { bytesOfLines, writeCursorOffset } from "./cursor.ts";
import { recordDrop } from "./drops.ts";
import { readAllSessionSpools } from "./files.ts";
import type { SessionSpool } from "./files.ts";
import { lineTimestampMs } from "./lines.ts";
import { withLock } from "./lock.ts";

export interface FlushInput {
  readonly sessionId: string;
  readonly developerId: string | null;
}

export type FlushOutcome =
  | { readonly outcome: "empty" }
  | { readonly outcome: "locked" }
  /** The caller had no room left to spare; nothing was read or sent. */
  | { readonly outcome: "no-budget" }
  | { readonly outcome: "failed"; readonly remaining: number }
  | {
      readonly outcome: "flushed";
      readonly sent: number;
      readonly remaining: number;
    };

const parseLine = (line: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const pendingTotal = (spools: readonly SessionSpool[]): number =>
  spools.reduce((total, spool) => total + spool.lines.length, 0);

/**
 * Sends one batch and moves that spool's cursor past it. Returns how many
 * records went, or null when the hub refused them and nothing was consumed.
 *
 * The cursor move is the one part that can silently not happen: a file reaped
 * and recreated mid-flush is a different file, and `writeCursorOffset` refuses
 * it (cursor.ts). What that costs is a re-send the hub dedups, never a skip.
 *
 * Records are stamped with the FLUSHING session, not the one that wrote them:
 * ingest rejects records whose producer session has ended, so a dead session's
 * spool is only deliverable in a live session's name.
 */
const flushOneBatch = async (
  ctx: HubContext,
  input: FlushInput,
  spool: SessionSpool,
): Promise<number | null> => {
  const batch = spool.lines.slice(0, MAX_INGEST_BATCH);
  const consumed = spool.offset + bytesOfLines(spool.pending, batch.length);
  const parsed = batch.map(parseLine);
  const unparsable = parsed.filter((record) => record === null).length;
  const records = parsed
    .filter((record): record is Record<string, unknown> => record !== null)
    .map((record) => withProducer(record, input.developerId, input.sessionId));

  if (records.length > 0) {
    const result = await postRecords(ctx, records);
    if (!result.ok) {
      return null;
    }
  }
  // Counted BEFORE the cursor moves past them, so a line that is not JSON —
  // the only thing a torn write can produce — becomes a visible drop instead
  // of a silent hole. Counting first can at worst double-count after a crash
  // in the microseconds before the cursor write, and over-counting a drop is
  // the honest direction to fail in.
  await recordDrop(
    ctx.home,
    ctx.repoKey,
    spool.slug,
    unparsable,
    "unparsable",
    ctx.now(),
  );
  // The spool as READ is the identity: the cursor may only move for the file
  // this batch came from. A spool reaped and recreated mid-flush is a different
  // file — same name, and on ext4 the same inode number too — and its records
  // start at offset 0.
  await writeCursorOffset(spool.dataPath, spool.cursorPath, consumed, spool);
  return records.length;
};

/**
 * How old a spool's backlog is, taken from the first record still waiting.
 *
 * Ordering by NAME is what stranded backlogs: slugs are `encodeURIComponent` of
 * a session UUID, so "first pending file" was random, and a live session whose
 * slug happened to sort earlier consumed every batch while an older backlog sat
 * untouched until it aged out and was destroyed. The data file's mtime is the
 * fallback for a record with no readable `ts`.
 */
const backlogAgeMs = (spool: SessionSpool): number =>
  (spool.lines[0] === undefined ? null : lineTimestampMs(spool.lines[0])) ??
  spool.mtimeMs;

const oldestFirst = (
  left: SessionSpool,
  right: SessionSpool,
): number =>
  backlogAgeMs(left) - backlogAgeMs(right) || left.slug.localeCompare(right.slug);

const pendingSpools = async (
  ctx: HubContext,
): Promise<readonly SessionSpool[]> =>
  (await readAllSessionSpools(ctx.home, ctx.repoKey))
    .filter((spool) => spool.lines.length > 0)
    .sort(oldestFirst);

/**
 * A batch may not outlive the drain's deadline, so the request timeout is
 * clamped to whatever room is left. Without the clamp the loop could only stay
 * inside its budget by refusing to start a batch that MIGHT run the full
 * timeout, which on a fast hub meant refusing batches that would have taken
 * milliseconds. A clamped request that expires simply fails the flush, and a
 * failed flush costs nothing: the records are still on disk.
 */
const withinRoom = (ctx: HubContext, roomMs: number): HubContext => ({
  ...ctx,
  timeoutMs: Math.min(ctx.timeoutMs, roomMs),
});

/**
 * Keeps sending the oldest pending batch until the spool is empty, the hub
 * refuses, or the budget runs out. Draining inside the one lock acquisition is
 * what stops a backlog from needing one lucky hook invocation per batch; the
 * budget is what stops it from holding a developer's session while it does.
 */
const drain = async (
  ctx: HubContext,
  input: FlushInput,
  deadlineMs: number,
): Promise<FlushOutcome> => {
  let sent = 0;
  for (let batch = 0; batch < MAX_FLUSH_BATCHES_PER_HOOK; batch += 1) {
    // Checked BEFORE every batch, the first included: the budget belongs to the
    // hosting hook, and a round trip started without room left is exactly what
    // cost SessionStart its briefing and SessionEnd its `end` call.
    const roomMs = deadlineMs - Date.now();
    if (roomMs <= 0) {
      break;
    }
    // Re-read every round: the cursor moved, and appends land lock-free while
    // this loop runs, so the oldest backlog may not be the one it started with.
    const spools = await pendingSpools(ctx);
    const target = spools[0];
    if (target === undefined) {
      return batch === 0
        ? { outcome: "empty" }
        : { outcome: "flushed", sent, remaining: 0 };
    }
    const delivered = await flushOneBatch(withinRoom(ctx, roomMs), input, target);
    if (delivered === null) {
      return { outcome: "failed", remaining: pendingTotal(spools) };
    }
    sent += delivered;
  }
  return {
    outcome: "flushed",
    sent,
    remaining: pendingTotal(await pendingSpools(ctx)),
  };
};

/**
 * `budgetMs` is the wall-clock room the CALLER can spare — for a hook, what is
 * left of its own budget after reserving what it still has to do. It is a
 * parameter rather than a ratio because a fixed ratio cannot know how much of
 * the hook has already been spent, and the one that shipped (2 × the request
 * timeout) equalled the whole SessionEnd budget.
 *
 * A budget of zero or less is honest and normal: nothing is sent, and the next
 * hook tries again.
 */
export const flushSpool = async (
  ctx: HubContext,
  input: FlushInput,
  budgetMs: number,
): Promise<FlushOutcome> => {
  if (budgetMs <= 0) {
    return { outcome: "no-budget" };
  }
  // Wall clock, not ctx.now(): this bounds how long the developer waits, and
  // ctx.now() is an injected, deliberately frozen clock in tests.
  const deadlineMs = Date.now() + budgetMs;
  const locked = await withLock<FlushOutcome | null>(
    spoolFlushLockPath(ctx.home, ctx.repoKey),
    ctx.now(),
    null,
    () => drain(ctx, input, deadlineMs),
  );
  return locked ?? { outcome: "locked" };
};