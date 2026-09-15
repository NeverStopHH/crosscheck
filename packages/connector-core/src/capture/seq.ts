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
 * MCP call whose session is ambiguous — the record still travels and carries
 * `allocation_failed`. An OMITTED field would say "a connector from before
 * this protocol", which is a different fact about a different machine.
 */
import type { Envelope, SeqField } from "@crosscheck/schema";

import type { SeqRange } from "../state/session-state.ts";

export const ALLOCATION_FAILED: SeqField = { reason: "allocation_failed" };

/**
 * The stamp for the offset-th record of a block, or the refusal when there is
 * no block — or when the caller has emitted more records than it reserved,
 * which is a bug in the caller and must not silently reuse a position.
 */
export const seqAt = (
  range: SeqRange | null | undefined,
  offset: number,
): SeqField =>
  range === null || range === undefined || offset >= range.count
    ? ALLOCATION_FAILED
    : { epoch: range.epoch, n: range.from + offset };

/** Immutable, like every record transform: a new envelope, never a mutation. */
export const withSeq = (envelope: Envelope, seq: SeqField): Envelope => ({
  ...envelope,
  seq,
});
