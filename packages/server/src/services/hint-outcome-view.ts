/**
 * ONE PERSON'S OWN HINT OUTCOMES (1.0 spec 07 §13) — what reached the caller
 * on this repo, what each led to, from whose work, and why.
 *
 * THE CALLER, AND ONLY THE CALLER. Every query below is keyed by the
 * developer the route authenticated; nothing takes a person as a parameter,
 * so a view of somebody else is not a request this hub can answer. The team
 * report stays per repo and aggregated (§8.4) — this is not a breakdown of the
 * team, it is a reader's own history.
 *
 * WHAT A TEAMMATE LEARNS is one count about their OWN work: how often the
 * hints that pointed at it were followed. No recipient, no reason, no
 * override and no noise rides beside it — those are other people's words
 * about their own sessions. And not even that count while it could single
 * somebody out (review #10): it covers the last whole month, frozen at its
 * end, and is shown only once at least three people recorded something about
 * that work — otherwise the answer says why there is no number.
 *
 * NO RANKING. Teammates are listed in name order, never by count: a list of
 * people sorted by how often their work was taken is a score, and 00 §8.5
 * bans scoring people.
 *
 * What a delivery stands at is defined once, in `outcome-population.ts`.
 */
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { LEGACY_PROVENANCE } from "@crosscheck/schema";
import type { HintOutcome, HintOutcomeWithholding } from "@crosscheck/schema";

import { HINT_OUTCOME_MAX_REASONS, HINT_OUTCOME_MAX_SOURCES } from "../constants.ts";
import {
  EMPTY_TALLY,
  addToTally,
  deliveryStates,
  enrolledSpan,
  lastWholeMonth,
  outcomePopulationStart,
  readEnrolments,
  readPeriodAggregate,
  withholdingOf,
} from "./outcome-population.ts";
import type { DeliveryState, Enrolment, HintOutcomeTally } from "./outcome-population.ts";
import { countingFromOf, isCoolingRow, isRetractedRow } from "./human-provenance.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

export type { HintOutcomeTally } from "./outcome-population.ts";

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

const MS_PER_DAY = 86_400_000;

export interface SourceTally extends HintOutcomeTally {
  /** The teammate whose work the hints pointed at; null when it is not this repo's or not found. */
  readonly source: string | null;
  /** Of `received`, those whose newest label of the caller's own is helpful — beside the buckets, never in them (07 §13.14). */
  readonly helpful: number;
}

export interface OutcomeReason {
  /**
   * The word that stands — an outcome, or the person's noise (said again: round-5 LOW-6) — or the person's
   * own helpful label, whose sentence sits beside the outcome's (round-6 LOW-6).
   */
  readonly outcome: HintOutcome | "noise" | "helpful";
  readonly reason: string;
  readonly source: string | null;
  /** Present, and true, only on the sentence of a noise said again (a re-assertion). */
  readonly reasserted?: true;
}

export interface MyHintOutcomes extends HintOutcomeTally {
  /** The caller's own helpful labels, beside the buckets (07 §13.14). */
  readonly helpful: number;
  readonly repo: string;
  readonly days: number;
  readonly sinceIso: string;
  readonly untilIso: string;
  /** The pilot paused inside the window: only its enrolled time is counted (07 §13.11, review M3). */
  readonly pausedInWindow: boolean;
  readonly bySource: readonly SourceTally[];
  readonly bySourceBeyondList: number;
  readonly reasons: readonly OutcomeReason[];
  readonly reasonsBeyondList: number;
  /** Hints that pointed at the CALLER's work and that the teammate they reached followed. */
  readonly yourWork: YourWork;
  /**
   * WHAT IS NOT THE CALLER'S JUDGEMENT YET (human provenance §5), never inside
   * the tallies above: outcome and label drafts waiting for their passkey, by
   * the class of the door they came through, and pointers whose only words
   * were recorded before provenance existed.
   */
  readonly notConfirmed: NotConfirmed;
}

export interface NotConfirmed {
  /** Drafted by the caller's agent (`mark_hint_outcome`), not confirmed. */
  readonly byAgent: number;
  /** Typed at a terminal (`crosscheck followed / overrode / noise / helpful`), not confirmed. */
  readonly atTerminal: number;
  /** Pointers whose words date from before 0.11 (`unknown_legacy`). */
  readonly legacy: number;
  /**
   * Pointers with a word confirmed by a passkey still in its cool-off (review
   * H1): it took effect, and counts from `countingFrom` unless revoked first.
   */
  readonly coolingOff: number;
  /** When the earliest of those starts counting, as ISO; null with none. */
  readonly countingFrom: string | null;
  /** Pointers with a word confirmed by a passkey since revoked: retracted, never counted. */
  readonly retracted: number;
}

/** The person's confirmed words on their deliveries: outcomes, labels and noise said again. */
const confirmedWordsOf = (developerId: string, repo: string, since: Date): SQL => sql`
  SELECT hd.session_id, hd.ref_id, w.provenance, w.confirmation_id FROM (
    SELECT o.delivery_id, o.provenance, o.confirmation_id, o.created_at FROM hint_outcomes o
    WHERE o.recorded_by = ${developerId} AND o.repo = ${repo}
    UNION ALL
    SELECT m.ref_id, m.provenance, m.confirmation_id, m.created_at FROM pilot_marks m
    WHERE m.marked_by = ${developerId} AND m.repo = ${repo} AND m.ref_kind = 'hint_delivery'
    UNION ALL
    SELECT r.delivery_id, r.provenance, r.confirmation_id, r.created_at FROM noise_reassertions r
    WHERE r.marked_by = ${developerId} AND r.repo = ${repo}
  ) w JOIN hint_deliveries hd ON hd.id = w.delivery_id
  WHERE w.created_at >= ${since.toISOString()}::timestamptz`;

/** The confirmed words that count in no figure now: cooling off, or retracted (review H1). */
const readUncounted = async (
  deps: Deps,
  input: ReadMyHintOutcomesInput,
  since: Date,
): Promise<Pick<NotConfirmed, "coolingOff" | "countingFrom" | "retracted">> => {
  const at = deps.now();
  const rows = await deps.db.execute<{ cooling: number; counting_from: string | Date | null; retracted: number }>(sql`
    WITH words AS (${confirmedWordsOf(input.developerId, input.repo, since)})
    SELECT
      (SELECT count(DISTINCT (session_id, ref_id))::int FROM words w WHERE ${isCoolingRow("w", at)}) AS cooling,
      (SELECT min(${countingFromOf("w")}) FROM words w WHERE ${isCoolingRow("w", at)}) AS counting_from,
      (SELECT count(DISTINCT (session_id, ref_id))::int FROM words w WHERE ${isRetractedRow("w")}) AS retracted`);
  const row = rows.rows[0];
  return {
    coolingOff: row?.cooling ?? 0,
    countingFrom: row?.counting_from === null || row?.counting_from === undefined ? null : new Date(row.counting_from).toISOString(),
    retracted: row?.retracted ?? 0,
  };
};

const readNotConfirmed = async (deps: Deps, input: ReadMyHintOutcomesInput, since: Date): Promise<NotConfirmed> => {
  const uncounted = await readUncounted(deps, input, since);
  const rows = await deps.db.execute<{ by_agent: number; at_terminal: number; legacy: number }>(sql`
    WITH drafted AS (
      SELECT DISTINCT ON (d.subject_key) d.id, d.provenance, d.created_at
      FROM human_drafts d
      WHERE d.developer_id = ${input.developerId} AND d.repo = ${input.repo} AND d.kind IN ('outcome', 'label')
      ORDER BY d.subject_key, d.version DESC
    ), pending AS (
      SELECT * FROM drafted dr
      WHERE dr.created_at >= ${since.toISOString()}::timestamptz
        AND NOT EXISTS (SELECT 1 FROM human_confirmation_items i
                        WHERE i.draft_id = dr.id AND i.decision IN ('confirm', 'discard'))
    )
    SELECT
      (SELECT count(*)::int FROM pending WHERE provenance = 'agent_asserted') AS by_agent,
      (SELECT count(*)::int FROM pending WHERE provenance = 'interactive_terminal_asserted') AS at_terminal,
      (SELECT count(DISTINCT (hd.session_id, hd.ref_id))::int FROM hint_outcomes o
        JOIN hint_deliveries hd ON hd.id = o.delivery_id
        WHERE o.recorded_by = ${input.developerId} AND o.repo = ${input.repo} AND o.provenance = ${LEGACY_PROVENANCE}
          AND o.created_at >= ${since.toISOString()}::timestamptz) AS legacy`);
  const row = rows.rows[0];
  return { byAgent: row?.by_agent ?? 0, atTerminal: row?.at_terminal ?? 0, legacy: row?.legacy ?? 0, ...uncounted };
};

/** The source credit: one closed month's follows of the caller's work, or why there is no number. */
export interface YourWork {
  readonly periodStartIso: string;
  readonly periodEndIso: string;
  readonly followed: number | null;
  /**
   * Follows of your work CONFIRMED in this month about hints of an earlier one
   * (review M6), apart from `followed` — present only when there are some and
   * `followed` is shown.
   */
  readonly followedLate?: number;
  readonly withheld: HintOutcomeWithholding | null;
  /** The pilot paused inside the month: only its enrolled time was counted (review LOW). */
  readonly pausedInPeriod: boolean;
  /** The month is counted over an enrolment an upgrade reconstructed from what was recorded (review M-3). */
  readonly reconstructed: boolean;
}

export interface ReadMyHintOutcomesInput {
  readonly repo: string;
  readonly developerId: string;
  readonly days: number;
}

/** The caller's own deliveries — the one recipient this view is ever about. */
const receivedBy = (developerId: string): SQL => sql`s.developer_id = ${developerId}`;

type TallyRow = {
  readonly source_id: string | null;
  readonly source: string | null;
  readonly state: DeliveryState;
  readonly n: number;
  readonly helpful: number;
};

type ReasonRow = {
  readonly outcome: HintOutcome | "noise" | "helpful";
  readonly reason: string;
  readonly source: string | null;
  readonly reasserted: boolean;
  readonly total: number;
};

const bySourceName = (left: SourceTally, right: SourceTally): number =>
  left.source === null ? 1 : right.source === null ? -1 : left.source.localeCompare(right.source);

const foldTallies = (
  rows: readonly TallyRow[],
): { readonly total: HintOutcomeTally & { readonly helpful: number }; readonly sources: readonly SourceTally[] } => {
  const sources = new Map<string, SourceTally>();
  for (const row of rows) {
    const key = row.source_id ?? "";
    const current = sources.get(key) ?? { source: row.source, helpful: 0, ...EMPTY_TALLY };
    sources.set(key, {
      ...addToTally(current, row.state, row.n),
      source: current.source,
      helpful: current.helpful + Number(row.helpful),
    });
  }
  const tally = rows.reduce((sum, row) => addToTally(sum, row.state, row.n), EMPTY_TALLY);
  const helpful = rows.reduce((sum, row) => sum + Number(row.helpful), 0);
  return { total: { ...tally, helpful }, sources: [...sources.values()].sort(bySourceName) };
};

const readTallies = async (
  deps: Deps,
  input: ReadMyHintOutcomesInput,
  since: Date,
): Promise<readonly TallyRow[]> => {
  const rows = await deps.db.execute<TallyRow>(sql`
    ${deliveryStates(input.repo, since, receivedBy(input.developerId), null, deps.now())}
    SELECT st.source_id, d.name AS source, st.state, count(*)::int AS n,
      count(*) FILTER (WHERE st.helpful_label)::int AS helpful
    FROM states st LEFT JOIN developers d ON d.id = st.source_id
    GROUP BY st.source_id, d.name, st.state`);
  return rows.rows;
};

/** The reasons beside the CURRENT words, newest first, with how many there were in all. */
const readReasons = async (
  deps: Deps,
  input: ReadMyHintOutcomesInput,
  since: Date,
): Promise<readonly ReasonRow[]> => {
  const rows = await deps.db.execute<ReasonRow>(sql`
    ${deliveryStates(input.repo, since, receivedBy(input.developerId), null, deps.now())}
    SELECT r.outcome, r.reason, d.name AS source, r.reasserted, count(*) OVER ()::int AS total
    FROM (
      SELECT st.state AS outcome, st.reason, st.reasserted, st.outcome_at AS at, st.id, st.source_id
      FROM states st WHERE st.reason IS NOT NULL
      UNION ALL
      -- round-6 LOW-6: the person's own helpful sentence, on the label axis beside the outcome's reason
      SELECT 'helpful', st.helpful_reason, false, st.helpful_at, st.id, st.source_id
      FROM states st WHERE st.helpful_reason IS NOT NULL
    ) r LEFT JOIN developers d ON d.id = r.source_id
    ORDER BY r.at DESC, r.id ASC, r.outcome ASC
    LIMIT ${HINT_OUTCOME_MAX_REASONS}`);
  return rows.rows;
};

/**
 * How often teammates followed hints that pointed at the caller's work — one
 * count over the last whole month as it stood at its end, and only once at
 * least three people recorded something about that work (review #10).
 */
const readYourWork = async (
  deps: Deps,
  input: ReadMyHintOutcomesInput,
  now: Date,
  enrolments: readonly Enrolment[],
): Promise<YourWork> => {
  const period = lastWholeMonth(now);
  const stamps = { periodStartIso: period.start.toISOString(), periodEndIso: period.end.toISOString() };
  const span = enrolledSpan(period.start, period.end, enrolments);
  if (span === null) {
    return { ...stamps, followed: null, withheld: "not_recordable", pausedInPeriod: false, reconstructed: false };
  }
  const aggregate = await readPeriodAggregate(deps.db, {
    repo: input.repo,
    from: span.from,
    until: period.end,
    who: sql`s.developer_id <> ${input.developerId}`,
    sourceIs: input.developerId,
    at: now,
  });
  // review M-1: a count only once, with any one person left out, three people FOLLOWED — never "followed 0"
  const withheld = withholdingOf(aggregate, { sources: false, recorded: false, followers: true });
  return {
    ...stamps,
    followed: withheld === null ? aggregate.followed : null,
    ...(withheld === null && aggregate.late.followed > 0 ? { followedLate: aggregate.late.followed } : {}),
    withheld,
    pausedInPeriod: span.paused,
    reconstructed: span.reconstructed,
  };
};

export const readMyHintOutcomes = async (
  deps: Deps,
  input: ReadMyHintOutcomesInput,
): Promise<MyHintOutcomes | { readonly refusal: "not_enrolled" }> => {
  // review M-2: READ-ONLY WHENEVER THE REPO WAS EVER IN THE PILOT — during a pause and after leaving,
  // the person still reads what they recorded; only a repo never enrolled has no view (writes stay refused)
  const enrolments = await readEnrolments(deps.db, input.repo);
  const [first] = enrolments;
  if (first === undefined) {
    return { refusal: "not_enrolled" };
  }
  const now = deps.now();
  const since = outcomePopulationStart(
    new Date(now.getTime() - input.days * MS_PER_DAY),
    first.start.toISOString(),
    now,
  );
  const [tallies, reasons, yourWork, notConfirmed] = await Promise.all([
    readTallies(deps, input, since),
    readReasons(deps, input, since),
    readYourWork(deps, input, now, enrolments),
    readNotConfirmed(deps, input, since),
  ]);
  const { total, sources } = foldTallies(tallies);
  const reasonsTotal = Number(reasons[0]?.total ?? 0);
  return {
    repo: input.repo,
    days: input.days,
    sinceIso: since.toISOString(),
    untilIso: now.toISOString(),
    pausedInWindow: enrolledSpan(since, now, enrolments)?.paused ?? false,
    ...total,
    bySource: sources.slice(0, HINT_OUTCOME_MAX_SOURCES),
    bySourceBeyondList: Math.max(0, sources.length - HINT_OUTCOME_MAX_SOURCES),
    // round-5 LOW-6: a re-asserted noise's sentence is listed, marked as said again (added only then: additive)
    reasons: reasons.map((row) => ({
      outcome: row.outcome,
      reason: row.reason,
      source: row.source,
      ...(row.reasserted ? { reasserted: true } : {}),
    })),
    reasonsBeyondList: Math.max(0, reasonsTotal - reasons.length),
    yourWork,
    notConfirmed,
  };
};
