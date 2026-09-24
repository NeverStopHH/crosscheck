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
 *              made at some unknown earlier point in the turn, a detached
 *              worker summarises a slice from earlier in the session, and
 *              SessionStart's commit collection aggregates commits authored up
 *              to COMMIT_EVIDENCE_WINDOW_DAYS before the session existed. An
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
 *                       before this protocol field, and nothing else. It used
 *                       to mean a second thing — a record whose position could
 *                       not survive delivery by a foreign session — and that
 *                       second meaning was a CONFOUND: it said "too old for
 *                       the field" about a current connector that had withheld
 *                       a position on purpose. That case has its own reason
 *                       below, and this one is a statement about the emitter's
 *                       VERSION again.
 *   allocation_failed — a seq-capable emitter tried and could not: no state
 *                       file, a state file from before the field, or a lock
 *                       that stayed busy. Every one of those clears on its own.
 *   ambiguous_session_assignment
 *                     — the MCP picker could not tell which of two live
 *                       sessions in one worktree is calling, so no lock was
 *                       taken and the picker's guess was not stamped. It does
 *                       NOT clear on its own: it lasts until one of the two
 *                       sessions ends, which is why it is not the word above.
 *   foreign_session_delivery
 *                     — the emitter had a position and the flush that
 *                       delivered the record moved it into another session's
 *                       name, where the position could not be filed. Withheld
 *                       by design; nobody's bug and no remedy.
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
  "ambiguous_session_assignment",
  "foreign_session_delivery",
  "epoch_conflict",
  "reaped_end",
] as const;

export type SeqReason = (typeof SEQ_REASONS)[number];

/**
 * HOW A HUB RETIRES `session_events` ROWS — declared BY THE HUB, on the route
 * `doctor` already reads for the causal order, and printed as a sentence the
 * connector owns. The hub states it rather than a connector assuming it
 * because one hub serves connectors of several versions: a sentence compiled
 * into a CLI would describe whichever hub that CLI was built beside.
 *
 *   off — nothing is retired, and the table grows without bound ON PURPOSE.
 *         The age-based sweep D2 shipped deletes very nearly the causal
 *         skeleton itself (every column here is a ref or an enum), so it was
 *         withdrawn before its first deploy — Nick's D-D, 2026-09-17 — rather
 *         than trusting a later spec to arrive inside its thirty days.
 *
 *   interim — spec 01a's referential sweep, with Nick's interim rule on top:
 *         a session is retired whole only when it ENDED EXPLICITLY more than
 *         the window ago, no declared root reaches it, nothing it touched is
 *         unresolved — and it touched no file at all, until the file identity
 *         has held against real pins and real touches.
 *   full  — the same sweep without the last condition.
 *
 * A connector that does not know a declared mode says so rather than
 * guessing at its meaning.
 */
export const SESSION_EVENT_RETENTION_MODES = ["off", "interim", "full"] as const;

export type SessionEventRetentionMode =
  (typeof SESSION_EVENT_RETENTION_MODES)[number];

/**
 * THE RETENTION ROOTS 01a DECLARES (§3.3b) — the relations whose rows keep a
 * session's skeleton while they are live. A name on the wire, so `doctor` can
 * say which root keeps how many sessions; the relation behind each name is
 * the hub's (server services/retention-registry.ts).
 */
export const RETENTION_ROOT_NAMES = [
  "claims",
  "claim_edges",
  "pins",
  "intent_versions",
  "pilot_sessions",
  "pilot_attributions",
] as const;

export type RetentionRootName = (typeof RETENTION_ROOT_NAMES)[number];

/**
 * WHO OWES EACH ROOT'S LIVENESS RULE (01a §3.3b, §3.3c) — null where the
 * owning feature has defined it. One map for the hub's registry and for the
 * `doctor` sentence that names the owing spec, so the two cannot disagree.
 * A root whose owner is named here keeps everything it reaches until that
 * spec says when one of its rows stops being live.
 */
export const RETENTION_ROOT_LIVENESS_OWNER: Readonly<Record<RetentionRootName, string | null>> = {
  claims: "02/04",
  claim_edges: "02/04",
  pins: null,
  intent_versions: "06",
  // 07 declared (§11.8); whether they retain at all is D-E, Nick's.
  pilot_sessions: null,
  pilot_attributions: null,
};

/** At most this many unresolved pin ids travel in the report; the count is always whole. */
export const MAX_REPORTED_UNRESOLVED_PINS = 5;

/**
 * WHAT THE SWEEP KEEPS, AND WHY — the last COMPLETED cycle's own judgement
 * (the sweep judges its candidates window by window and publishes each full
 * cycle), over sessions past the retention window that still hold a
 * skeleton. Hub-wide counts; the only ids are pins', which a person needs to
 * find the pin. A session a second root also reaches is counted under each,
 * and the unresolved and file-bearing counts overlap the roots too — none of
 * these numbers is a partition, and none is summed.
 */
export interface SkeletonRetentionReport {
  /** How long after its explicit end a session may first be considered — the hub's own number. */
  readonly windowDays: number;
  /** Declared roots whose table is not built; while any is, nothing is swept. */
  readonly heldBy: readonly RetentionRootName[];
  /** ISO: when the last full cycle over this hub's sessions completed; null before the first. */
  readonly completedAt: string | null;
  /** ISO: when any pass last ran since this hub started; null if none has. */
  readonly lastPassAt: string | null;
  /** Explicitly ended sessions past the window that the cycle judged. */
  readonly aged: number;
  /** Of those, how many the cycle retired. */
  readonly swept: number;
  readonly keptBy: readonly { readonly root: RetentionRootName; readonly sessions: number }[];
  /** Kept because a file identity on either side could not be resolved (§3.3e). */
  readonly unresolved: number;
  /** Carrying a file touch — what the interim mode holds back, and full does not. */
  readonly fileBearing: number;
  /** Reaped past the window: never swept while the end is only inferred (§3.3a). */
  readonly reapedAwaitingEnd: number;
  /** Pins whose history holds a NULL, whose file is missing, or which have none yet. */
  readonly unresolvedPins: number;
  /** The first MAX_REPORTED_UNRESOLVED_PINS of them, by id. */
  readonly unresolvedPinIds: readonly string[];
  /** Sweep passes that failed, since this hub process started. */
  readonly sweepFailures: number;
}
