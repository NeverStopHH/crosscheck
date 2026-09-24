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

/**
 * Writes one canonical event. Never throws on a conflict and never rejects the
 * caller's record — the caller's own outcome is decided by the row it stores,
 * not by this projection.
 */
export const recordSessionEvent = async (
  deps: Deps,
  input: RecordSessionEventInput,
): Promise<SessionEventOutcome> => {
  const stamp = isSeqStamp(input.seq) ? input.seq : null;
  const reason = reasonFor(input);
  const write = async (
    seqEpoch: string | null,
    seqN: number | null,
    seqReason: SeqReason,
    seqAfter: number | null = null,
  ): Promise<string> => {
    const id = sessionEventId({
      sessionId: input.sessionId,
      kind: input.kind,
      seqEpoch,
      seqN,
      refKind: input.refKind,
      refId: input.refId,
    });
    // ONE CONDITIONAL INSERT (01a §3.3g). The vendor is read from the session
    // row in the same statement — exact, since a session has one agent kind,
    // and no caller can pass one that is not it — and NOTHING is written into
    // a session whose skeleton the sweep has retired: a claim or a spool
    // flush that arrives afterwards would rebuild part of a skeleton, and
    // part of a skeleton reads as an order (`usable`) that the whole one may
    // have contradicted. The record itself is still stored by its caller;
    // only this projection is withheld. A check and an insert as two awaited
    // statements would let a sweep fall between them.
    await deps.db.execute(sql`
      INSERT INTO session_events
        (id, session_id, seq_epoch, seq_n, seq_after, kind, seq_kind, seq_reason,
         ref_kind, ref_id, observed_at, provider, work_context_id, file_ref)
      SELECT ${id}, s.id, ${seqEpoch}, ${seqN}, ${seqAfter}, ${input.kind}, ${input.seqKind},
             ${seqReason}, ${input.refKind}, ${input.refId}, ${deps.now()}, s.agent_kind,
             ${input.workContextId ?? null}, ${input.fileRef ?? null}
        FROM agent_sessions s
       WHERE s.id = ${input.sessionId} AND s.skeleton_retired_at IS NULL
      ON CONFLICT DO NOTHING`);
    return id;
  };
  if (stamp === null) {
    return { id: await write(null, null, reason), positioned: false };
  }
  const id = await write(stamp.epoch, stamp.n, reason, windowFloorOf(stamp));
  // Did the position land, or was it already held? `onConflictDoNothing`
  // swallows BOTH the primary key (an honest replay of this very event) and
  // the partial unique index on the position (a different event claiming a
  // taken slot), so the two are told apart by reading back which id holds it.
  const holder = await deps.db
    .select({ id: sessionEvents.id })
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.sessionId, input.sessionId),
        eq(sessionEvents.seqEpoch, stamp.epoch),
        eq(sessionEvents.seqN, stamp.n),
      ),
    )
    .limit(1);
  if (holder[0]?.id === id) {
    return { id, positioned: true };
  }
  // The position belongs to somebody else. Store the record's event with no
  // position rather than dropping it: the row is the only trace that this
  // event happened at all, and a missing row would make the session's history
  // shorter than its work.
  return {
    id: await write(null, null, "epoch_conflict"),
    positioned: false,
  };
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
