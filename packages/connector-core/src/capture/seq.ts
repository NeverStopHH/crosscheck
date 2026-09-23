/**
 * PUTTING A POSITION ON A RECORD (spec 01 §3.1, §3.6).
 *
 * `allocateSeq` hands out a BLOCK under the state file's lock; this is what
 * turns that block into the per-envelope stamps. One block per capture
 * invocation, taken once and BEFORE the records are built, because a hook's
 * records are serialized and spooled before its single locked state write —
 * there is no "fold it into the write that already runs".
 *
 * GAPS ARE LEGAL AND DELIBERATE (§3.4). A hook pre-allocates its WORST CASE
 * (every path it may capture, plus one for a failure fingerprint) and usually
 * emits fewer, so the unused positions are simply never used. That is the same
 * hole an emitter that crashed between its allocation and its append leaves,
 * and it is never evidence of loss — loss is the spool's `.drops` ledger.
 *
 * A REFUSAL IS A VALUE, NOT AN OMISSION. When there is no block — no state
 * file, a state file from before this field, a lock that stayed busy, or an
 * MCP call whose session is ambiguous — the record still travels and carries a
 * refusal. An OMITTED field would say "a connector from before this protocol",
 * which is a different fact about a different machine.
 *
 * AND THE REFUSAL SAYS WHICH ONE. A busy lock clears on its own and its remedy
 * is to do nothing; an ambiguous MCP session does not clear until one of the
 * two sessions ends and its remedy is a person. One word for both would send
 * the reader of a permanently ambiguous worktree to wait for a lock that was
 * never contended, so an allocator that already KNOWS which it is hands the
 * refusal back rather than a null this file would have to guess a word for.
 */
import type { Envelope, SeqField, SeqRefusal } from "@crosscheck/schema";

/** Re-exported so a connector that does not depend on the schema package
 *  directly can still name the field it is passing through. */
export type { SeqField };

import type { SeqRange } from "../state/session-state.ts";

export const ALLOCATION_FAILED: SeqRefusal = { reason: "allocation_failed" };

/**
 * D1's refusal, and the reason it is not the one above: the picker could not
 * tell which of two live sessions in one worktree is calling, so no lock was
 * taken at all. Stamping the guess would file an amendment into another
 * session's causal order and let AT-4 answer confidently from a coin flip.
 */
export const AMBIGUOUS_SESSION: SeqRefusal = {
  reason: "ambiguous_session_assignment",
};

/**
 * A position that existed and could not survive DELIVERY. A flush rewrites a
 * dead session's backlog into the flushing session's name, and a position
 * belongs to one session's counter — so for a body that does not name its own
 * session the position has nowhere to be filed. Deleting the field said
 * "a connector from before this protocol" about a current connector; this says
 * what actually happened.
 */
export const FOREIGN_SESSION_DELIVERY: SeqRefusal = {
  reason: "foreign_session_delivery",
};

/**
 * What an allocator hands back: a block, a refusal it already knows the name
 * of, or nothing at all. A `null` still means `allocation_failed` — that is
 * every allocator that failed at the LOCK, which is the only thing it could
 * have failed at.
 */
export type SeqAllocation = SeqRange | SeqRefusal | null | undefined;

/**
 * The stamp for the offset-th record of a block, or the refusal when there is
 * no block — or when the caller has emitted more records than it reserved,
 * which is a bug in the caller and must not silently reuse a position.
 *
 * A refusal passes straight THROUGH: an allocator that refused for a named
 * reason has said something this function could not have worked out, and
 * flattening it to `allocation_failed` here would throw that sentence away at
 * the last step before the wire.
 */
export const seqAt = (
  range: SeqAllocation,
  offset: number,
): SeqField => {
  if (range === null || range === undefined) {
    return ALLOCATION_FAILED;
  }
  if ("reason" in range) {
    return range;
  }
  if (offset >= range.count) {
    return ALLOCATION_FAILED;
  }
  const stamp = { epoch: range.epoch, n: range.from + offset };
  // THE BRACKET RIDES THE BLOCK. A hook's position is taken after its tool
  // returned, so on its own it is an upper bound on an edit that already
  // happened; `after` is the position the same hook pair took BEFORE the tool
  // started, and it is what lets a happens-before question be asked of this
  // lane at all. Absent stays absent — the hub reads that as the upper bound
  // it is, never as a point.
  return range.after === undefined ? stamp : { ...stamp, after: range.after };
};

/** Immutable, like every record transform: a new envelope, never a mutation. */
export const withSeq = (envelope: Envelope, seq: SeqField): Envelope => ({
  ...envelope,
  seq,
});
