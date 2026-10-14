/**
 * WRITING A POSITION DOWN (spec 01 §3.5) — the projection half of the causal
 * order. `session-order.ts` is the reading half.
 *
 * ONE PIPELINE, NOT TWO. Every row here is written by the handler that stores
 * the record it projects, inside that handler's own transaction where it has
 * one. The nine dotted names are a projection of records that already travel;
 * nothing new goes on the wire but the position itself.
 *
 * THE THIRD OUTCOME, and the reason it exists. A write whose
 * `(session, epoch, n)` is already held by a DIFFERENT event is neither a
 * duplicate nor a rejection: the row is stored with a NULL position and the
 * reason `epoch_conflict`. Rejecting would destroy the record, because a
 * connector's flush advances its cursor on any 2xx — a rejected batch is a
 * DELIVERED batch as far as the spool is concerned, and the work is gone. The
 * record survives; only its position is lost, and the loss is counted.
 */
import { and, eq, sql } from "drizzle-orm";
import { isSeqStamp } from "@crosscheck/schema";
import type {
  EventRefKind,
  SeqField,
  SeqKind,
  SeqReason,
  SeqStamp,
  SessionEventKind,
} from "@crosscheck/schema";

import { agentSessions, sessionEvents } from "../db/schema.ts";
import type { DbExecutor } from "../db/client.ts";
import {
  capContradictedGuarantee,
  capLifecycleContradictions,
  contradictsGuaranteed,
} from "./causal-guarantees.ts";
import type { OrderedEvent } from "./session-order.ts";
import type { Clock } from "../types.ts";

interface Deps {
  readonly db: DbExecutor;
  readonly now: Clock;
}

/** 128 bits of SHA-256 — deterministic AND short, the hint-delivery shape. */
const SESSION_EVENT_ID_HASH_CHARS = 32;

export interface SessionEventIdInput {
  readonly sessionId: string;
  readonly kind: string;
  readonly seqEpoch: string | null;
  readonly seqN: number | null;
  readonly refKind: string;
  readonly refId: string;
}

/**
 * THE KIND AND THE POSITION ARE BOTH INSIDE THE HASH, and the first draft of
 * this table left both out.
 *
 * The obvious id is `hintDeliveryId`'s — sha256 of (session, ref) — for its
 * stated reason: a spool replay re-sends the same primary key and the hub
 * answers `duplicate` instead of writing a second row. On THIS table that
 * pattern silently deletes events, because three kinds share one referent:
 * `session.started`, `commit.observed` and `session.ended` all point at the
 * session, so the second and third would be answered duplicate and receive no
 * position at all. A replay is still a duplicate under this formula, because
 * the connector stamps `seq` once and re-sends the same value.
 *
 * WHAT AN ABSENT POSITION COSTS, named rather than hidden: with `seqN` null
 * the hash carries the literal "null", so two genuinely distinct unsequenced
 * events of the same kind on the same referent collapse to one row and the
 * second is answered duplicate. It is counted under its reason and printed.
 * The cost is bounded and it is the right one — without a position, nothing
 * could have used the distinction anyway.
 */
export const sessionEventId = (input: SessionEventIdInput): string =>
  `se_${new Bun.CryptoHasher("sha256")
    .update(
      [
        input.sessionId,
        input.kind,
        input.seqEpoch ?? "null",
        input.seqN === null ? "null" : String(input.seqN),
        input.refKind,
        input.refId,
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, SESSION_EVENT_ID_HASH_CHARS)}`;

/**
 * The referent of a file or fingerprint target.
 *
 * `work_context_targets` has the primary key (work_context_id, kind, value)
 * and no id column, and `value` IS the author-written file path. A `ref_id`
 * naming it directly would put a path into a table whose whole claim is that
 * it holds no content — so the referent is a hash of the triple instead:
 * content-free by construction, joinable by recomputing the same hash, and
 * carrying nothing a renderer could print.
 */
export const targetDigest = (
  workContextId: string,
  kind: string,
  value: string,
): string =>
  new Bun.CryptoHasher("sha256")
    .update([workContextId, kind, value].join("\n"))
    .digest("hex");

export interface RecordSessionEventInput {
  readonly sessionId: string;
  readonly kind: SessionEventKind;
  /** The envelope's own field: a stamp, a refusal, or absent entirely. */
  readonly seq: SeqField | undefined;
  readonly seqKind: SeqKind;
  readonly refKind: EventRefKind;
  readonly refId: string;
  /** Overrides the reason an absent `seq` would otherwise carry (a reap). */
  readonly absentReason?: SeqReason;
  /**
   * The work context of the RECORD this row projects (01a §3.2). Omitted for
   * the session-level kinds, which belong to no one work context.
   */
  readonly workContextId?: string;
  /**
   * `file.modified` only (01a §3.3d): the touched file's identity, or null
   * when its path has no canonical spelling — UNRESOLVED, and kept (§3.3e).
   */
  readonly fileRef?: string | null;
}

/**
 * ABSENT AND REFUSED ARE DIFFERENT FACTS, and confounding them would make
 * every `doctor` line about instrumentation coverage a guess: absent is a
 * connector from before this protocol field, refused is a seq-capable emitter
 * that tried and could not.
 */
/**
 * THE OPEN END OF THE INTERVAL, or null when there is not one.
 *
 * `after` is a position the emitter took BEFORE the work started, so it must
 * sit at or below the position it brackets. A stamp claiming otherwise is a
 * broken emitter, and the answer is to drop the bracket rather than the
 * record: an unbracketed position is read as the upper bound it is, which is
 * the conservative half of the same fact. Rejecting would destroy the record,
 * because a connector's flush advances its cursor on any 2xx.
 */
export const windowFloorOf = (stamp: SeqStamp): number | null =>
  stamp.after === undefined || stamp.after > stamp.n ? null : stamp.after;

/**
 * WHY THIS RECORD HAS THE POSITION IT HAS, read off the envelope field alone.
 *
 * EXPORTED because the intent ledger stores the same three facts on its own
 * rows and must not restate the rule: a second copy that drifted would let one
 * table call a withheld position `pre_seq_connector` while the other called it
 * `allocation_failed`, and those two send a reader to different remedies.
 */
export const seqReasonOf = (
  seq: SeqField | undefined,
  absentReason?: SeqReason,
): SeqReason => {
  if (seq === undefined) {
    return absentReason ?? "pre_seq_connector";
  }
  return isSeqStamp(seq) ? "sequenced" : seq.reason;
};

const reasonFor = (input: RecordSessionEventInput): SeqReason =>
  seqReasonOf(input.seq, input.absentReason);

export interface SessionEventOutcome {
  readonly id: string;
  /** False when the position was already held by a different event. */
  readonly positioned: boolean;
}

/** One event row as it is written: the input's projection at one position, or at none. */
interface EventRow {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: SessionEventKind;
  readonly seqEpoch: string | null;
  readonly seqN: number | null;
  readonly seqAfter: number | null;
  readonly seqKind: SeqKind;
  readonly seqReason: SeqReason;
  readonly refKind: EventRefKind;
  readonly refId: string;
  readonly workContextId: string | null;
  readonly fileRef: string | null;
}

const rowOf = (
  input: RecordSessionEventInput,
  seqEpoch: string | null,
  seqN: number | null,
  seqReason: SeqReason,
  seqAfter: number | null,
): EventRow => ({
  id: sessionEventId({
    sessionId: input.sessionId,
    kind: input.kind,
    seqEpoch,
    seqN,
    refKind: input.refKind,
    refId: input.refId,
  }),
  sessionId: input.sessionId,
  kind: input.kind,
  seqEpoch,
  seqN,
  seqAfter,
  seqKind: input.seqKind,
  seqReason,
  refKind: input.refKind,
  refId: input.refId,
  workContextId: input.workContextId ?? null,
  fileRef: input.fileRef ?? null,
});

/**
 * ONE CONDITIONAL INSERT FOR THE WHOLE RUN (01a §3.3g), in the order given.
 * The vendor is read from the session row in the same statement — exact,
 * since a session has one agent kind, and no caller can pass one that is not
 * it — and NOTHING is written into a session whose skeleton the sweep has
 * retired: a claim or a spool flush that arrives afterwards would rebuild part
 * of a skeleton, and part of a skeleton reads as an order (`usable`) that the
 * whole one may have contradicted. The record itself is still stored by its
 * caller; only this projection is withheld. A check and an insert as two
 * awaited statements would let a sweep fall between them. Two rows of one run
 * that claim one position: the earlier takes it, as one write after another
 * did (`ord`), and the later is told apart below.
 */
const insertRows = async (deps: Deps, rows: readonly EventRow[]): Promise<void> => {
  if (rows.length === 0) {
    return;
  }
  const values = sql.join(
    rows.map(
      (row, ord) =>
        sql`(${ord}::int, ${row.id}::text, ${row.sessionId}::text, ${row.seqEpoch}::text, ${row.seqN}::int,
             ${row.seqAfter}::int, ${row.kind}::text, ${row.seqKind}::text, ${row.seqReason}::text,
             ${row.refKind}::text, ${row.refId}::text, ${row.workContextId}::text, ${row.fileRef}::text)`,
    ),
    sql`, `,
  );
  await deps.db.execute(sql`
    INSERT INTO session_events
      (id, session_id, seq_epoch, seq_n, seq_after, kind, seq_kind, seq_reason,
       ref_kind, ref_id, observed_at, provider, work_context_id, file_ref)
    SELECT v.id, s.id, v.seq_epoch, v.seq_n, v.seq_after, v.kind, v.seq_kind, v.seq_reason,
           v.ref_kind, v.ref_id, ${deps.now()}, s.agent_kind, v.work_context_id, v.file_ref
      FROM (VALUES ${values})
        AS v(ord, id, session_id, seq_epoch, seq_n, seq_after, kind, seq_kind, seq_reason,
             ref_kind, ref_id, work_context_id, file_ref)
      JOIN agent_sessions s ON s.id = v.session_id
     WHERE s.skeleton_retired_at IS NULL
     ORDER BY v.ord
    ON CONFLICT DO NOTHING`);
};

/**
 * ROWS OUTRANK DECLARATIONS (01a §3.6): an upper bound or a withheld position
 * caps a `guaranteed` declaration of its kind — in the same call, so no
 * surface reads the declaration past the row that overruled it, and stored, so
 * a sweep of the row cannot lift the cap. ONCE per (session, kind) a run
 * contradicts, and the lifecycle once per (session, kind, epoch) at the
 * position that decides it: an end is outrun by anything past its LOWEST
 * position, every other row lies past an end below its HIGHEST — the same
 * answer each row's own check gave, since each cap only lowers a declaration.
 */
const capRows = async (deps: Deps, rows: readonly EventRow[]): Promise<void> => {
  const contradicting = rows.filter((row) => contradictsGuaranteed(row.seqKind, row.seqN !== null));
  const capped = new Map(contradicting.map((row) => [`${row.sessionId}\n${row.kind}`, row]));
  for (const row of capped.values()) {
    await capContradictedGuarantee(deps.db, row.sessionId, row.kind);
  }
  const positioned = rows.filter((row) => row.seqEpoch !== null && row.seqN !== null);
  const decisive = new Map<string, EventRow>();
  for (const row of positioned) {
    const key = `${row.sessionId}\n${row.kind}\n${row.seqEpoch ?? ""}`;
    const held = decisive.get(key);
    const isEnd = row.kind === "session.ended";
    const decides = held === undefined || (isEnd ? (row.seqN ?? 0) < (held.seqN ?? 0) : (row.seqN ?? 0) > (held.seqN ?? 0));
    decisive.set(key, decides ? row : held);
  }
  for (const row of decisive.values()) {
    await capLifecycleContradictions(deps.db, row.sessionId, row.kind, {
      epoch: row.seqEpoch ?? "",
      n: row.seqN ?? 0,
    });
  }
};

const positionKey = (sessionId: string, epoch: string, n: number): string => `${sessionId}\n${epoch}\n${String(n)}`;

/**
 * Did each position land, or was it already held? `ON CONFLICT DO NOTHING`
 * swallows BOTH the primary key (an honest replay of this very event) and the
 * partial unique index on the position (a different event claiming a taken
 * slot), so the two are told apart by reading back which id holds it — one
 * read for the run.
 */
const holdersOf = async (deps: Deps, rows: readonly EventRow[]): Promise<ReadonlyMap<string, string>> => {
  if (rows.length === 0) {
    return new Map();
  }
  const positions = sql.join(
    rows.map((row) => sql`(${row.sessionId}::text, ${row.seqEpoch}::text, ${row.seqN}::int)`),
    sql`, `,
  );
  const held = await deps.db.execute(sql`
    SELECT id, session_id, seq_epoch, seq_n FROM session_events
     WHERE (session_id, seq_epoch, seq_n) IN (${positions})`);
  return new Map(
    held.rows.map((row) => [
      positionKey(String(row["session_id"]), String(row["seq_epoch"]), Number(row["seq_n"])),
      String(row["id"]),
    ]),
  );
};

/**
 * Writes a run of canonical events — a flush's targets — in a few statements
 * whatever the run's length, each answered as `recordSessionEvent` answers it
 * alone. Never throws on a conflict and never rejects the caller's records —
 * the caller's own outcome is decided by the rows it stores, not by this
 * projection.
 */
export const recordSessionEvents = async (
  deps: Deps,
  inputs: readonly RecordSessionEventInput[],
): Promise<readonly SessionEventOutcome[]> => {
  const firsts = inputs.map((input) => {
    const stamp = isSeqStamp(input.seq) ? input.seq : null;
    const row =
      stamp === null
        ? rowOf(input, null, null, reasonFor(input), null)
        : rowOf(input, stamp.epoch, stamp.n, reasonFor(input), windowFloorOf(stamp));
    return { input, stamp, row };
  });
  await insertRows(deps, firsts.map((entry) => entry.row));
  await capRows(deps, firsts.map((entry) => entry.row));
  const holders = await holdersOf(deps, firsts.flatMap((entry) => (entry.stamp === null ? [] : [entry.row])));
  // The position belongs to somebody else. Store the record's event with no
  // position rather than dropping it: the row is the only trace that this
  // event happened at all, and a missing row would make the session's history
  // shorter than its work.
  const settled = firsts.map((entry) =>
    entry.stamp === null || holders.get(positionKey(entry.input.sessionId, entry.stamp.epoch, entry.stamp.n)) === entry.row.id
      ? { row: entry.row, positioned: entry.stamp !== null, conflict: null }
      : { row: entry.row, positioned: false, conflict: rowOf(entry.input, null, null, "epoch_conflict", null) },
  );
  const conflicts = settled.flatMap((entry) => (entry.conflict === null ? [] : [entry.conflict]));
  await insertRows(deps, conflicts);
  await capRows(deps, conflicts);
  return settled.map((entry) => ({ id: (entry.conflict ?? entry.row).id, positioned: entry.positioned }));
};

/**
 * Writes one canonical event — a run of one (`recordSessionEvents`).
 */
export const recordSessionEvent = async (
  deps: Deps,
  input: RecordSessionEventInput,
): Promise<SessionEventOutcome> => {
  const [outcome] = await recordSessionEvents(deps, [input]);
  if (outcome === undefined) {
    throw new Error("recordSessionEvents answered no outcome for its one input");
  }
  return outcome;
};

/*
 * RETENTION is not here any more. D2's age sweep (`pruneSessionEvents`) was
 * withdrawn before its first deploy (Nick's D-D) because the rows it deleted
 * are very nearly the causal skeleton; spec 01a replaces it with a sweep
 * generated from a declared retention graph — services/retention.ts, which
 * says what it removes and why nothing else goes.
 */

export interface SessionEventCounts {
  readonly total: number;
  readonly positioned: number;
  readonly epochs: number;
}

/** What `doctor` and the order service both read, in one query. */
export const countSessionEvents = async (
  deps: Deps,
  sessionId: string,
): Promise<SessionEventCounts> => {
  const rows = await deps.db
    .select({
      total: sql<number>`count(*)::int`,
      positioned: sql<number>`count(${sessionEvents.seqN})::int`,
      epochs: sql<number>`count(distinct ${sessionEvents.seqEpoch})::int`,
    })
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, sessionId));
  return rows[0] ?? { total: 0, positioned: 0, epochs: 0 };
};

/**
 * AN EDIT, READ BACK AS SOMETHING THE ORDER GATE CAN BE ASKED ABOUT
 * (spec 06 §3.5, step one of the ladder).
 *
 * The ladder is handed a path and a chain and must decide whether the reason
 * predated the change. That needs the EDIT as an `OrderedEvent`, and nothing
 * in the tree produced one: `session-order.ts`'s readers select `seq_epoch`
 * and `seq_reason` for the SESSION's health, and a target's own identity —
 * the author-written path — never appears on this table at all. The join is
 * `targetDigest`, which lives here because this is the file that decides how
 * a target is addressed.
 *
 * WHY THE PICK IS THE MOST CONSERVATIVE SIGHTING AND NOT THE NEWEST. One file
 * can be sighted more than once: the tool lane reports the edit, the Stop-time
 * git lane sights the same file again, a replayed spool line arrives late.
 * Each sighting is its own row with its own position. The question being asked
 * is about the CHANGE, so:
 *
 *   1. a sighting with NO position outranks every positioned one. It is a
 *      sighting of this same edit that says nothing about when, and answering
 *      from a later positioned row would report an order that sighting does
 *      not support;
 *   2. otherwise the EARLIEST window wins. A file edited at 3 and touched
 *      again at 9 was changed at 3, and an intent at 5 did not precede it.
 *
 * Both rules point the same way, and the direction is the one the asymmetry of
 * this whole system demands: an over-refusal costs certainty, which principle
 * 5 permits, while picking the generous sighting produces `predeclared` — the
 * answer that exonerates, and the one nobody reports when it is wrong.
 */
export interface OrderedEdit {
  readonly event: OrderedEvent;
  readonly kind: string;
  readonly value: string;
}

interface PositionedSighting {
  readonly seqAfter: number | null;
  readonly seqN: number;
}

/**
 * The open end of this sighting's interval; a point is its own window.
 *
 * IT TAKES A POSITIONED ROW ONLY, and that is load-bearing rather than tidy.
 * A version of this defaulting an absent position to 0 makes an unpositioned
 * sighting compare as the earliest one by accident — so rule (1) above would
 * hold for a reason no test could break, and deleting it would change nothing
 * until the day somebody changed the default.
 */
const sightingFloor = (row: PositionedSighting): number =>
  row.seqAfter ?? row.seqN;

const earliestSighting = <T extends PositionedSighting>(
  rows: readonly T[],
): T | undefined =>
  rows.reduce<T | undefined>(
    (earliest, row) =>
      earliest === undefined ||
      sightingFloor(row) < sightingFloor(earliest) ||
      (sightingFloor(row) === sightingFloor(earliest) &&
        row.seqN < earliest.seqN)
        ? row
        : earliest,
    undefined,
  );

export const readEditEvent = async (
  db: DbExecutor,
  workContextId: string,
  kind: string,
  value: string,
): Promise<OrderedEdit | null> => {
  const rows = await db
    .select({
      sessionId: sessionEvents.sessionId,
      seqEpoch: sessionEvents.seqEpoch,
      seqN: sessionEvents.seqN,
      seqAfter: sessionEvents.seqAfter,
      seqKind: sessionEvents.seqKind,
      seqReason: sessionEvents.seqReason,
      observedAt: sessionEvents.observedAt,
    })
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.refKind, "target_digest"),
        eq(sessionEvents.refId, targetDigest(workContextId, kind, value)),
      ),
    );
  if (rows.length === 0) {
    return null;
  }
  const withheld = rows.find((row) => row.seqN === null);
  const chosen =
    withheld ??
    earliestSighting(
      rows.filter(
        (row): row is typeof row & PositionedSighting => row.seqN !== null,
      ),
    );
  if (chosen === undefined) {
    return null;
  }
  return {
    event: {
      sessionId: chosen.sessionId,
      seqEpoch: chosen.seqEpoch,
      seqN: chosen.seqN,
      seqAfter: chosen.seqAfter,
      seqKind: chosen.seqKind,
      seqReason: chosen.seqReason,
      observedAt: chosen.observedAt,
    },
    kind,
    value,
  };
};
