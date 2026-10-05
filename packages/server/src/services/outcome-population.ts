/**
 * WHAT A DELIVERY STANDS AT, and over whom a figure may be shown (1.0 spec 07
 * §13.9) — one definition for the per-person view, the source credit and the
 * team line, so the three can never disagree about a delivery.
 *
 * ONE NOISE CONCEPT. Noise is the person's label in `pilot_marks` (and the
 * 0.10 `off_target` spelling); an outcome is the agent's or the person's word.
 * Per delivery the LATER of the two stands, the label on a tie.
 *
 * A SHARED FIGURE IS A CLOSED, FROZEN PERIOD (review #4/#10). Anything but the
 * recorder's own view covers the last whole calendar month (UTC), counted as
 * it stood at the month's end, and prints only above the disclosure minimums
 * (`HINT_OUTCOME_DISCLOSURE_MINIMUMS`): a window that could be stepped, or a
 * figure that moved when one person changed a word, would let a subtraction
 * single that person out.
 */
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { HINT_OUTCOME_DISCLOSURE_MINIMUMS, PULLED_DELIVERY_CHANNEL } from "@crosscheck/schema";
import type { HintOutcome, HintOutcomeWithholding } from "@crosscheck/schema";

import { NOISE_WORDS } from "./pilot-label-figures.ts";
import type { Db } from "../db/client.ts";

/** What one delivery stands at: an outcome, the noise label, or nothing said. */
export type DeliveryState = HintOutcome | "noise" | "unmarked";

export interface HintOutcomeTally {
  readonly received: number;
  readonly followed: number;
  readonly overrode: number;
  readonly notRelevantNow: number;
  readonly noise: number;
  readonly unmarked: number;
}

export const EMPTY_TALLY: HintOutcomeTally = {
  received: 0,
  followed: 0,
  overrode: 0,
  notRelevantNow: 0,
  noise: 0,
  unmarked: 0,
};

const TALLY_FIELD: Record<DeliveryState, keyof HintOutcomeTally> = {
  followed: "followed",
  overrode: "overrode",
  not_relevant_now: "notRelevantNow",
  noise: "noise",
  unmarked: "unmarked",
};

export const addToTally = (tally: HintOutcomeTally, state: DeliveryState, n: number): HintOutcomeTally => {
  const field = TALLY_FIELD[state];
  return { ...tally, received: tally.received + n, [field]: tally[field] + n };
};

/**
 * WHERE AN OUTCOME FIGURE STARTS: the later of its window's start and the
 * instant outcomes became recordable on the repo. A delivery from before that
 * instant could not have had an outcome, so it is outside the population —
 * never "unmarked". No instant (never enrolled) starts at `now`: nothing
 * counts, the conservative of the two errors.
 */
export const outcomePopulationStart = (windowStart: Date, outcomesSinceIso: string | null, now: Date): Date => {
  const recordable = outcomesSinceIso === null ? now : new Date(outcomesSinceIso);
  return recordable.getTime() > windowStart.getTime() ? recordable : windowStart;
};

export interface ClosedPeriod {
  readonly start: Date;
  readonly end: Date;
}

/** The last whole calendar month before `now`, in UTC — the one period a shared figure covers. */
export const lastWholeMonth = (now: Date): ClosedPeriod => {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start: new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1)), end };
};

/** Only what existed before `until` — a frozen period's state at its end; null is now. */
const before = (column: SQL, until: Date | null): SQL =>
  until === null ? sql`` : sql`AND ${column} < ${until.toISOString()}::timestamptz`;

/**
 * Every unasked delivery to the recipients `who` selects, on this repo, from
 * `since` (and before `until`, when given) — with its recipient, the developer
 * whose work it pointed at, and the word it stands at, as of `until` when
 * given. The source is THIS repo's: a delivery's ref is the client's own word,
 * so a pointer at another repo's work names nobody (07 §11.9).
 */
export const deliveryStates = (repo: string, since: Date, who: SQL, until: Date | null = null): SQL => sql`
  WITH received AS (
    SELECT hd.id, hd.ref_kind, hd.ref_id, s.developer_id AS recipient
    FROM hint_deliveries hd
    JOIN agent_sessions s ON s.id = hd.session_id
    WHERE s.repo = ${repo}
      AND ${who}
      AND hd.channel <> ${PULLED_DELIVERY_CHANNEL}
      AND hd.delivered_at >= ${since.toISOString()}::timestamptz
      ${before(sql`hd.delivered_at`, until)}
  ), sourced AS (
    SELECT r.*, (
      SELECT src.developer_id FROM agent_sessions src
      WHERE src.repo = ${repo} AND src.id = CASE WHEN r.ref_kind = 'work_context'
        THEN (SELECT wc.session_id FROM work_contexts wc WHERE wc.id = r.ref_id)
        ELSE (SELECT c.author_session_id FROM claims c WHERE c.id = r.ref_id) END
    ) AS source_id
    FROM received r
  ), stated AS (
    SELECT so.id, so.recipient, so.source_id, latest.outcome, latest.reason,
           latest.created_at AS outcome_at, m.created_at AS noise_at
    FROM sourced so
    LEFT JOIN LATERAL (
      SELECT o.outcome, o.reason, o.created_at FROM hint_outcomes o
      WHERE o.delivery_id = so.id AND o.recorded_by = so.recipient ${before(sql`o.created_at`, until)}
      ORDER BY o.created_at DESC, o.id DESC LIMIT 1
    ) latest ON true
    LEFT JOIN pilot_marks m ON m.ref_kind = 'hint_delivery' AND m.ref_id = so.id
      AND m.marked_by = so.recipient AND m.mark IN ${NOISE_WORDS} ${before(sql`m.created_at`, until)}
  ), states AS (
    SELECT id, recipient, source_id, outcome_at,
      CASE WHEN noise_at IS NOT NULL AND (outcome_at IS NULL OR noise_at >= outcome_at) THEN 'noise'
           WHEN outcome IS NOT NULL THEN outcome
           ELSE 'unmarked' END AS state,
      CASE WHEN noise_at IS NOT NULL AND (outcome_at IS NULL OR noise_at >= outcome_at) THEN NULL
           ELSE reason END AS reason
    FROM stated
  )`;

/** One closed period's counts, and how many people and how many people's work its words cover. */
export interface PeriodAggregate {
  readonly interventions: number;
  readonly followed: number;
  readonly overrode: number;
  readonly notRelevantNow: number;
  readonly noise: number;
  readonly unmarked: number;
  readonly recorders: number;
  readonly sources: number;
}

type AggregateRow = {
  readonly interventions: number;
  readonly followed: number;
  readonly overrode: number;
  readonly not_relevant_now: number;
  readonly noise: number;
  readonly unmarked: number;
  readonly recorders: number;
  readonly sources: number;
};

export const readPeriodAggregate = async (
  db: Db,
  input: {
    readonly repo: string;
    readonly from: Date;
    readonly until: Date;
    readonly who: SQL;
    /** Only deliveries pointing at this developer's work; null for all. */
    readonly sourceIs: string | null;
  },
): Promise<PeriodAggregate> => {
  const rows = await db.execute<AggregateRow>(sql`
    ${deliveryStates(input.repo, input.from, input.who, input.until)}
    SELECT count(*)::int AS interventions,
      count(*) FILTER (WHERE state = 'followed')::int AS followed,
      count(*) FILTER (WHERE state = 'overrode')::int AS overrode,
      count(*) FILTER (WHERE state = 'not_relevant_now')::int AS not_relevant_now,
      count(*) FILTER (WHERE state = 'noise')::int AS noise,
      count(*) FILTER (WHERE state = 'unmarked')::int AS unmarked,
      count(DISTINCT recipient) FILTER (WHERE state <> 'unmarked')::int AS recorders,
      count(DISTINCT source_id) FILTER (WHERE state <> 'unmarked')::int AS sources
    FROM states
    ${input.sourceIs === null ? sql`` : sql`WHERE source_id = ${input.sourceIs}`}`);
  const row = rows.rows[0];
  return {
    interventions: Number(row?.interventions ?? 0),
    followed: Number(row?.followed ?? 0),
    overrode: Number(row?.overrode ?? 0),
    notRelevantNow: Number(row?.not_relevant_now ?? 0),
    noise: Number(row?.noise ?? 0),
    unmarked: Number(row?.unmarked ?? 0),
    recorders: Number(row?.recorders ?? 0),
    sources: Number(row?.sources ?? 0),
  };
};

/**
 * WHICH DISCLOSURE MINIMUM A PERIOD FAILS, or null when it may print. The
 * team line checks all three; an author's credit is about their own work, so
 * only the people-minimum applies to it.
 */
export const withholdingOf = (
  aggregate: PeriodAggregate,
  checks: { readonly sources: boolean; readonly recorded: boolean },
): HintOutcomeWithholding | null => {
  if (aggregate.interventions === 0) {
    return "no_interventions";
  }
  if (aggregate.recorders < HINT_OUTCOME_DISCLOSURE_MINIMUMS.recorders) {
    return "too_few_recorders";
  }
  if (checks.sources && aggregate.sources < HINT_OUTCOME_DISCLOSURE_MINIMUMS.sources) {
    return "too_few_sources";
  }
  const recorded = aggregate.interventions - aggregate.unmarked;
  return checks.recorded && recorded < HINT_OUTCOME_DISCLOSURE_MINIMUMS.recorded ? "too_few_recorded" : null;
};
