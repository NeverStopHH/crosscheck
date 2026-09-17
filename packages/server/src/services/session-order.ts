/**
 * WHAT A CONSUMER MUST ASK BEFORE COMPARING TWO POSITIONS (spec 01 §3.7) —
 * the reading half of the causal order. `session-events.ts` is the writing
 * half.
 *
 * THE PRINCIPLE THIS SERVES, verbatim: "A reason written after a change is not
 * evidence that the reason existed before the change." Answering that needs a
 * HAPPENS-BEFORE relation, and a happens-before relation is not a timestamp
 * comparison: two processes, two machines, a subagent, an offline connector
 * and a batch sync all break a wall clock, and none of them breaks a counter
 * handed out under one lock. Nothing in this file reads `observed_at` or an
 * envelope `ts`, and a mutation anchor exists precisely to keep it that way.
 *
 * IT GATES ONE DIMENSION, NOT A VERDICT. An unusable order makes
 * `explanation_timing` uncomputable and nothing else. It must NOT reach
 * attribution, which is computed from a file-touch intersection, a falsifier
 * and a coverage record and reads no position at all — coupling them would
 * turn a statement about INSTRUMENTATION into a verdict about a person's work,
 * and would silence attribution for every connector from before this field.
 *
 * REASONS ARE AN ENUM, NEVER PROSE. A reason is printed to a human beside a
 * state, so it may not be a slot anything upstream can write into. This
 * mirrors the coverage spec's discipline deliberately, and `isOrderable`
 * mirrors its `isJudgeable` the same way: both gate one dimension.
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { SeqKind, SeqReason } from "@crosscheck/schema";

import { OPEN_SESSIONS_MAX } from "../constants.ts";
import { agentSessions, sessionEvents } from "../db/schema.ts";
import type { DbExecutor } from "../db/client.ts";

export const CAUSAL_ORDER_STATES = ["usable", "broken", "unsequenced"] as const;

export type CausalOrderState = (typeof CAUSAL_ORDER_STATES)[number];

export const CAUSAL_ORDER_REASONS = [
  "sequenced",
  "epoch_conflict",
  "epoch_split",
  "pre_seq_connector",
  "allocation_failed",
  "ambiguous_session_assignment",
  "foreign_session_delivery",
  "reaped_end",
] as const;

export type CausalOrderReason = (typeof CAUSAL_ORDER_REASONS)[number];

export interface SessionCausalOrder {
  readonly sessionId: string;
  readonly state: CausalOrderState;
  readonly reason: CausalOrderReason;
  /** Distinct non-null epochs seen. More than one is a split, never an order. */
  readonly epochs: number;
}

/**
 * The shape a consumer compares. `observedAt` is carried DELIBERATELY even
 * though nothing here reads it: it is the second wall clock sitting beside the
 * positions, and a regression that starts ordering by it must have something
 * to be caught reaching for.
 */
export interface OrderedEvent {
  readonly sessionId: string;
  readonly seqEpoch: string | null;
  readonly seqN: number | null;
  /**
   * The open end of the interval this event happened in, or null when the
   * emitter sent no bracket. `seq_n` is always the CLOSED end.
   */
  readonly seqAfter: number | null;
  readonly seqKind: SeqKind;
  /**
   * WHY THIS EVENT HAS THE POSITION IT HAS — `sequenced`, or the named refusal
   * that withheld one. It travels ON the event rather than in a second lookup,
   * because a caller holding an unpositioned event must be able to say WHICH
   * absence it is without going back to the database to find out.
   */
  readonly seqReason: SeqReason;
  readonly observedAt: Date;
}

/**
 * THE STATE OF A POSITION, and there are two of them because "we do not know
 * the order" and "there was no order" are different sentences.
 *
 *   known         — the event carries a position, and it is that number.
 *   indeterminate — the event carries no position and the row says why. The
 *                   emitter tried and could not, or deliberately did not.
 *
 * There is deliberately no third value for "absent". An event EXISTS; what is
 * missing is its place in the sequence, never the event. A consumer that
 * collapses this into a plain absence produces the one outcome this design
 * exists to prevent — an explanation whose position was withheld because two
 * agents share a worktree read as an explanation that was never written.
 */
export const CAUSAL_POSITION_STATUSES = ["known", "indeterminate"] as const;

export type CausalPositionStatus = (typeof CAUSAL_POSITION_STATUSES)[number];

/**
 * ONE ATOMIC ANSWER. The status and its reason are always both present, so a
 * renderer cannot print the bare state — the binding rule §3.7 states for the
 * timing value and 04 states for attribution, made structural here rather than
 * left to every call site to remember.
 */
export interface CausalPosition {
  readonly seq: number | null;
  readonly status: CausalPositionStatus;
  readonly reason: SeqReason;
}

/**
 * WHERE AN EVENT'S INTERVAL BEGINS. A point emitter — an MCP publish, a
 * session register — sends no bracket and IS its position, so the interval is
 * `[n, n]`. A bracketing emitter took a position before it started the work
 * and the interval is `(after, n]`. Nothing here reads a clock.
 */
const windowStart = (event: OrderedEvent): number =>
  event.seqAfter ?? event.seqN ?? 0;

/**
 * WHICH ABSENCE TO REPORT when a session has positions for nothing.
 *
 * Ordered by how much they tell a reader to DO, and the first two are not one
 * reason: `ambiguous_session_assignment` means two live sessions share one
 * worktree and the MCP picker cannot tell them apart, which needs a PERSON to
 * close one and will not clear otherwise — so it outranks `allocation_failed`,
 * which means this machine tried and could not (a busy lock, a deleted state
 * file) and clears on its own. `reaped_end` is the hub's own inference from
 * silence and `foreign_session_delivery` is a backlog a successor session
 * drained; both are nobody's bug and neither has a remedy, so they sit below
 * the two that do. `pre_seq_connector` is the baseline: an envelope that
 * carried no position at all, from a connector too old to have the field.
 */
const ABSENCE_PRIORITY: readonly CausalOrderReason[] = [
  "ambiguous_session_assignment",
  "allocation_failed",
  "reaped_end",
  "foreign_session_delivery",
  "pre_seq_connector",
];

interface PositionRow {
  readonly seqEpoch: string | null;
  readonly seqReason: string;
}

/** Pure, so the decision can be tested without a database in front of it. */
export const causalOrderOf = (
  sessionId: string,
  rows: readonly PositionRow[],
): SessionCausalOrder => {
  if (rows.length === 0) {
    return {
      sessionId,
      state: "unsequenced",
      reason: "pre_seq_connector",
      epochs: 0,
    };
  }
  const epochs = new Set(
    rows
      .map((row) => row.seqEpoch)
      .filter((epoch): epoch is string => epoch !== null),
  );
  // A CONFLICT IS CHECKED BEFORE A SPLIT, because a conflicted row's position
  // was nulled when it was stored — it adds nothing to the epoch count and
  // would otherwise be invisible here. Two events that both claimed one
  // position mean the counter behind them cannot be trusted at all.
  if (rows.some((row) => row.seqReason === "epoch_conflict")) {
    return {
      sessionId,
      state: "broken",
      reason: "epoch_conflict",
      epochs: epochs.size,
    };
  }
  if (epochs.size > 1) {
    return {
      sessionId,
      state: "broken",
      reason: "epoch_split",
      epochs: epochs.size,
    };
  }
  if (epochs.size === 0) {
    const reasons = new Set(rows.map((row) => row.seqReason));
    const reason =
      ABSENCE_PRIORITY.find((candidate) => reasons.has(candidate)) ??
      "pre_seq_connector";
    return { sessionId, state: "unsequenced", reason, epochs: 0 };
  }
  // SOME rows may still carry no position — a busy lock mid-session, a
  // pre-seq record replayed late. The session's order is usable for the events
  // that HAVE positions, and `isOrderable` refuses the individual ones that do
  // not. Downgrading the whole session for one hole would silence an order
  // that is perfectly good everywhere else.
  return { sessionId, state: "usable", reason: "sequenced", epochs: 1 };
};

export const readSessionCausalOrder = async (
  db: DbExecutor,
  sessionId: string,
): Promise<SessionCausalOrder> => {
  const rows = await db
    .select({
      seqEpoch: sessionEvents.seqEpoch,
      seqReason: sessionEvents.seqReason,
    })
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, sessionId));
  return causalOrderOf(sessionId, rows);
};

/**
 * THE SESSIONS WHOSE ORDER IS BROKEN, for the caller's own live work.
 *
 * WHY IT IS READ BACK AT ALL. `epoch_conflict` and `epoch_split` are the two
 * failures a connector structurally cannot see: both are facts about rows the
 * hub holds, and the local state file that doctor's `event sequence` line
 * reads knows nothing about either. A session in either state keeps working
 * perfectly — the claims land, the intents land — and only *whether the reason
 * predated the change* stops being answerable, for the WHOLE session. Without
 * this read that machine looks healthy on the one surface that describes it.
 *
 * ONE STATEMENT, AND IT CANNOT TRUNCATE AN ANSWER. The rows are the DISTINCT
 * (session, epoch, reason) triples, which is a handful per session however
 * many events it holds, and the bound is on the number of SESSIONS rather than
 * on the triples: a limit that cut a session's second epoch off would report
 * a split session as healthy, which is the one answer this must never give.
 *
 * NOT A POLL AND NOT A JOB. It runs when a human types `crosscheck doctor`.
 */
export const readBrokenCausalOrders = async (
  db: DbExecutor,
  developerId: string,
): Promise<readonly SessionCausalOrder[]> => {
  const mine = db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.developerId, developerId),
        isNull(agentSessions.endedAt),
      ),
    )
    .orderBy(desc(agentSessions.lastHeartbeatAt))
    .limit(OPEN_SESSIONS_MAX);
  const rows = await db
    .select({
      sessionId: sessionEvents.sessionId,
      seqEpoch: sessionEvents.seqEpoch,
      seqReason: sessionEvents.seqReason,
    })
    .from(sessionEvents)
    .where(inArray(sessionEvents.sessionId, mine))
    .groupBy(
      sessionEvents.sessionId,
      sessionEvents.seqEpoch,
      sessionEvents.seqReason,
    );
  const perSession = new Map<string, PositionRow[]>();
  for (const row of rows) {
    perSession.set(row.sessionId, [
      ...(perSession.get(row.sessionId) ?? []),
      { seqEpoch: row.seqEpoch, seqReason: row.seqReason },
    ]);
  }
  // `causalOrderOf` is the ONE place the decision lives, and distinct triples
  // give it the identical answer: it reads the SET of epochs and whether any
  // row carries a conflict, and duplicates change neither.
  return [...perSession.entries()]
    .map(([sessionId, session]) => causalOrderOf(sessionId, session))
    .filter((order) => order.state === "broken");
};

/**
 * WHERE THIS EVENT SITS, or the explicit statement that we do not know.
 *
 * D1's refinement: the withheld state is a VALUE, not a missing field. A
 * consumer asking "where is this event in the session's order" gets a number
 * with `known`, or `null` with `indeterminate` and the reason that withheld it
 * — never a bare null it has to interpret, and never an answer that reads like
 * the event did not happen.
 *
 * It reads no clock, like everything else in this file. `observedAt` sits on
 * the event it is handed and is not touched.
 */
export const causalPositionOf = (event: OrderedEvent): CausalPosition =>
  event.seqN === null || event.seqEpoch === null
    ? { seq: null, status: "indeterminate", reason: event.seqReason }
    : { seq: event.seqN, status: "known", reason: event.seqReason };

/**
 * MAY THESE TWO BE COMPARED AT ALL — the question every consumer asks first,
 * and the only place the answer is computed.
 *
 * Six conditions, and every one of them is a way the answer would otherwise
 * be a guess:
 *
 *   1. the session's order is usable — no conflict, no split;
 *   2. both events belong to THAT session. There is no cross-session order:
 *      two sessions, two machines, a session and a CI run are not comparable
 *      by construction, and there is no "best effort";
 *   3. both carry a position at all;
 *   4. both carry the SAME epoch. A bare integer compared across epochs
 *      answers confidently from two different counters;
 *   5. both positions are EMITTED. An `observed` position is an upper bound —
 *      it proves the fact was recorded no later than that point, never that it
 *      happened after the previous event — so a happens-before question
 *      against one is refused. The refusal is deliberately symmetric, and it
 *      has to be: the asymmetric rule (an observed A before an emitted B is
 *      sound in one direction) holds only where `observed` really is an upper
 *      bound, and one lane's is not. The ACP engine positions an edit on the
 *      wire row that ANNOUNCES it, before the edit exists (connector-acp
 *      capabilities.ts, test/announce-position.test.ts), so an observed ACP
 *      edit can sit below an intent written before it happened.
 *   6. their windows DO NOT OVERLAP. A position taken after the work it
 *      records — every hook lane — is the closed end of a window, and two
 *      events whose windows overlap are concurrent. Concurrent is not an
 *      order, and answering one anyway is how the lane that exonerates
 *      answers `predeclared` for a change that came first.
 */
export const isOrderable = (
  order: SessionCausalOrder,
  a: OrderedEvent,
  b: OrderedEvent,
): boolean => causalComparisonOf(order, a, b).outcome === "comparable";

/**
 * WHY TWO EVENTS CANNOT BE COMPARED — one name per condition above, because a
 * refusal reported under another defect's reason sends its reader to the wrong
 * remedy.
 *
 *   session_order_unusable — the session's own order cannot be used, and the
 *                            two ways that happens are BOTH covered by this
 *                            one name because both are facts about the
 *                            SESSION rather than about either event: its
 *                            counter broke (two emitters took one position,
 *                            or it holds two epochs), or it never had one at
 *                            all. `SessionCausalOrder.reason` is what tells
 *                            those apart, and it travels beside this.
 *   different_session      — there is no cross-session order, by construction.
 *   position_indeterminate — one of the two carries no position. WHICH absence
 *                            it is lives on the event, via `causalPositionOf`.
 *   epoch_mismatch         — two positions from two different counters. A bare
 *                            integer compared across epochs answers
 *                            confidently from unrelated numbers.
 *   upper_bound_only       — an `observed` position proves the fact was
 *                            recorded no later than that point, never that it
 *                            happened after the previous event.
 *   concurrent             — the two windows overlap. Concurrent is not an
 *                            order, and answering anyway is how the lane that
 *                            exonerates answers for a change that came first.
 *
 * NONE OF THESE IS A STATEMENT ABOUT WHETHER AN EXPLANATION EXISTS, and that
 * is the point. "We cannot tell when it was written" excuses a developer;
 * "nothing was ever written" accuses one. This gate is only ever asked about
 * two events that EXIST, so it is given no vocabulary for absence and a caller
 * cannot obtain the accusing word from here. The judgment a human reads — and
 * the choice of word for it — belongs to the intent ledger's own function,
 * which is the only place that knows whether there was an explanation at all.
 */
export const CAUSAL_INDETERMINACIES = [
  "session_order_unusable",
  "different_session",
  "position_indeterminate",
  "epoch_mismatch",
  "upper_bound_only",
  "concurrent",
] as const;

export type CausalIndeterminacy = (typeof CAUSAL_INDETERMINACIES)[number];

export type CausalComparison =
  | { readonly outcome: "comparable" }
  | {
      readonly outcome: "indeterminate";
      readonly reason: CausalIndeterminacy;
    };

const COMPARABLE: CausalComparison = { outcome: "comparable" };

const indeterminate = (reason: CausalIndeterminacy): CausalComparison => ({
  outcome: "indeterminate",
  reason,
});

/**
 * THE GATE, and the only place the six conditions are evaluated. `isOrderable`
 * is this function with its reason thrown away, so the cheap question and the
 * informative one can never give different answers.
 *
 * Checked in the order a reader would want to hear them: the session's own
 * health first, because nothing inside a broken session is worth reporting in
 * detail, then the pair, then the two positions, then what the positions mean.
 */
export const causalComparisonOf = (
  order: SessionCausalOrder,
  a: OrderedEvent,
  b: OrderedEvent,
): CausalComparison => {
  if (order.state !== "usable") {
    return indeterminate("session_order_unusable");
  }
  if (a.sessionId !== order.sessionId || b.sessionId !== order.sessionId) {
    return indeterminate("different_session");
  }
  if (
    causalPositionOf(a).status !== "known" ||
    causalPositionOf(b).status !== "known"
  ) {
    return indeterminate("position_indeterminate");
  }
  if (a.seqEpoch !== b.seqEpoch) {
    return indeterminate("epoch_mismatch");
  }
  if (a.seqKind !== "emitted" || b.seqKind !== "emitted") {
    return indeterminate("upper_bound_only");
  }
  if (overlaps(a, b)) {
    return indeterminate("concurrent");
  }
  return COMPARABLE;
};

/**
 * DO THE TWO INTERVALS TOUCH — the sixth condition, and the one a position
 * taken AFTER the work it records makes necessary.
 *
 * A hook allocates once its tool has returned, so its position is the closed
 * end of a window the edit happened somewhere inside. An emitter that
 * allocated inside that window took a LOWER number than work that already
 * happened, and comparing the two numbers reports the explanation as
 * predeclared — the exonerating answer — from what is really a coin flip.
 * Measured: an Edit and an MCP publish issued in one parallel tool batch
 * inverted 10 times out of 10.
 *
 * Two events whose windows overlap are CONCURRENT, and concurrent is not an
 * order. A point is its own window, so two point emitters overlap only at the
 * same position — which the unique index reserves for one event — and this
 * condition costs the point-to-point case nothing.
 */
const overlaps = (a: OrderedEvent, b: OrderedEvent): boolean =>
  !((a.seqN ?? 0) < windowStart(b) || (b.seqN ?? 0) < windowStart(a)) &&
  !(a.seqN === b.seqN && windowStart(a) === windowStart(b));

/**
 * HAPPENS-BEFORE, and nothing else (§3.4): `A → B` iff A and B share a session,
 * share a non-null epoch, and `A.seq_n < B.seq_n`.
 *
 * `null` means NOT COMPARABLE and is a first-class answer — never 0, never a
 * fallback to arrival order. The caller names the outcome in its own
 * vocabulary (the intent ledger's `explanationTimingFor` is the first); this
 * returns the relation.
 *
 * GAPS IN `n` ARE LEGAL and are never evidence of loss: an allocation whose
 * emitter then crashed leaves a hole by design. Loss lives in the connector's
 * spool drop ledger, not in a missing integer here.
 */
export const compareEvents = (
  order: SessionCausalOrder,
  a: OrderedEvent,
  b: OrderedEvent,
): -1 | 0 | 1 | null => {
  if (!isOrderable(order, a, b)) {
    return null;
  }
  // Same position, same window: the event compared with itself. Distinct
  // events cannot share a position — the partial unique index reserves it —
  // and overlapping windows never reach here at all, because `isOrderable`
  // has already refused them.
  if (a.seqN === b.seqN && windowStart(a) === windowStart(b)) {
    return 0;
  }
  return (a.seqN ?? 0) < windowStart(b) ? -1 : 1;
};
