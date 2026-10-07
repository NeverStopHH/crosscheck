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
import { spoolFlushLockPath, spoolOwedWorkContextPath } from "../config/paths.ts";
import { withProducer } from "../capture/records.ts";
import { postRecords } from "../http/hub.ts";
import type { IngestSummary, RecordResult } from "../http/hub.ts";
import type { HubContext } from "../http/client.ts";
import { bytesOfLines, lineEnds, readCountedLines, writeCursorOffset } from "./cursor.ts";
import { batchLosses } from "./batch-losses.ts";
import type { BatchLine, SpooledLine } from "./batch-losses.ts";
import { addCount } from "./counts.ts";
import type { Counts } from "./counts.ts";
import { recordDrop } from "./drops.ts";
import { readAllSessionSpools } from "./files.ts";
import type { SessionSpool } from "./files.ts";
import { healAndResend, isRefusedLifeRecord } from "./flush-heal.ts";
import {
  answerOwed,
  deliverOwed,
  isOwedFor,
  owedRecordNow,
  readLifeState,
  readOwedWorkContext,
  settleOwedWorkContext,
  withLifeState,
  workContextIdOf,
} from "./owed-work-context.ts";
import type { OwedOutcome, OwedWorkContext } from "./owed-work-context.ts";
import type { SessionHeal, SessionHealer } from "./flush-heal.ts";
import { lineTimestampMs } from "./lines.ts";
import { withLock } from "./lock.ts";
import { mayFlusherSend } from "./ownership.ts";
import { readRefusedLives, recordRefusedLife } from "./refused-lives.ts";
import { rejectCauseOf } from "./reject-cause.ts";
import type { RejectCause } from "./reject-cause.ts";

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

/**
 * ONE SLOT OF EVERY BATCH IS KEPT for an owed work context (spool/owed-work-
 * context.ts), whether a debt is open or not (review-2 round 7, L1): a batch
 * is then the same lines on every flush that meets it, so what a walk noted
 * on the cursor for it always lies inside the batch that settles it.
 */
const BATCH_LINES = MAX_INGEST_BATCH - 1;

/** The session that wrote a spooled line, as its envelope says. */
const writerOf = (line: string): string | undefined => {
  const producer = parseLine(line)?.["producer"];
  const sessionId =
    typeof producer === "object" && producer !== null ? (producer as { sessionId?: unknown }).sessionId : undefined;
  return typeof sessionId === "string" ? sessionId : undefined;
};

/**
 * ONE LIFE PER BATCH (review-2 round 7): the head lines up to the first one
 * another life wrote. At most one owed work context goes ahead of a batch —
 * the debt of the life it carries, settled under the spool that owes it —
 * and a heal inside it re-sends one life's records. A line whose writer
 * cannot be read (torn) rides with the run it is in.
 */
const oneLife = (lines: readonly string[]): readonly string[] => {
  const writers = lines.map(writerOf);
  const life = writers.find((writer) => writer !== undefined);
  const other = writers.findIndex((writer) => writer !== undefined && writer !== life);
  return other === -1 ? lines : lines.slice(0, other);
};

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

/** What a batch's send did: the hub's answer for the batch, and what became of the debt that went ahead of it. */
interface Sent {
  readonly summary: IngestSummary;
  readonly debt: OwedOutcome | null;
  /** The hub's own answer for the debt, when one went. */
  readonly owedAnswer: RecordResult | undefined;
}

/**
 * Sends the batch — with the owed work context at its head when the batch
 * carries the life it is owed for: settled once the hub took it, one refusal
 * counted when the hub refused the record itself (spool/owed-work-context.ts).
 */
const send = async (
  ctx: HubContext,
  input: FlushInput,
  spool: SessionSpool,
  owed: OwedWorkContext | null,
  records: readonly Record<string, unknown>[],
): Promise<Sent | null> => {
  if (owed === null) {
    const summary = await deliver(ctx, records);
    return summary === null ? null : { summary, debt: null, owedAnswer: undefined };
  }
  const delivery = await deliverOwed(ctx, spool.slug, owed, input.developerId, input.sessionId, records);
  if (delivery === null) {
    return null;
  }
  const debt = await answerOwed(
    ctx.home,
    ctx.repoKey,
    spool.slug,
    workContextIdOf(owed.record),
    delivery.owedAnswer,
    ctx.now(),
  );
  return { summary: delivery.summary, debt, owedAnswer: delivery.owedAnswer };
};

/**
 * The spool's debt — settled as moot, never paid, when its life is one the hub
 * has ended (review-2 round 7, found by the spool simulation): paid then, its
 * work context would be filed into that ended session past its end, where the
 * life's own records are withheld from (spool/refused-lives.ts).
 */
const liveDebt = async (
  ctx: HubContext,
  spool: SessionSpool,
  refusedLives: ReadonlySet<string>,
  flusherSessionId: string,
): Promise<OwedWorkContext | null> => {
  const owed = await readOwedWorkContext(ctx.home, ctx.repoKey, spool.slug);
  if (owed === null || owed.sessionId === flusherSessionId || !refusedLives.has(owed.sessionId)) {
    return owed;
  }
  await settleOwedWorkContext(ctx.home, ctx.repoKey, spool.slug, workContextIdOf(owed.record));
  return null;
};

/** The work context this spool owes `sessionId`, built as it goes now — or null when it owes that life none. */
const owedNowFor = async (
  ctx: HubContext,
  spool: SessionSpool,
  sessionId: string,
): Promise<Record<string, unknown> | null> => {
  const owed = await readOwedWorkContext(ctx.home, ctx.repoKey, spool.slug);
  return owed === null || owed.sessionId !== sessionId
    ? null
    : owedRecordNow(ctx.home, ctx.repoKey, spool.slug, owed, ctx.now());
};

/** Whether the life's own records were refused `author_unknown` while its work context is still owed. */
const isPinnedByDebt = async (
  ctx: HubContext,
  spool: SessionSpool,
  summary: IngestSummary,
  sendable: readonly SpooledLine[],
): Promise<boolean> => {
  const owed = await readOwedWorkContext(ctx.home, ctx.repoKey, spool.slug);
  return (
    owed !== null &&
    (summary.results ?? []).some((result) => {
      const line = sendable[result.index];
      return (
        result.status === "rejected" &&
        rejectCauseOf(result.issues) === "author_unknown" &&
        line !== undefined &&
        isOwedFor(owed, line.record)
      );
    })
  );
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

/** The envelope ids of the records the hub answered `status` (spool/drops.ts recordDrop). */
const idsWithStatus = (
  records: readonly Record<string, unknown>[],
  results: readonly RecordResult[] | undefined,
  status: string,
): readonly string[] =>
  (results ?? [])
    .filter((result) => result.status === status)
    .flatMap((result) => {
      const id = records[result.index]?.["id"];
      return typeof id === "string" ? [id] : [];
    });

/**
 * WHY each refused record was refused, as a word (spool/reject-cause.ts) —
 * never the hub's sentence, which is another process's prose. A hub from
 * before per-record results sends none, and the count then carries no cause.
 */
const rejectCauses = (
  results: readonly RecordResult[] | undefined,
  causeOf: (result: RecordResult) => RejectCause,
): Counts =>
  (results ?? [])
    .filter((result) => result.status === "rejected")
    .reduce<Counts>((causes, result) => addCount(causes, causeOf(result), 1), {});

/**
 * The cause a refused record is counted under: the hub's word for it — or,
 * for a record of the life whose debt this batch released, `owed_wc_refused`
 * (review-2 round 7, M3): the work context it needed was refused for good.
 */
const causeIn =
  (sendable: readonly SpooledLine[], released: OwedWorkContext | null) =>
  (result: RecordResult): RejectCause => {
    const cause = rejectCauseOf(result.issues);
    const line = sendable[result.index];
    return cause === "author_unknown" && released !== null && line !== undefined && isOwedFor(released, line.record)
      ? "owed_wc_refused"
      : cause;
  };

/** What one batch did: how many records went, and whether it healed the producer. */
interface BatchOutcome {
  readonly sent: number;
  readonly heal: SessionHeal | null;
  /** The healer was asked — the flush's one walk is spent, whatever it answered. */
  readonly healAsked: boolean;
  /** The spool sends nothing more this drain: its debt is still open and its next batch would only meet it again. */
  readonly isPinned: boolean;
}

const PINNED: BatchOutcome = { sent: 0, heal: null, healAsked: false, isPinned: true };

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
  // The owed work context goes at the head of the batch that carries its
  // life's records (spool/owed-work-context.ts) — or alone, when the spool
  // holds nothing more for any life to carry it.
  const owed = await liveDebt(ctx, spool, refusedLives, input.sessionId);
  const batch = oneLife(spool.lines.slice(0, BATCH_LINES));
  const consumed = spool.offset + bytesOfLines(spool.pending, batch.length);
  const ends = lineEnds(spool.pending, batch.length, spool.offset);
  // A line an earlier walk already counted is settled: never sent, or
  // counted, twice (spool/batch-losses.ts).
  const earlier = await readCountedLines(spool.cursorPath, spool);
  const lines: readonly BatchLine[] = batch
    .map((line, index) => ({ record: parseLine(line), end: ends[index] ?? consumed }))
    .filter((line) => !earlier.has(line.end));
  const isWithheld = (record: Record<string, unknown>): boolean =>
    isRefusedLifeRecord(record, refusedLives, input.sessionId);
  const sendable = lines.filter(
    (line): line is SpooledLine => line.record !== null && !isWithheld(line.record),
  );
  // A spooled work context goes with its life's title and status as they
  // are NOW (spool/owed-work-context.ts withLifeState); the batch is one life.
  const life = batch.map(writerOf).find((writer) => writer !== undefined);
  const lifeState = life === undefined ? null : await readLifeState(ctx.home, ctx.repoKey, spool.slug, life);
  const spooled = sendable.map((line) => withLifeState(line.record, lifeState));
  const records = spooled.map((record) => withProducer(record, input.developerId, input.sessionId));
  const isLoneDebt = owed !== null && batch.length === 0;
  const paying = owed !== null && (isLoneDebt || sendable.some((line) => isOwedFor(owed, line.record))) ? owed : null;

  const first = await send(ctx, input, spool, paying, records);
  if (first === null) {
    return null;
  }
  if (isLoneDebt) {
    // A DEBT WITH NO RECORDS LEFT TO CARRY IT is paid alone (review-2 round
    // 7): a life that writes nothing after its heal never pays it otherwise,
    // and SessionEnd defers its end on it for good. One that stays open
    // waits for the next drain, not the next batch — and one refused because
    // the hub ended the flusher's life says so for every later flush, as a
    // batch's refusal does (spool/flush-heal.ts).
    if (first.owedAnswer?.status === "rejected" && rejectCauseOf(first.owedAnswer.issues) === "session_ended") {
      await recordRefusedLife(ctx.home, ctx.repoKey, input.sessionId, ctx.now());
    }
    return (await readOwedWorkContext(ctx.home, ctx.repoKey, spool.slug)) === null
      ? { sent: 0, heal: null, healAsked: false, isPinned: false }
      : PINNED;
  }
  // A DEBT RELEASED in this batch (review-2 round 7, M3) takes its life's
  // records the hub refused for want of it along: counted `owed_wc_refused`,
  // the cause that says why, never `author_unknown` as if nobody knew.
  let released: OwedWorkContext | null = first.debt === "released" ? paying : null;
  // ...and a debt the hub refused goes once per drain: the spool is passed
  // over after this batch, so OWED_WORK_CONTEXT_MAX_REFUSALS counts drains.
  let isDebtRefused = first.debt === "refused";
  // WHAT THIS BATCH HAS LOST WHATEVER COMES NEXT — torn lines, withheld
  // stragglers, refusals no heal can carry — written once: before a heal's
  // walk when one runs, so the register it sends already reports them
  // (review P3), else just below; and once per LINE across flushes, so a
  // batch a walk leaves on disk is not counted again (spool/batch-losses.ts).
  const losses = batchLosses(ctx, spool, lines, sendable, isWithheld, earlier);
  const healed = await healAndResend({
    ctx,
    developerId: input.developerId,
    flusherSessionId: input.sessionId,
    spooled,
    first: first.summary,
    healer: input.heal,
    deadlineMs,
    beforeWalk: losses.write,
    owedFor: (sessionId) => owedNowFor(ctx, spool, sessionId),
    answerOwed: async (record, answer) => {
      const owedNow = await readOwedWorkContext(ctx.home, ctx.repoKey, spool.slug);
      const outcome = await answerOwed(ctx.home, ctx.repoKey, spool.slug, workContextIdOf(record), answer, ctx.now());
      released = outcome === "released" ? owedNow : released;
      isDebtRefused = isDebtRefused || outcome === "refused";
    },
  });
  if (healed === null) {
    return null;
  }
  const summary = healed.summary;
  // A life's records refused for the work context it is still owed are
  // NEEDED LATER (review-2 round 6, HIGH-1): the debt is paid at the head of
  // its next batch, and spending them now loses them for a record in flight.
  // The spool is passed over for the rest of the drain (review-2 round 7, M3);
  // the debt's own bound is what ends the wait.
  if (await isPinnedByDebt(ctx, spool, summary, sendable)) {
    return PINNED;
  }
  await losses.write([]);
  // The refusals a heal's walk already wrote down are not counted twice. An
  // earlier walk's never reach this batch: a noted line is not sent again.
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
  // Counted BEFORE the cursor moves past them (`losses` above holds the
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
      rejectCauses(uncounted, causeIn(sendable, released)),
      idsWithStatus(records, uncounted, "rejected"),
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
      {},
      idsWithStatus(records, summary.results, "ignored"),
    );
  }
  // The spool as READ is the identity: the cursor may only move for the file
  // this batch came from. A spool reaped and recreated mid-flush is a different
  // file — same name, and on ext4 the same inode number too — and its records
  // start at offset 0.
  await writeCursorOffset(spool.dataPath, spool.cursorPath, consumed, spool);
  return { sent: records.length, heal: healed.heal, healAsked: healed.asked, isPinned: isDebtRefused };
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

/** Whether a spool with nothing left to send still owes its life's work context. */
const owesAlone = (ctx: HubContext, spool: SessionSpool): Promise<boolean> =>
  Bun.file(spoolOwedWorkContextPath(ctx.home, ctx.repoKey, spool.slug)).exists();

/** Every spool with a record to send — or a work context it still owes with none (flushOneBatch). */
const pendingSpools = async (
  ctx: HubContext,
): Promise<readonly SessionSpool[]> => {
  const spools = await readAllSessionSpools(ctx.home, ctx.repoKey);
  const owing = await Promise.all(spools.map((spool) => (spool.lines.length > 0 ? true : owesAlone(ctx, spool))));
  return spools.filter((_, index) => owing[index] === true).sort(oldestFirst);
};

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
 * The first spool, oldest backlog first, this flusher may send: its own, an
 * ended conversation's or an abandoned one's — never another live
 * conversation's (spool/ownership.ts).
 */
const nextOwnedSpool = async (
  ctx: HubContext,
  spools: readonly SessionSpool[],
  flusherSessionId: string,
  pinned: ReadonlySet<string>,
): Promise<SessionSpool | null> => {
  for (const spool of spools) {
    if (!pinned.has(spool.slug) && (await mayFlusherSend(ctx.home, ctx.repoKey, spool, flusherSessionId, ctx.now()))) {
      return spool;
    }
  }
  return null;
};

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
  // A walk for this very life registered nothing and its cooldown runs:
  // every record sent under it would be refused again, so none is sent — a
  // batch pinned on disk was re-sent by every hook for five minutes
  // (review-2 LOW-5). The next flush after the cooldown walks again.
  if ((await input.heal?.refusedFor?.(input.sessionId)) === true) {
    return { outcome: "failed", remaining: pendingTotal(await pendingSpools(ctx)) };
  }
  let sent = 0;
  let producer = input;
  let refusedLives = await readRefusedLives(ctx.home, ctx.repoKey, ctx.now());
  // A PINNED SPOOL IS PASSED OVER for the rest of this drain, never failing it
  // (review-2 round 7, M3): its debt waits for the next one, and every other
  // spool this flusher may send still goes.
  let pinned: ReadonlySet<string> = new Set();
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
    if (spools.length === 0) {
      return batch === 0
        ? { outcome: "empty" }
        : { outcome: "flushed", sent, remaining: 0 };
    }
    // The oldest backlog this flusher may send: another live conversation's
    // waits for that conversation (spool/ownership.ts), and the drain goes on
    // past it.
    const target = await nextOwnedSpool(ctx, spools, producer.sessionId, pinned);
    if (target === null) {
      return { outcome: "flushed", sent, remaining: pendingTotal(spools) };
    }
    const delivered = await flushOneBatch(withinRoom(ctx, roomMs), producer, target, deadlineMs, refusedLives);
    if (delivered === null) {
      return { outcome: "failed", remaining: pendingTotal(spools) };
    }
    pinned = delivered.isPinned ? new Set([...pinned, target.slug]) : pinned;
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