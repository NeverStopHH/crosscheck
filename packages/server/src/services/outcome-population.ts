/**
 * WHAT A DELIVERY STANDS AT, and over whom a figure may be shown (1.0 spec 07
 * §13.9) — one definition for the per-person view, the source credit and the
 * team line, so the three can never disagree about a delivery.
 *
 * ONE INTERVENTION IS ONE POINTER IN ONE SESSION (review M4): a prompt hint
 * and a tripwire ask about the same work context in the same session are two
 * deliveries but one hint, and a word recorded on either covers both. So
 * every figure counts distinct (session, ref), and reads the words and labels
 * of all that pointer's deliveries.
 *
 * ONE NOISE CONCEPT. Noise is the person's label in `pilot_marks` (and the
 * 0.10 `off_target` spelling); an outcome is the agent's or the person's word.
 * Per intervention the person's newest word stands — their own outcome or
 * their noise, the label on a tie — and only when they said none, the
 * agent's newest (§13.12): an agent's word never overturns the person's.
 *
 * A SHARED FIGURE IS A CLOSED, FROZEN PERIOD (review #4/#10) — frozen by the
 * hub's own clock: a delivery is read into a month only if the hub had RECEIVED
 * it before the month ended (`ingested_at`, review P5), so a backlog drained in
 * August never moves July. Anything but the
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

/**
 * WHILE THE REPO WAS IN THE PILOT (07 §13.11, review M3): an instant inside
 * one of its enrolled intervals. A delivery from before the first enrolment,
 * or from a pause, could not have had an outcome, so it is outside every
 * figure — and a pause never erases what was recorded before it.
 */
export const whileEnrolled = (repo: string, instant: SQL): SQL => sql`EXISTS (
  SELECT 1 FROM pilot_enrolments pe
  WHERE pe.repo = ${repo} AND ${instant} >= pe.started_at
    AND (pe.ended_at IS NULL OR ${instant} < pe.ended_at))`;

export interface Enrolment {
  readonly start: Date;
  /** Null while the repo is enrolled now. */
  readonly end: Date | null;
}

type EnrolmentRow = { readonly started_at: string | Date; readonly ended_at: string | Date | null };

/** The repo's enrolled intervals, oldest first. */
export const readEnrolments = async (db: Db, repo: string): Promise<readonly Enrolment[]> => {
  const rows = await db.execute<EnrolmentRow>(sql`
    SELECT started_at, ended_at FROM pilot_enrolments WHERE repo = ${repo} ORDER BY started_at`);
  return rows.rows.map((row) => ({
    start: new Date(row.started_at),
    end: row.ended_at === null ? null : new Date(row.ended_at),
  }));
};

/** The enrolled part of a window: where counting starts, and whether the pilot paused after that. */
export interface EnrolledSpan {
  readonly from: Date;
  readonly paused: boolean;
}

/**
 * The part of [start, end) the repo was enrolled in, or null when none of it
 * was. `paused` is true when counting does not run unbroken from `from` to
 * `end` — a pause, or a second interval, falls inside.
 */
export const enrolledSpan = (start: Date, end: Date, enrolments: readonly Enrolment[]): EnrolledSpan | null => {
  const overlapping = enrolments.filter(
    (enrolment) =>
      enrolment.start.getTime() < end.getTime() && (enrolment.end === null || enrolment.end.getTime() > start.getTime()),
  );
  const [first] = overlapping;
  if (first === undefined) {
    return null;
  }
  const from = first.start.getTime() > start.getTime() ? first.start : start;
  const endsEarly = first.end !== null && first.end.getTime() < end.getTime();
  return { from, paused: overlapping.length > 1 || endsEarly };
};

/** Only what existed before `until` — a frozen period's state at its end; null is now. */
const before = (column: SQL, until: Date | null): SQL =>
  until === null ? sql`` : sql`AND ${column} < ${until.toISOString()}::timestamptz`;

/**
 * Every unasked intervention — one pointer in one session — to the recipients
 * `who` selects, on this repo, delivered from `since` (and before `until`,
 * when given), with its recipient, the developer whose work it pointed at, and
 * the word it stands at, as of `until` when given. The source is THIS repo's:
 * a delivery's ref is the client's own word, so a pointer at another repo's
 * work names nobody (07 §11.9).
 */
export const deliveryStates = (repo: string, since: Date, who: SQL, until: Date | null = null): SQL => sql`
  WITH received AS (
    SELECT min(hd.id) AS id, hd.session_id, min(hd.ref_kind) AS ref_kind, hd.ref_id, s.developer_id AS recipient
    FROM hint_deliveries hd
    JOIN agent_sessions s ON s.id = hd.session_id
    WHERE s.repo = ${repo}
      AND ${who}
      AND hd.channel <> ${PULLED_DELIVERY_CHANNEL}
      AND ${whileEnrolled(repo, sql`hd.delivered_at`)}
      AND hd.delivered_at >= ${since.toISOString()}::timestamptz
      ${before(sql`hd.delivered_at`, until)}
      ${before(sql`COALESCE(hd.ingested_at, hd.delivered_at)`, until)}
    GROUP BY hd.session_id, hd.ref_id, s.developer_id
  ), sourced AS (
    SELECT r.*, (
      SELECT src.developer_id FROM agent_sessions src
      WHERE src.repo = ${repo} AND src.id = CASE WHEN r.ref_kind = 'work_context'
        THEN (SELECT wc.session_id FROM work_contexts wc WHERE wc.id = r.ref_id)
        ELSE (SELECT c.author_session_id FROM claims c WHERE c.id = r.ref_id) END
    ) AS source_id
    FROM received r
  ), stated AS (
    SELECT so.id, so.recipient, so.source_id, said.word, said.reason, said.at AS outcome_at
    FROM sourced so
    LEFT JOIN LATERAL (
      SELECT spoken.word, spoken.reason, spoken.at FROM (
        SELECT o.outcome AS word, o.reason, o.created_at AS at, o.id,
               COALESCE(o.recorded_via = 'person', false) AS by_person, false AS is_label
        FROM hint_outcomes o
        JOIN hint_deliveries od ON od.id = o.delivery_id
        WHERE od.session_id = so.session_id AND od.ref_id = so.ref_id
          AND o.recorded_by = so.recipient ${before(sql`o.created_at`, until)}
        UNION ALL
        SELECT 'noise', NULL, m.created_at, m.id, true, true FROM pilot_marks m
        JOIN hint_deliveries md ON md.id = m.ref_id
        WHERE m.ref_kind = 'hint_delivery' AND md.session_id = so.session_id AND md.ref_id = so.ref_id
          AND m.marked_by = so.recipient AND m.mark IN ${NOISE_WORDS} ${before(sql`m.created_at`, until)}
        UNION ALL
        -- review H-B: the person saying noise again is a row of its own, read before the month's end too
        SELECT 'noise', NULL, r.created_at, r.id, true, true FROM noise_reassertions r
        JOIN hint_deliveries rd ON rd.id = r.delivery_id
        WHERE rd.session_id = so.session_id AND rd.ref_id = so.ref_id
          AND r.marked_by = so.recipient ${before(sql`r.created_at`, until)}
      ) spoken
      -- 07 §13.12: the person's newest word (the label on a tie, D-O7); only when they said none, the agent's
      ORDER BY spoken.by_person DESC, spoken.at DESC, spoken.is_label DESC, spoken.id DESC LIMIT 1
    ) said ON true
  ), states AS (
    SELECT id, recipient, source_id, outcome_at, COALESCE(word, 'unmarked') AS state, reason
    FROM stated
  )`;

/**
 * One closed period's counts, and what its words would still cover with any
 * single recorder left out (review H1) — the viewer subtracting their own
 * words, or one colleague telling the viewer theirs.
 */
export interface PeriodAggregate {
  readonly interventions: number;
  readonly followed: number;
  readonly overrode: number;
  readonly notRelevantNow: number;
  readonly noise: number;
  readonly unmarked: number;
  /** People who recorded at least one word. */
  readonly recorders: number;
  /** The fewest distinct people's work the words cover once any one recorder's words are left out. */
  readonly sourcesWithoutAnyOne: number;
  /** The words left once the recorder who said most is left out — the dominance rule. */
  readonly wordsWithoutLargest: number;
}

type AggregateRow = {
  readonly interventions: number;
  readonly followed: number;
  readonly overrode: number;
  readonly not_relevant_now: number;
  readonly noise: number;
  readonly unmarked: number;
  readonly recorders: number;
  readonly sources_without_any_one: number;
  readonly largest_recorder_words: number;
};

/**
 * The words (what is not unmarked) and, per recorder, what the OTHERS' words
 * cover: subtracting one person's own contribution must never isolate anyone.
 */
const subtractionSafeColumns = sql`
      (SELECT count(DISTINCT recipient) FROM words)::int AS recorders,
      COALESCE((SELECT min(k) FROM (
        SELECT (SELECT count(DISTINCT w.source_id) FROM words w WHERE w.recipient <> r.recipient) AS k
        FROM (SELECT DISTINCT recipient FROM words) r) per_left_out), 0)::int AS sources_without_any_one,
      COALESCE((SELECT max(n) FROM (
        SELECT count(*) AS n FROM words GROUP BY recipient) per_recorder), 0)::int AS largest_recorder_words`;

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
    ${deliveryStates(input.repo, input.from, input.who, input.until)},
    scoped AS (SELECT * FROM states ${input.sourceIs === null ? sql`` : sql`WHERE source_id = ${input.sourceIs}`}),
    words AS (SELECT recipient, source_id FROM scoped WHERE state <> 'unmarked')
    SELECT count(*)::int AS interventions,
      count(*) FILTER (WHERE state = 'followed')::int AS followed,
      count(*) FILTER (WHERE state = 'overrode')::int AS overrode,
      count(*) FILTER (WHERE state = 'not_relevant_now')::int AS not_relevant_now,
      count(*) FILTER (WHERE state = 'noise')::int AS noise,
      count(*) FILTER (WHERE state = 'unmarked')::int AS unmarked,
      ${subtractionSafeColumns}
    FROM scoped`);
  const row = rows.rows[0];
  const recorded = Number(row?.interventions ?? 0) - Number(row?.unmarked ?? 0);
  return {
    interventions: Number(row?.interventions ?? 0),
    followed: Number(row?.followed ?? 0),
    overrode: Number(row?.overrode ?? 0),
    notRelevantNow: Number(row?.not_relevant_now ?? 0),
    noise: Number(row?.noise ?? 0),
    unmarked: Number(row?.unmarked ?? 0),
    recorders: Number(row?.recorders ?? 0),
    sourcesWithoutAnyOne: Number(row?.sources_without_any_one ?? 0),
    wordsWithoutLargest: recorded - Number(row?.largest_recorder_words ?? 0),
  };
};

/** "Any one person": how many recorders the minimums must survive losing (review H1). */
const LEFT_OUT = 1;

/**
 * WHETHER A PERIOD MAY PRINT — the same answer whoever reads it (review H1).
 * Every minimum must hold with any single recorder's words left out: at least
 * three other people's words, about at least three people's work, ten or more
 * of them. So a team of three never prints. The team line checks all three;
 * an author's credit is about their own work, so only the people-minimum
 * applies to it. Whichever fails, the answer is ONE generic word (review M1).
 */
export const withholdingOf = (
  aggregate: PeriodAggregate,
  checks: { readonly sources: boolean; readonly recorded: boolean },
): HintOutcomeWithholding | null => {
  const meetsMinimums =
    aggregate.interventions > 0 &&
    aggregate.recorders - LEFT_OUT >= HINT_OUTCOME_DISCLOSURE_MINIMUMS.recorders &&
    (!checks.sources || aggregate.sourcesWithoutAnyOne >= HINT_OUTCOME_DISCLOSURE_MINIMUMS.sources) &&
    (!checks.recorded || aggregate.wordsWithoutLargest >= HINT_OUTCOME_DISCLOSURE_MINIMUMS.recorded);
  return meetsMinimums ? null : "below_minimums";
};
