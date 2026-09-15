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
import { and, eq, lt, sql } from "drizzle-orm";
import { isSeqStamp } from "@crosscheck/schema";
import type {
  EventRefKind,
  SeqField,
  SeqKind,
  SeqReason,
  SessionEventKind,
} from "@crosscheck/schema";

import { SESSION_EVENT_RETENTION_DAYS } from "../constants.ts";
import { sessionEvents } from "../db/schema.ts";
import type { DbExecutor } from "../db/client.ts";
import type { Clock } from "../types.ts";

interface Deps {
  readonly db: DbExecutor;
  readonly now: Clock;
}

/** 128 bits of SHA-256 — deterministic AND short, the hint-delivery shape. */
const SESSION_EVENT_ID_HASH_CHARS = 32;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
}

/**
 * ABSENT AND REFUSED ARE DIFFERENT FACTS, and confounding them would make
 * every `doctor` line about instrumentation coverage a guess: absent is a
 * connector from before this protocol field, refused is a seq-capable emitter
 * that tried and could not.
 */
const reasonFor = (input: RecordSessionEventInput): SeqReason => {
  if (input.seq === undefined) {
    return input.absentReason ?? "pre_seq_connector";
  }
  return isSeqStamp(input.seq) ? "sequenced" : input.seq.reason;
};

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
  ): Promise<string> => {
    const id = sessionEventId({
      sessionId: input.sessionId,
      kind: input.kind,
      seqEpoch,
      seqN,
      refKind: input.refKind,
      refId: input.refId,
    });
    await deps.db
      .insert(sessionEvents)
      .values({
        id,
        sessionId: input.sessionId,
        seqEpoch,
        seqN,
        kind: input.kind,
        seqKind: input.seqKind,
        seqReason,
        refKind: input.refKind,
        refId: input.refId,
        observedAt: deps.now(),
      })
      .onConflictDoNothing();
    return id;
  };
  if (stamp === null) {
    return { id: await write(null, null, reason), positioned: false };
  }
  const id = await write(stamp.epoch, stamp.n, reason);
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

/**
 * RETENTION, in the transaction that writes rather than in a job nobody runs.
 * The hub has exactly one standalone sweep (the session reaper) and adding a
 * second for this would be a second thing to forget to start;
 * `ingestCommitEvidence` already prunes in-band for the same reason.
 *
 * SCOPED TO ONE SESSION, because a session holds roughly five hundred rows
 * (MAX_SEEN_TARGETS bounds its targets) and an unscoped delete on every write
 * would scan the table for every event on the hub.
 *
 * WHAT THIRTY DAYS COSTS, chosen rather than discovered: a claim older than
 * thirty days keeps its body and loses its position, so a verdict on old work
 * can still say WHAT was claimed and no longer WHETHER the reason predated the
 * change.
 */
export const pruneSessionEvents = async (
  deps: Deps,
  sessionId: string,
): Promise<void> => {
  const cutoff = new Date(
    deps.now().getTime() - SESSION_EVENT_RETENTION_DAYS * MS_PER_DAY,
  );
  await deps.db
    .delete(sessionEvents)
    .where(
      and(
        eq(sessionEvents.sessionId, sessionId),
        lt(sessionEvents.observedAt, cutoff),
      ),
    );
};

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
