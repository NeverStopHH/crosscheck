/**
 * THE APPEND-ONLY INTENT LEDGER, AND THE ONE FUNCTION ALLOWED TO READ IT
 * (spec 06).
 *
 * THE PRINCIPLE, verbatim: "A reason written after a change is not evidence
 * that the reason existed before the change." Answering that needs two things,
 * and until this module only one of them existed. 01 supplies WHETHER two
 * things may be compared — `session-order.ts` is that gate. This supplies WHAT
 * is compared: the sentence, the paths it declared, and where in its own
 * session it was written.
 *
 * IT RECORDS INTENT EVOLUTION, IT DOES NOT AUTHORISE IT. An agent widening its
 * own intent authorises itself, so the value of this table is the CLOCK, not
 * the row. No predicate anywhere reads "the current intent covers X, therefore
 * X is fine": `explanationTimingFor` is the only consumer of the two tables, an
 * amendment can neither clear a protected conflict nor satisfy a human waiver
 * nor change an emitted verdict, and a meta-test fails the build on a second
 * consumer (INT-7).
 *
 * APPEND-ONLY MEANS APPEND-ONLY: there is no UPDATE and no DELETE path in this
 * file, and the unique `(work_context_id, version)` index is what makes that a
 * statement about the TABLE rather than about this module's discipline.
 */
import { desc, eq, inArray, sql } from "drizzle-orm";
import {
  MAX_COMMIT_CLOCK_SKEW_MS,
  MAX_INTENT_CHAIN_VERSIONS,
  isSeqStamp,
} from "@crosscheck/schema";
import type {
  Intent,
  IntentScopeRole,
  Provenance,
  SeqField,
  SeqKind,
  SeqReason,
} from "@crosscheck/schema";

import { intentScope, workContextIntents } from "../db/schema.ts";
import { causalComparisonOf, compareEvents } from "./session-order.ts";
import { seqReasonOf, windowFloorOf } from "./session-events.ts";
import type { DbExecutor } from "../db/client.ts";
import type {
  CausalIndeterminacy,
  OrderedEvent,
  SessionCausalOrder,
} from "./session-order.ts";
import type { OrderedEdit } from "./session-events.ts";
import type { Clock } from "../types.ts";

/**
 * THE VERSION OF THE LADDER THAT PRODUCED AN ANSWER.
 *
 * Exported for 01a, whose attestations store it on every row they write: a
 * stored judgment is only interpretable beside the rules that produced it, and
 * step 6's first draft answered a violated non-goal `predeclared`. A row older
 * than the current value was computed by a ladder that no longer exists, and
 * that is a fact about the ROW, not something a later reader may assume away.
 *
 * BUMP IT WHENEVER AN EARLY RETURN MOVES, IS ADDED OR IS DELETED. The order of
 * the returns IS the contract; a reordered ladder is a different function.
 */
export const EXPLANATION_LADDER_VERSION = 1;

/**
 * IS AN AMENDED-AWAY VERSION STILL LIVE? YES — 01a registers this table's
 * `author_session_id` as a retention root with the liveness question left to
 * this spec, and the answer is the one principle 6 forces: retention requires
 * positive proof to DELETE, not positive proof to keep. An amended-away
 * version is precisely the sentence this ledger exists to preserve; treating
 * it as dead would restore the overwrite the whole design was written to kill,
 * and it would do so silently, because the head would still read correctly.
 *
 * Declared as a VALUE rather than left `undefined_pending_spec`, because a
 * registry that reads "nobody decided" keeps the rows for a different reason,
 * and 01a's doctor line would report an open question where there is an answer.
 */
export const INTENT_VERSION_LIVENESS = "every_version_live" as const;

export const EXPLANATION_TIMINGS = [
  "predeclared",
  "post_hoc",
  "absent",
] as const;

export type ExplanationTiming = (typeof EXPLANATION_TIMINGS)[number];

/**
 * THE WORD THAT TRAVELS WITH THE TIMING, and never travels without it.
 *
 * `absent` alone asserts that no explanation exists, which is a different and
 * far more damaging claim than "we cannot tell when this one was written": the
 * first accuses a developer, the second excuses one. So the value and its
 * reason are ONE ATOMIC ANSWER and no surface prints the value without the
 * reason — the discipline `attribution: INDETERMINATE` already follows with
 * its basis, and a coverage state with its coverage reason.
 *
 * THREE OF THESE ARE ORDER-DERIVED — `declared_before`, `declared_after` and
 * `declared_non_goal_edited` — and the rest are refusals. 01a's attestation
 * rows store the order-derived three only.
 */
export const TIMING_REASONS = [
  "declared_before",
  "declared_after",
  "declared_non_goal_edited",
  "no_intent",
  "derived_excluded",
  "different_session",
  "not_comparable",
  "scope_not_named",
] as const;

export type TimingReason = (typeof TIMING_REASONS)[number];

/**
 * ONE ATOMIC ANSWER, and it carries the refusal's own name beside it.
 *
 * `indeterminacy` is 01's vocabulary, not a second enum of ours. The order gate
 * distinguishes six ways a pair cannot be compared and says why that matters:
 * "a refusal reported under another defect's reason sends its reader to the
 * wrong remedy". `not_comparable` is the word a HUMAN reads on a rendered line;
 * this is the word a doctor line, an attestation or a bug report needs. Null
 * whenever the answer did not come from the gate.
 */
export interface ExplanationTimingAnswer {
  readonly timing: ExplanationTiming;
  readonly reason: TimingReason;
  readonly version: number | null;
  readonly indeterminacy: CausalIndeterminacy | null;
}

export interface IntentScopeEntryRow {
  readonly role: IntentScopeRole;
  readonly kind: string;
  readonly value: string;
}

export interface IntentLedgerEntry {
  readonly id: string;
  readonly workContextId: string;
  readonly version: number;
  readonly amendsVersion: number | null;
  readonly authorSessionId: string | null;
  readonly provenance: Provenance;
  readonly summary: string;
  readonly reason: string | null;
  readonly seqEpoch: string | null;
  readonly seq: number | null;
  readonly seqAfter: number | null;
  readonly seqKind: SeqKind;
  readonly seqReason: SeqReason;
  readonly capturedAt: Date;
  readonly receivedAt: Date | null;
  readonly wire: Record<string, unknown>;
  readonly scope: readonly IntentScopeEntryRow[];
}

const ID_PREFIX = "iv_";
const ID_HASH_CHARS = 32;

/**
 * `iv_` + sha256(context, author session, position, summary) — the
 * `hint_deliveries` shape, so a replayed spool line is a `duplicate` rather
 * than a second version of the same sentence.
 *
 * THE POSITION IS INSIDE THE HASH AND SO IS THE SUMMARY, because neither alone
 * separates the rows that must stay separate: a session re-declaring the SAME
 * sentence takes a new position, and two DIFFERENT sentences can both be
 * written in a stretch where no position could be allocated at all.
 */
export const intentVersionId = (
  workContextId: string,
  authorSessionId: string | null,
  seq: number | null,
  summary: string,
): string =>
  `${ID_PREFIX}${new Bun.CryptoHasher("sha256")
    .update(
      [
        workContextId,
        authorSessionId ?? "",
        seq === null ? "null" : String(seq),
        summary,
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, ID_HASH_CHARS)}`;

/**
 * WHICH LANE WROTE THIS SENTENCE, derived here and never taken from the body —
 * the rule `seqKindFor` states for targets and the claim path already applies:
 * a connector that could choose its own `seq_kind` could promote an upper
 * bound to a happens-before.
 *
 * A DERIVED INTENT IS A DETACHED WORKER'S. It summarises a slice from EARLIER
 * in the session, so the position it allocates records when the row was
 * written, not when the thing it describes happened — an upper bound. An agent
 * calling `set_intent` is declaring on its own account, synchronously, and
 * that position is emitted.
 */
const intentSeqKind = (provenance: Provenance): SeqKind =>
  provenance === "derived" ? "observed" : "emitted";

const SCOPE_WIRE_KEYS = {
  expected: "expectedSurface",
  non_goal: "nonGoals",
} as const;

const scopeRows = (
  intent: Intent,
  role: IntentScopeRole,
): readonly IntentScopeEntryRow[] => {
  const declared = (intent as Record<string, unknown>)[SCOPE_WIRE_KEYS[role]];
  if (!Array.isArray(declared)) {
    return [];
  }
  return declared.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const kind = (entry as Record<string, unknown>)["kind"];
    const value = (entry as Record<string, unknown>)["value"];
    return typeof kind === "string" && typeof value === "string"
      ? [{ role, kind, value }]
      : [];
  });
};

const reasonOf = (intent: Intent): string | null => {
  const reason = (intent as Record<string, unknown>)["reason"];
  return typeof reason === "string" && reason.length > 0 ? reason : null;
};

export interface AppendIntentInput {
  readonly workContextId: string;
  readonly authorSessionId: string;
  readonly intent: Intent;
  /** The ENVELOPE's position — never the body's; a body may not carry one. */
  readonly seq: SeqField | undefined;
}

export interface AppendIntentOutcome {
  /** The wire as STORED, which is what the head becomes a copy of. */
  readonly wire: Record<string, unknown>;
  readonly version: number;
  /** True when the cap refused the append and the head must not move. */
  readonly capped: boolean;
}

/**
 * APPENDS ONE VERSION, inside the transaction the caller already opened.
 *
 * THE HUB ASSIGNS `version`, `amends_version` and `received_at`, and clamps
 * `captured_at`. Two writers exist per work context — `set_intent` and the
 * derived worker — so a connector-assigned version would let both claim v2;
 * and `amends_version` is the number a connector structurally CANNOT learn,
 * since its own work-context handle carries no version and reading one would
 * be the HTTP call §6 forbids. The connector supplies the sentence, the scope
 * and the `reason`, which are the things only it knows.
 *
 * THE POSITION COMES FROM THE ENVELOPE. A body-carried position would be a
 * connector choosing its own answer to AT-4 — worse than the body-carried
 * `provenance` §1.2 already calls a defect — so the stored `wire` has the
 * envelope's position written INTO it and a body-sent `seq` is discarded.
 */
export const appendIntentVersion = async (
  deps: { readonly db: DbExecutor; readonly now: Clock },
  input: AppendIntentInput,
): Promise<AppendIntentOutcome> => {
  const now = deps.now();
  const previous = await deps.db
    .select({ version: workContextIntents.version })
    .from(workContextIntents)
    .where(eq(workContextIntents.workContextId, input.workContextId))
    .orderBy(desc(workContextIntents.version))
    .limit(1);
  const head = previous[0]?.version ?? null;
  const stamp = isSeqStamp(input.seq) ? input.seq : null;
  const seq = stamp === null ? null : stamp.n;
  const wire: Record<string, unknown> = {
    ...(input.intent as Record<string, unknown>),
    seq: stamp === null ? null : { epoch: stamp.epoch, n: stamp.n },
    amendsVersion: head,
  };
  if (head !== null && head >= MAX_INTENT_CHAIN_VERSIONS) {
    // THE CAP IS WHAT REPLACES A RETENTION JOB — there is no background pass
    // over this table, so nothing else bounds one context's history. The
    // record is ACCEPTED and the head stays where it is; the caller reports
    // the cap rather than reporting the sentence as recorded.
    return { wire, version: head, capped: true };
  }
  const version = (head ?? 0) + 1;
  const id = intentVersionId(
    input.workContextId,
    input.authorSessionId,
    seq,
    input.intent.summary,
  );
  const provenance = input.intent.provenance;
  const inserted = await deps.db
    .insert(workContextIntents)
    .values({
      id,
      workContextId: input.workContextId,
      version,
      amendsVersion: head,
      authorSessionId: input.authorSessionId,
      seqEpoch: stamp === null ? null : stamp.epoch,
      seq,
      seqAfter: stamp === null ? null : windowFloorOf(stamp),
      seqKind: intentSeqKind(provenance),
      seqReason: seqReasonOf(input.seq),
      provenance,
      summary: input.intent.summary,
      // A `reason` is only ever meaningful beside an amendment, and a first
      // declaration carrying one would trip the table's own amend CHECK.
      reason: head === null ? null : reasonOf(input.intent),
      // SENDER-CONTROLLED, so clamped to the hub clock plus skew. It orders
      // nothing — §3.5 reads no clock at all — and serves display only.
      capturedAt: new Date(
        Math.min(
          Date.parse(input.intent.capturedAt),
          now.getTime() + MAX_COMMIT_CLOCK_SKEW_MS,
        ),
      ),
      receivedAt: now,
      wire,
    })
    .onConflictDoNothing()
    .returning({ version: workContextIntents.version });
  if (inserted[0] === undefined) {
    // A replay of this very version: same context, same author, same position,
    // same sentence. The head is already this row's wire.
    return { wire, version: head ?? version, capped: false };
  }
  const scope = [
    ...scopeRows(input.intent, "expected"),
    ...scopeRows(input.intent, "non_goal"),
  ];
  if (scope.length > 0) {
    await deps.db
      .insert(intentScope)
      .values(
        scope.map((entry) => ({
          intentId: id,
          workContextId: input.workContextId,
          role: entry.role,
          kind: entry.kind as "file",
          value: entry.value,
        })),
      )
      .onConflictDoNothing();
  }
  return { wire, version, capped: false };
};

/**
 * THE WHOLE CHAIN OF ONE WORK CONTEXT, newest first, with its scope attached.
 *
 * Bounded by the cap rather than by a `limit` here: a chain truncated on READ
 * would make the ladder's "earliest survivor" the earliest of what it happened
 * to see, which is a different function on a long chain than on a short one.
 */
export const readIntentChain = async (
  db: DbExecutor,
  workContextId: string,
): Promise<readonly IntentLedgerEntry[]> => {
  const rows = await db
    .select()
    .from(workContextIntents)
    .where(eq(workContextIntents.workContextId, workContextId))
    .orderBy(desc(workContextIntents.version));
  if (rows.length === 0) {
    return [];
  }
  const scope = await db
    .select()
    .from(intentScope)
    .where(
      inArray(
        intentScope.intentId,
        rows.map((row) => row.id),
      ),
    );
  const byIntent = new Map<string, IntentScopeEntryRow[]>();
  for (const entry of scope) {
    byIntent.set(entry.intentId, [
      ...(byIntent.get(entry.intentId) ?? []),
      { role: entry.role, kind: entry.kind, value: entry.value },
    ]);
  }
  return rows.map((row) => ({
    ...row,
    wire: row.wire ?? {},
    scope: byIntent.get(row.id) ?? [],
  }));
};

export interface IntentPositionCounts {
  readonly total: number;
  readonly unpositioned: number;
}

/** Both halves, always — a hub with no rows at all is not a hub with no gaps. */
export const countIntentPositions = async (
  db: DbExecutor,
): Promise<IntentPositionCounts> => {
  const rows = await db
    .select({
      total: sql<number>`count(*)::int`,
      unpositioned: sql<number>`count(*) filter (where ${workContextIntents.seq} is null)::int`,
    })
    .from(workContextIntents);
  return rows[0] ?? { total: 0, unpositioned: 0 };
};

/** A ledger row as the order gate is asked about it. */
const orderedEventOf = (entry: IntentLedgerEntry): OrderedEvent => ({
  sessionId: entry.authorSessionId ?? "",
  seqEpoch: entry.seqEpoch,
  seqN: entry.seq,
  seqAfter: entry.seqAfter,
  seqKind: entry.seqKind,
  seqReason: entry.seqReason,
  // Carried because the gate's shape has it, and read by nothing: this whole
  // function answers from positions, never from a clock.
  observedAt: entry.receivedAt ?? entry.capturedAt,
});

/**
 * WHICH REFUSAL TO REPORT when several survivors are refused for several
 * reasons — ordered by how much the reason tells a reader to DO, the
 * `ABSENCE_PRIORITY` discipline one file over.
 */
const INDETERMINACY_PRIORITY: readonly CausalIndeterminacy[] = [
  "session_order_unusable",
  "epoch_mismatch",
  "upper_bound_only",
  "concurrent",
  "position_indeterminate",
  "different_session",
];

const worstOf = (
  reasons: readonly CausalIndeterminacy[],
): CausalIndeterminacy | null =>
  INDETERMINACY_PRIORITY.find((candidate) => reasons.includes(candidate)) ??
  reasons[0] ??
  null;

const namesPath = (
  entry: IntentLedgerEntry,
  role: IntentScopeRole,
  edit: OrderedEdit,
): boolean =>
  entry.scope.some(
    (scope) =>
      scope.role === role &&
      scope.kind === edit.kind &&
      scope.value === edit.value,
  );

/** The open end of a declaration's window; a point emitter is its own window. */
const floorOf = (entry: IntentLedgerEntry): number =>
  entry.seqAfter ?? entry.seq ?? 0;

const earliest = (
  entries: readonly IntentLedgerEntry[],
): IntentLedgerEntry | undefined =>
  entries.reduce<IntentLedgerEntry | undefined>(
    (best, entry) =>
      best === undefined ||
      floorOf(entry) < floorOf(best) ||
      (floorOf(entry) === floorOf(best) && entry.version < best.version)
        ? entry
        : best,
    undefined,
  );

const answer = (
  timing: ExplanationTiming,
  reason: TimingReason,
  version: number | null = null,
  indeterminacy: CausalIndeterminacy | null = null,
): ExplanationTimingAnswer => ({ timing, reason, version, indeterminacy });

/**
 * WAS THE REASON WRITTEN BEFORE THE CHANGE? — a ladder of early returns, and
 * THE ORDER OF THE RETURNS IS THE CONTRACT. Changing which one fires first
 * changes the answer, so each is numbered here and in the spec.
 *
 *   1. no chain at all                    -> absent / no_intent
 *   2. nothing DECLARED survives          -> absent / derived_excluded
 *   3. nothing from the EDIT'S session    -> absent / different_session
 *   4. nothing COMPARABLE with the edit   -> absent / not_comparable
 *   5. nothing NAMING the edited path     -> absent / scope_not_named
 *   6. answer by role, non-goal first
 *
 * STEP 4 IS THE ORDER GATE ITSELF, NOT A REIMPLEMENTATION OF PART OF IT, and
 * this is the one place this implementation departs from the letter of §3.5.
 * The spec's step 4 drops `seq === null` and a mismatched epoch and stops
 * there — two of the gate's six conditions. The four it omits are the ones
 * that matter most here: an `observed` position is an UPPER BOUND, which every
 * Stop-time git-lane edit and every unbracketed tool-lane edit carries, and two
 * events whose WINDOWS OVERLAP are concurrent. Comparing the bare numbers in
 * either case answers `predeclared` — the value that exonerates — from what
 * `session-order.ts` measured as a coin flip inverting 10 trials out of 10.
 * That is the defect this whole spec exists to prevent, reintroduced in the one
 * direction nobody reports: a gap producing an ACCUSATION is reported by the
 * person accused, and a gap producing an EXONERATION is reported by nobody. So
 * the gate is CALLED.
 *
 * STEP 6 ANSWERS BY ROLE, AND NON-GOAL WINS. A session that declared
 * "do not touch b.ts" and then touched it is the most post-hoc thing a session
 * can do; folding it into the expectation branch reports a sentence that said
 * the OPPOSITE as a reason declared before the change — principle 3 answered
 * backwards on the one input this ledger exists to capture.
 *
 * NOTHING HERE READS A CLOCK. `captured_at`, `received_at` and the envelope
 * `ts` appear nowhere in this function, and a mutation anchor exists to keep it
 * that way.
 */
export const explanationTimingFor = (
  order: SessionCausalOrder,
  chain: readonly IntentLedgerEntry[],
  edit: OrderedEdit,
): ExplanationTimingAnswer => {
  // 1
  if (chain.length === 0) {
    return answer("absent", "no_intent");
  }
  // 2 — A DERIVED NON-GOAL IS A SUGGESTION TO A HUMAN, NEVER EVIDENCE AGAINST
  // THE SAME AGENT. A model's guess about what a session meant may be shown;
  // it may not enter a timing answer about the session that produced it.
  const declared = chain.filter((entry) => entry.provenance === "declared");
  if (declared.length === 0) {
    return answer("absent", "derived_excluded");
  }
  // 3 — there is no cross-session order. A subagent that sometimes inherits
  // its parent's host key and sometimes mints its own makes a bare comparison
  // SILENTLY wrong; refusing makes it something a reader can see.
  const ownSession = declared.filter(
    (entry) => entry.authorSessionId === edit.event.sessionId,
  );
  if (ownSession.length === 0) {
    return answer("absent", "different_session");
  }
  // 4
  const refusals: CausalIndeterminacy[] = [];
  const comparable = ownSession.filter((entry) => {
    const outcome = causalComparisonOf(order, orderedEventOf(entry), edit.event);
    if (outcome.outcome === "comparable") {
      return true;
    }
    refusals.push(outcome.reason);
    return false;
  });
  if (comparable.length === 0) {
    return answer("absent", "not_comparable", null, worstOf(refusals));
  }
  // 5
  const named = comparable.filter(
    (entry) =>
      namesPath(entry, "expected", edit) || namesPath(entry, "non_goal", edit),
  );
  if (named.length === 0) {
    return answer("absent", "scope_not_named");
  }
  // 6
  const before = (entry: IntentLedgerEntry): boolean =>
    compareEvents(order, orderedEventOf(entry), edit.event) === -1;
  const nonGoal = earliest(
    named.filter((entry) => namesPath(entry, "non_goal", edit)),
  );
  if (nonGoal !== undefined && before(nonGoal)) {
    return answer("post_hoc", "declared_non_goal_edited", nonGoal.version);
  }
  const expected = earliest(
    named.filter((entry) => namesPath(entry, "expected", edit)),
  );
  if (expected !== undefined && before(expected)) {
    return answer("predeclared", "declared_before", expected.version);
  }
  return answer("post_hoc", "declared_after", earliest(named)?.version ?? null);
};

/** The read half, for a caller holding ids rather than a chain. */
export const explanationTimingOf = async (
  db: DbExecutor,
  order: SessionCausalOrder,
  workContextId: string,
  edit: OrderedEdit,
): Promise<ExplanationTimingAnswer> =>
  explanationTimingFor(order, await readIntentChain(db, workContextId), edit);
