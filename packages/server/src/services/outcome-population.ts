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
 * ONLY WHAT A PERSON CONFIRMED (human provenance §5). Every word read below is
 * `human_passkey_confirmed`: an agent's or a terminal's word is a draft and
 * never a row here, and a row from before 0.11 is `unknown_legacy` and is
 * left out — `--mine` counts those apart (hint-outcome-view.ts).
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
import { isHumanRow } from "./human-provenance.ts";
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
  /** Bounds an upgrade inferred from what was recorded (review M-3), not a toggle's instant. */
  readonly reconstructed: boolean;
}

type EnrolmentRow = {
  readonly started_at: string | Date;
  readonly ended_at: string | Date | null;
  readonly reconstructed: boolean;
};

/** The repo's enrolled intervals, oldest first. */
export const readEnrolments = async (db: Db, repo: string): Promise<readonly Enrolment[]> => {
  const rows = await db.execute<EnrolmentRow>(sql`
    SELECT started_at, ended_at, reconstructed FROM pilot_enrolments WHERE repo = ${repo} ORDER BY started_at`);
  return rows.rows.map((row) => ({
    start: new Date(row.started_at),
    end: row.ended_at === null ? null : new Date(row.ended_at),
    reconstructed: row.reconstructed,
  }));
};

/** The enrolled part of a window: where counting starts, and whether the pilot paused after that. */
export interface EnrolledSpan {
  readonly from: Date;
  readonly paused: boolean;
  /** Some of it is an interval an upgrade reconstructed — every line counted over it says so (M-3). */
  readonly reconstructed: boolean;
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
  // A pause is the first overlapping interval ending inside the window. A second interval
  // can only start after the first ended, so "two intervals" is never true without it —
  // the redundant disjunct was survivor R4, an equivalent mutant, and is gone.
  const endsEarly = first.end !== null && first.end.getTime() < end.getTime();
  return {
    from,
    paused: endsEarly,
    reconstructed: overlapping.some((enrolment) => enrolment.reconstructed),
  };
};

/** Only what existed before `until` — a frozen period's state at its end; null is now. */
const before = (column: SQL, until: Date | null): SQL =>
  until === null ? sql`` : sql`AND ${column} < ${until.toISOString()}::timestamptz`;

/**
 * WHICH POINTERS A PERIOD COUNTS. A CLOSED month (`until` set) counts a pointer
 * only in the month of its FIRST countable delivery, so a twin that arrives
 * next month never counts the same intervention twice (§13.12 probe E). The
 * person's own ROLLING window (`until` null) counts any pointer with a
 * delivery inside it, so a word just said about today's twin of an old
 * pointer shows at once (§13.13 LOW-2, P5).
 */
const rollingWindow = (since: Date, until: Date | null): SQL =>
  until === null ? sql`AND hd.delivered_at >= ${since.toISOString()}::timestamptz` : sql``;

/**
 * A WORD CONFIRMED LATE (human provenance; review M6): the recipient said a
 * word about this pointer inside [since, until) — a passkey confirmation's
 * instant — although the pointer's first delivery is older. Drafts make that
 * lag structural, so a closed period counts such a pointer too, marked late,
 * apart from its own interventions: in the month the word was CONFIRMED,
 * never re-opening the month the hint was delivered in.
 */
const saidInPeriod = (since: Date, until: Date): SQL => {
  const within = (column: SQL): SQL =>
    sql`${column} >= ${since.toISOString()}::timestamptz AND ${column} < ${until.toISOString()}::timestamptz`;
  return sql`EXISTS (
    SELECT 1 FROM hint_outcomes lo JOIN hint_deliveries lod ON lod.id = lo.delivery_id
    WHERE lod.session_id = hd.session_id AND lod.ref_id = hd.ref_id AND lo.recorded_by = s.developer_id
      AND ${within(sql`lo.created_at`)}
    UNION ALL
    SELECT 1 FROM pilot_marks lm JOIN hint_deliveries lmd ON lmd.id = lm.ref_id
    WHERE lm.ref_kind = 'hint_delivery' AND lmd.session_id = hd.session_id AND lmd.ref_id = hd.ref_id
      AND lm.marked_by = s.developer_id AND ${within(sql`lm.created_at`)}
    UNION ALL
    SELECT 1 FROM noise_reassertions lr JOIN hint_deliveries lrd ON lrd.id = lr.delivery_id
    WHERE lrd.session_id = hd.session_id AND lrd.ref_id = hd.ref_id AND lr.marked_by = s.developer_id
      AND ${within(sql`lr.created_at`)})`;
};

const closedMonthStart = (since: Date, until: Date | null): SQL =>
  until === null
    ? sql``
    : sql`HAVING min(hd.delivered_at) >= ${since.toISOString()}::timestamptz OR ${saidInPeriod(since, until)}`;

/** Whether a pointer is a late one in a closed period: first delivered before it. */
const lateColumn = (since: Date, until: Date | null): SQL =>
  until === null ? sql`false` : sql`min(hd.delivered_at) < ${since.toISOString()}::timestamptz`;

/**
 * Every unasked intervention — one pointer in one session — to the recipients
 * `who` selects, on this repo, delivered from `since` (and before `until`,
 * when given), with its recipient, the developer whose work it pointed at, and
 * the word it stands at, as of `until` when given. The source is THIS repo's:
 * a delivery's ref is the client's own word, so a pointer at another repo's
 * work names nobody (07 §11.9).
 */
export const deliveryStates = (
  repo: string,
  since: Date,
  who: SQL,
  until: Date | null,
  /** The read instant: a word counts only if its passkey stands then (human provenance H1). */
  at: Date,
): SQL => sql`
  WITH received AS (
    SELECT min(hd.id) AS id, hd.session_id, min(hd.ref_kind) AS ref_kind, hd.ref_id, s.developer_id AS recipient,
      ${lateColumn(since, until)} AS late
    FROM hint_deliveries hd
    JOIN agent_sessions s ON s.id = hd.session_id
    WHERE s.repo = ${repo}
      AND ${who}
      AND hd.channel <> ${PULLED_DELIVERY_CHANNEL}
      AND ${whileEnrolled(repo, sql`hd.delivered_at`)}
      ${before(sql`hd.delivered_at`, until)}
      ${before(sql`COALESCE(hd.ingested_at, hd.delivered_at)`, until)}
      ${rollingWindow(since, until)}
    GROUP BY hd.session_id, hd.ref_id, s.developer_id
    ${closedMonthStart(since, until)}
  ), sourced AS (
    SELECT r.*, (
      SELECT src.developer_id FROM agent_sessions src
      WHERE src.repo = ${repo} AND src.id = CASE WHEN r.ref_kind = 'work_context'
        THEN (SELECT wc.session_id FROM work_contexts wc WHERE wc.id = r.ref_id)
        ELSE (SELECT c.author_session_id FROM claims c WHERE c.id = r.ref_id) END
    ) AS source_id
    FROM received r
  ), labelled AS (
    -- 07 §13.14 (round-6 HIGH-1): the person's newest LABEL on the pointer — noise, noise said
    -- again, or helpful — read on its own axis
    SELECT so.*, lab.word AS label_word, lab.reason AS label_reason, lab.at AS label_at, lab.id AS label_id,
      lab.reasserted AS label_reasserted
    FROM sourced so
    LEFT JOIN LATERAL (
      SELECT l.word, l.reason, l.at, l.id, l.reasserted FROM (
        -- round-6 LOW-6: each label's own sentence, the person's alone (marked_by = the recipient)
        SELECT 'noise' AS word, m.reason AS reason, m.created_at AS at, m.id, false AS reasserted FROM pilot_marks m
        JOIN hint_deliveries md ON md.id = m.ref_id
        WHERE m.ref_kind = 'hint_delivery' AND md.session_id = so.session_id AND md.ref_id = so.ref_id
          AND m.marked_by = so.recipient AND m.mark IN ${NOISE_WORDS} AND ${isHumanRow("m", at)}
          ${before(sql`m.created_at`, until)}
        UNION ALL
        -- review H-B: the person saying noise again is a row of its own, read before the month's end too —
        -- with the sentence said with it, which --mine reads (round-5 LOW-6)
        SELECT 'noise', r.reason, r.created_at, r.id, true FROM noise_reassertions r
        JOIN hint_deliveries rd ON rd.id = r.delivery_id
        WHERE rd.session_id = so.session_id AND rd.ref_id = so.ref_id
          AND r.marked_by = so.recipient AND ${isHumanRow("r", at)} ${before(sql`r.created_at`, until)}
        UNION ALL
        SELECT 'helpful', h.reason, h.created_at, h.id, false FROM pilot_marks h
        JOIN hint_deliveries hd2 ON hd2.id = h.ref_id
        WHERE h.ref_kind = 'hint_delivery' AND hd2.session_id = so.session_id AND hd2.ref_id = so.ref_id
          AND h.marked_by = so.recipient AND h.mark = 'helpful' AND ${isHumanRow("h", at)}
          ${before(sql`h.created_at`, until)}
      ) l
      ORDER BY l.at DESC, l.id DESC LIMIT 1
    ) lab ON true
  ), stated AS (
    SELECT la.id, la.recipient, la.source_id, la.late, la.label_word, la.label_reason, la.label_at,
           said.word, said.reason, said.at AS outcome_at, said.reasserted
    FROM labelled la
    LEFT JOIN LATERAL (
      SELECT spoken.word, spoken.reason, spoken.at, spoken.reasserted FROM (
        -- every word counted here is the person's own (human provenance, J8): 07 §13.12's agent
        -- channel and its ranking are retired (review M1)
        SELECT o.outcome AS word, o.reason, o.created_at AS at, o.id, false AS is_label, false AS reasserted
        FROM hint_outcomes o
        JOIN hint_deliveries od ON od.id = o.delivery_id
        WHERE od.session_id = la.session_id AND od.ref_id = la.ref_id
          AND o.recorded_by = la.recipient AND ${isHumanRow("o", at)} ${before(sql`o.created_at`, until)}
        UNION ALL
        -- (a) the person's noise competes only while it is their newest label — a newer helpful cancels
        -- it — and only the newest noise ever could: helpful itself never competes with an outcome
        SELECT 'noise', la.label_reason, la.label_at, la.label_id, true, la.label_reasserted
        WHERE la.label_word = 'noise'
      ) spoken
      -- the person's newest word, the label on a tie (D-O7)
      ORDER BY spoken.at DESC, spoken.is_label DESC, spoken.id DESC LIMIT 1
    ) said ON true
  ), states AS (
    SELECT id, recipient, source_id, outcome_at, late,
      COALESCE(word, 'unmarked') AS state,
      reason,
      COALESCE(reasserted, false) AS reasserted,
      -- the person's newest label is helpful: read by the person's own view alone, beside the
      -- buckets — the team line and the credit never select it (round-6 HIGH-1, the helpful line)
      COALESCE(label_word = 'helpful', false) AS helpful_label,
      -- round-6 LOW-6: a helpful label's own sentence is the person's "and why", on the label axis
      -- beside the outcome's reason; the person's own view alone reads it, as it reads helpful_label
      CASE WHEN label_word = 'helpful' THEN label_reason END AS helpful_reason,
      CASE WHEN label_word = 'helpful' THEN label_at END AS helpful_at
    FROM stated
    -- a late pointer counts only by the word that stands on it, and only when that word was
    -- confirmed inside this period (review M6)
    WHERE NOT late OR (word IS NOT NULL AND outcome_at >= ${since.toISOString()}::timestamptz)
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
  /** People whose word on at least one intervention stands at followed (review M-1). */
  readonly followers: number;
  /** The fewest distinct people's work the words cover once any one recorder's words are left out. */
  readonly sourcesWithoutAnyOne: number;
  /** The words left once the recorder who said most is left out — the dominance rule. */
  readonly wordsWithoutLargest: number;
  /**
   * Words CONFIRMED in this period about hints of an earlier one (review M6),
   * apart from the period's own interventions and counts, and inside every
   * minimum above: they are people's words this period discloses.
   */
  readonly late: LateCounts;
}

/** The words a period carries late, by what they stand at. */
export interface LateCounts {
  readonly followed: number;
  readonly overrode: number;
  readonly notRelevantNow: number;
  readonly noise: number;
}

type AggregateRow = {
  readonly interventions: number;
  readonly followed: number;
  readonly overrode: number;
  readonly not_relevant_now: number;
  readonly noise: number;
  readonly unmarked: number;
  readonly recorders: number;
  readonly followers: number;
  readonly sources_without_any_one: number;
  readonly largest_recorder_words: number;
  readonly words: number;
  readonly late_followed: number;
  readonly late_overrode: number;
  readonly late_not_relevant_now: number;
  readonly late_noise: number;
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
    /** When it is read: a word counts only if the passkey that confirmed it stands then (H1). */
    readonly at: Date;
  },
): Promise<PeriodAggregate> => {
  const rows = await db.execute<AggregateRow>(sql`
    ${deliveryStates(input.repo, input.from, input.who, input.until, input.at)},
    scoped AS (SELECT * FROM states ${input.sourceIs === null ? sql`` : sql`WHERE source_id = ${input.sourceIs}`}),
    words AS (SELECT recipient, source_id FROM scoped WHERE state <> 'unmarked')
    SELECT count(*) FILTER (WHERE NOT late)::int AS interventions,
      count(*) FILTER (WHERE NOT late AND state = 'followed')::int AS followed,
      count(*) FILTER (WHERE NOT late AND state = 'overrode')::int AS overrode,
      count(*) FILTER (WHERE NOT late AND state = 'not_relevant_now')::int AS not_relevant_now,
      count(*) FILTER (WHERE NOT late AND state = 'noise')::int AS noise,
      count(*) FILTER (WHERE NOT late AND state = 'unmarked')::int AS unmarked,
      count(*) FILTER (WHERE late AND state = 'followed')::int AS late_followed,
      count(*) FILTER (WHERE late AND state = 'overrode')::int AS late_overrode,
      count(*) FILTER (WHERE late AND state = 'not_relevant_now')::int AS late_not_relevant_now,
      count(*) FILTER (WHERE late AND state = 'noise')::int AS late_noise,
      count(DISTINCT recipient) FILTER (WHERE state = 'followed')::int AS followers,
      (SELECT count(*) FROM words)::int AS words,
      ${subtractionSafeColumns}
    FROM scoped`);
  const row = rows.rows[0];
  const recorded = Number(row?.words ?? 0);
  return {
    interventions: Number(row?.interventions ?? 0),
    followed: Number(row?.followed ?? 0),
    overrode: Number(row?.overrode ?? 0),
    notRelevantNow: Number(row?.not_relevant_now ?? 0),
    noise: Number(row?.noise ?? 0),
    unmarked: Number(row?.unmarked ?? 0),
    recorders: Number(row?.recorders ?? 0),
    followers: Number(row?.followers ?? 0),
    sourcesWithoutAnyOne: Number(row?.sources_without_any_one ?? 0),
    wordsWithoutLargest: recorded - Number(row?.largest_recorder_words ?? 0),
    late: {
      followed: Number(row?.late_followed ?? 0),
      overrode: Number(row?.late_overrode ?? 0),
      notRelevantNow: Number(row?.late_not_relevant_now ?? 0),
      noise: Number(row?.late_noise ?? 0),
    },
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
 * applies to it — and it is counted over the people who FOLLOWED (review
 * M-1): a credit of "followed 0" from four people who each overrode is four
 * verdicts in one number, and so is "followed 3" from three followers beside
 * one who overrode. Whichever fails, the answer is ONE generic word (review M1).
 */
export const withholdingOf = (
  aggregate: PeriodAggregate,
  checks: { readonly sources: boolean; readonly recorded: boolean; readonly followers: boolean },
): HintOutcomeWithholding | null => {
  const meetsMinimums =
    aggregate.interventions > 0 &&
    aggregate.recorders - LEFT_OUT >= HINT_OUTCOME_DISCLOSURE_MINIMUMS.recorders &&
    (!checks.followers || aggregate.followers - LEFT_OUT >= HINT_OUTCOME_DISCLOSURE_MINIMUMS.recorders) &&
    (!checks.sources || aggregate.sourcesWithoutAnyOne >= HINT_OUTCOME_DISCLOSURE_MINIMUMS.sources) &&
    (!checks.recorded || aggregate.wordsWithoutLargest >= HINT_OUTCOME_DISCLOSURE_MINIMUMS.recorded);
  return meetsMinimums ? null : "below_minimums";
};
