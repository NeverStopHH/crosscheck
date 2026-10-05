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
 *
 * That second half held only while a flush stayed inside the section for less
 * than SPOOL_LOCK_STALE_MS: past that, its claim looked abandoned and a reap
 * took it mid-request. What the guarantee rests on now is that a claim whose
 * holder process is still running is never taken (spool/lock.ts), so the time
 * this drain spends no longer bounds it — and a drain runs to a wall-clock
 * deadline that a slow hub can legitimately push past that window.
 *
 * VERIFY: bun test test/spool-lock.test.ts 2>&1 | grep -c '^(fail)'
 * PRINTS: 0
 */
import {
  MAX_FLUSH_BATCHES_PER_HOOK,
  MAX_INGEST_BATCH,
} from "../constants.ts";
import { spoolFlushLockPath } from "../config/paths.ts";
import { withProducer } from "../capture/records.ts";
import { postRecords } from "../http/hub.ts";
import type { IngestSummary, RecordResult } from "../http/hub.ts";
import type { HubContext } from "../http/client.ts";
import { bytesOfLines, writeCursorOffset } from "./cursor.ts";
import { addCount } from "./counts.ts";
import type { Counts } from "./counts.ts";
import { recordDrop } from "./drops.ts";
import { readAllSessionSpools } from "./files.ts";
import type { SessionSpool } from "./files.ts";
import { healAndResend, isRefusedLifeRecord, kindsOf } from "./flush-heal.ts";
import type { SessionHeal, SessionHealer } from "./flush-heal.ts";
import { lineTimestampMs } from "./lines.ts";
import { withLock } from "./lock.ts";
import { readRefusedLives } from "./refused-lives.ts";
import { rejectCauseOf } from "./reject-cause.ts";

export type { SessionHeal, SessionHealer } from "./flush-heal.ts";

export interface FlushInput {
  readonly sessionId: string;
  readonly developerId: string | null;
  /**
   * Re-registers the flushing session when the hub refuses its OWN id
   * (flows/heal-session.ts) — asked at most once per flush. The hooks of a
   * live host session pass one; the SessionEnd drain does not, because a life
   * about to end has nothing to heal for.
   */
  readonly heal?: SessionHealer;
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

const NOTHING_SENT: IngestSummary = {
  accepted: 0,
  duplicates: 0,
  ignored: 0,
  rejected: 0,
};

/**
 * Sends the batch. Null when the hub did not take it at all — transport, an
 * HTTP failure — and the records stay on disk for the next drain; an
 * all-zero summary when there was nothing to send.
 */
const deliver = async (
  ctx: HubContext,
  records: readonly Record<string, unknown>[],
): Promise<IngestSummary | null> => {
  if (records.length === 0) {
    return NOTHING_SENT;
  }
  const result = await postRecords(ctx, records);
  return result.ok ? result.data : null;
};

/**
 * The record KINDS behind a per-record status, counted off the envelopes
 * this batch sent — `results[i]` is the hub's answer to `records[i]`, in
 * order (server services/records.ts ingestRecords). Kinds are the
 * connector's own vocabulary, so doctor can print them; a hub from before
 * per-record results sends none, and the count then travels under no kind.
 */
const kindsWithStatus = (
  records: readonly Record<string, unknown>[],
  results: readonly RecordResult[] | undefined,
  status: string,
): Counts =>
  (results ?? [])
    .filter((result) => result.status === status)
    .reduce<Counts>((kinds, result) => {
      const kind = records[result.index]?.["kind"];
      return typeof kind === "string" ? addCount(kinds, kind, 1) : kinds;
    }, {});

/**
 * WHY each refused record was refused, as a word (spool/reject-cause.ts) —
 * never the hub's sentence, which is another process's prose. A hub from
 * before per-record results sends none, and the count then carries no cause.
 */
const rejectCauses = (results: readonly RecordResult[] | undefined): Counts =>
  (results ?? [])
    .filter((result) => result.status === "rejected")
    .reduce<Counts>((causes, result) => addCount(causes, rejectCauseOf(result.issues), 1), {});

/** A write that runs at most once, however many paths ask for it. */
const once = (run: () => Promise<void>): (() => Promise<void>) => {
  let started: Promise<void> | null = null;
  return () => {
    started ??= run();
    return started;
  };
};

/** What one batch did: how many records went, and whether it healed the producer. */
interface BatchOutcome {
  readonly sent: number;
  readonly heal: SessionHeal | null;
  /** The healer was asked — the flush's one walk is spent, whatever it answered. */
  readonly healAsked: boolean;
}

/**
 * WITHHELD, NOT SENT: records a refused life produced whose body names that
 * life (spool/flush-heal.ts). Counted as the hub's own `rejected` with the
 * cause it gave for their life — the hub already ended it, and any live
 * session's delivery would file them into it past its end.
 */
const recordWithheld = async (
  ctx: HubContext,
  spool: SessionSpool,
  withheld: readonly Record<string, unknown>[],
): Promise<void> => {
  if (withheld.length > 0) {
    await recordDrop(ctx.home, ctx.repoKey, spool.slug, withheld.length, "rejected", ctx.now(), kindsOf(withheld), {
      session_ended: withheld.length,
    });
  }
};

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
 * spool is only deliverable in a live session's name. When the hub refuses the
 * flushing session ITSELF, `healAndResend` asks the healer once and re-sends
 * what the batch may carry under the life it registers (spool/flush-heal.ts).
 */
const flushOneBatch = async (
  ctx: HubContext,
  input: FlushInput,
  spool: SessionSpool,
  deadlineMs: number,
  refusedLives: ReadonlySet<string>,
): Promise<BatchOutcome | null> => {
  const batch = spool.lines.slice(0, MAX_INGEST_BATCH);
  const consumed = spool.offset + bytesOfLines(spool.pending, batch.length);
  const parsed = batch.map(parseLine);
  const unparsable = parsed.filter((record) => record === null).length;
  const spooled = parsed.filter((record): record is Record<string, unknown> => record !== null);
  const isWithheld = (record: Record<string, unknown>): boolean =>
    isRefusedLifeRecord(record, refusedLives, input.sessionId);
  const sendable = spooled.filter((record) => !isWithheld(record));
  const records = sendable.map((record) => withProducer(record, input.developerId, input.sessionId));

  const first = await deliver(ctx, records);
  if (first === null) {
    return null;
  }
  // WHAT THIS BATCH HAS LOST WHATEVER COMES NEXT — torn lines, withheld
  // stragglers — written once: before a heal's walk when one runs, so the
  // register it sends already reports them (review P3), else just below.
  const writeSealed = once(async () => {
    await recordDrop(ctx.home, ctx.repoKey, spool.slug, unparsable, "unparsable", ctx.now());
    await recordWithheld(ctx, spool, spooled.filter(isWithheld));
  });
  const healed = await healAndResend({
    ctx,
    developerId: input.developerId,
    flusherSessionId: input.sessionId,
    spooled: sendable,
    first,
    healer: input.heal,
    deadlineMs,
    spoolSlug: spool.slug,
    beforeWalk: writeSealed,
  });
  if (healed === null) {
    return null;
  }
  const summary = healed.summary;
  await writeSealed();
  // The refusals a heal's walk already wrote down are not counted twice.
  const uncounted = (summary.results ?? []).filter((result) => !healed.counted.has(result.index));
  // A 2xx is not a delivery. Ingest reports per-record outcomes, and a
  // record the hub REFUSED is discarded by the cursor write below exactly
  // like a torn line — so it is counted exactly like one. Nothing in the
  // connector read `rejected` before, which is how a session the hub had
  // closed could lose a whole afternoon while `spool drops` printed "none"
  // (review finding B2-01/B2-07).
  //
  // AND `ignored` IS THE SAME LOSS WEARING A 200. It is what a hub older than
  // a record kind answers about that kind (server services/records.ts, the
  // forward-compatibility rule), and it was read nowhere: a newer connector
  // against an older hub lost whole record kinds while `spool drops` printed
  // "none" (docs/1.0/loss-accounting.md §1). Counted with the kinds the hub
  // ignored, so doctor can say what an upgrade would recover.
  const refused =
    summary.results === undefined
      ? summary.rejected
      : uncounted.filter((result) => result.status === "rejected").length;
  const ignored = summary.ignored;
  // Counted BEFORE the cursor moves past them (`writeSealed` above holds the
  // torn lines), so a line that is not JSON — the only thing a torn write can
  // produce — becomes a visible drop instead of a silent hole. Counting first
  // can at worst double-count after a crash in the microseconds before the
  // cursor write, and over-counting a drop is the honest direction to fail in.
  if (refused > 0) {
    await recordDrop(
      ctx.home,
      ctx.repoKey,
      spool.slug,
      refused,
      "rejected",
      ctx.now(),
      kindsWithStatus(records, uncounted, "rejected"),
      rejectCauses(uncounted),
    );
  }
  if (ignored > 0) {
    await recordDrop(
      ctx.home,
      ctx.repoKey,
      spool.slug,
      ignored,
      "ignored",
      ctx.now(),
      kindsWithStatus(records, summary.results, "ignored"),
    );
  }
  // The spool as READ is the identity: the cursor may only move for the file
  // this batch came from. A spool reaped and recreated mid-flush is a different
  // file — same name, and on ext4 the same inode number too — and its records
  // start at offset 0.
  await writeCursorOffset(spool.dataPath, spool.cursorPath, consumed, spool);
  return { sent: records.length, heal: healed.heal, healAsked: healed.asked };
};

/**
 * The producer the drain's later batches carry: the healed life once a batch
 * registered one, and no healer once one was asked — one walk per flush.
 */
const afterBatch = (producer: FlushInput, outcome: BatchOutcome): FlushInput =>
  outcome.healAsked
    ? {
        sessionId: outcome.heal?.sessionId ?? producer.sessionId,
        developerId: producer.developerId,
      }
    : producer;

/** A heal that moved lives adds the refused one to what the drain withholds. */
const withRefused = (refused: ReadonlySet<string>, heal: SessionHeal | null): ReadonlySet<string> =>
  heal === null || heal.sessionId === heal.refusedSessionId
    ? refused
    : new Set([...refused, heal.refusedSessionId]);

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
  let producer = input;
  let refusedLives = await readRefusedLives(ctx.home, ctx.repoKey, ctx.now());
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
    const delivered = await flushOneBatch(
      withinRoom(ctx, roomMs),
      producer,
      target,
      deadlineMs,
      refusedLives,
    );
    if (delivered === null) {
      return { outcome: "failed", remaining: pendingTotal(spools) };
    }
    sent += delivered.sent;
    producer = afterBatch(producer, delivered);
    refusedLives = withRefused(refusedLives, delivered.heal);
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
    null,
    () => drain(ctx, input, deadlineMs),
  );
  return locked ?? { outcome: "locked" };
};