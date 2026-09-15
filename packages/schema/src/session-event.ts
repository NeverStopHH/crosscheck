/**
 * THE CANONICAL EVENT VOCABULARY (spec 01 §3.2) — the dotted names every
 * provider speaks, in the one package all of them already depend on.
 *
 * These are a PROJECTION, not nine new record kinds: `file.modified` is a
 * `target` row that already travels, `claim.created` is a `claim`. A parallel
 * set of event envelopes would double every record on the wire and build the
 * second pipeline this design exists to avoid.
 *
 * SEVEN NAMES HERE, NOT NINE. `intent.declared` and `intent.amended` project
 * into the intent ledger's own versioned rows, where the amendment has a row
 * of its own to carry a position — `work_contexts.intent` is overwritten in
 * place, so an amendment projected from it would share a referent with the
 * declaration it replaced. Until that ledger lands the two kinds are NOT
 * PROJECTED AT ALL rather than projected wrongly, and doctor says so.
 */

export const SESSION_EVENT_KINDS = [
  "session.started",
  "tool.failed",
  "file.modified",
  "claim.created",
  "claim.invalidated",
  "commit.observed",
  "session.ended",
] as const;

export type SessionEventKind = (typeof SESSION_EVENT_KINDS)[number];

/**
 * The two intent kinds, named here so a reader arriving from the vocabulary
 * can see that they exist and where they go. Nothing projects them yet.
 */
export const LEDGER_EVENT_KINDS = ["intent.declared", "intent.amended"] as const;

/**
 * WHAT A POSITION PROVES, and it is not the same for both (§3.2, §3.6).
 *
 *   emitted  — the position was taken AT the thing it records: an Edit the
 *              host reported, a claim an agent published, a session register.
 *              `A.n < B.n` is happens-before.
 *   observed — the position was taken when the fact was WRITTEN DOWN, which is
 *              later than the fact: the Stop-time `git diff` lane sees an edit
 *              made at some unknown earlier point in the turn, and a detached
 *              worker summarises a slice from earlier in the session. An
 *              observed position is an UPPER BOUND only — it proves the fact
 *              happened no later than that point, never that it happened after
 *              the previous event — so a happens-before question against one
 *              is refused rather than answered confidently and wrongly.
 */
export const SEQ_KINDS = ["emitted", "observed"] as const;

export type SeqKind = (typeof SEQ_KINDS)[number];

/**
 * WHAT AN EVENT POINTS AT. Four values, and the two that were dropped were
 * undeliverable rather than unwanted: `ref_id` is a single text column, so it
 * can only name a row with a single-column identity.
 *
 *   target_digest — `work_context_targets` has no id column and its identity
 *                   CONTAINS THE FILE PATH, which is author-written. The
 *                   referent is a hash of it instead: content-free by
 *                   construction, joinable by recomputing the same hash, and
 *                   carrying nothing a renderer could print.
 *   session       — `commit.observed` refs the session whose SessionStart ran
 *                   the collection. `commit_evidence`'s own key is
 *                   (repo, author_email), and author_email never leaves the
 *                   hub; a hash of it would be a content-derived pseudonymous
 *                   identifier of a PERSON, which data minimisation forbids.
 */
export const EVENT_REF_KINDS = [
  "claim",
  "claim_edge",
  "session",
  "target_digest",
] as const;

export type EventRefKind = (typeof EVENT_REF_KINDS)[number];

/**
 * WHY A ROW HAS NO POSITION — per row, so the count that doctor prints is
 * derived from the rows themselves rather than from a second ledger nobody
 * keeps in step.
 *
 *   sequenced         — it has one.
 *   pre_seq_connector — the envelope carried no `seq` at all: a connector from
 *                       before the field, or a record whose position could not
 *                       survive delivery by a foreign session.
 *   allocation_failed — a seq-capable emitter tried and could not: no state
 *                       file, a state file from before the field, a lock that
 *                       stayed busy, or an ambiguous MCP session whose picker's
 *                       guess must not be stamped.
 *   epoch_conflict    — the position was already taken in this session by a
 *                       DIFFERENT event. The record is kept and the position
 *                       is dropped: rejecting would destroy the record, because
 *                       a connector's flush advances its cursor on any 2xx.
 *   reaped_end        — the hub closed this session on a guess from silence.
 *                       It cannot invent a position in a sequence it did not
 *                       emit, and a reap is revocable besides.
 */
export const SEQ_REASONS = [
  "sequenced",
  "pre_seq_connector",
  "allocation_failed",
  "epoch_conflict",
  "reaped_end",
] as const;

export type SeqReason = (typeof SEQ_REASONS)[number];
