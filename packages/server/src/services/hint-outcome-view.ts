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
 * about their own sessions.
 *
 * ONE NOISE CONCEPT. Noise is the person's label in `pilot_marks` (and the
 * 0.10 `off_target` spelling of it); an outcome is the agent's or the
 * person's word about what happened next. Per delivery the LATER of the two
 * stands, the label on a tie — it is the person's own verdict.
 *
 * NO RANKING. Teammates are listed in name order, never by count: a list of
 * people sorted by how often their work was taken is a score, and 00 §8.5
 * bans scoring people.
 */
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PULLED_DELIVERY_CHANNEL } from "@crosscheck/schema";
import type { HintOutcome } from "@crosscheck/schema";

import { HINT_OUTCOME_MAX_REASONS, HINT_OUTCOME_MAX_SOURCES } from "../constants.ts";
import { NOISE_WORDS } from "./pilot-label-figures.ts";
import { readTeamSettings } from "./team-settings.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

const MS_PER_DAY = 86_400_000;

/** What one delivery stands at: an outcome, the noise label, or nothing said. */
type DeliveryState = HintOutcome | "noise" | "unmarked";

export interface HintOutcomeTally {
  readonly received: number;
  readonly followed: number;
  readonly overrode: number;
  readonly notRelevantNow: number;
  readonly noise: number;
  readonly unmarked: number;
}

export interface SourceTally extends HintOutcomeTally {
  /** The teammate whose work the hints pointed at; null when it is not this repo's or not found. */
  readonly source: string | null;
}

export interface OutcomeReason {
  readonly outcome: HintOutcome;
  readonly reason: string;
  readonly source: string | null;
}

export interface MyHintOutcomes extends HintOutcomeTally {
  readonly repo: string;
  readonly days: number;
  readonly sinceIso: string;
  readonly untilIso: string;
  readonly bySource: readonly SourceTally[];
  readonly bySourceBeyondList: number;
  readonly reasons: readonly OutcomeReason[];
  readonly reasonsBeyondList: number;
  /** Hints that pointed at the CALLER's work and that the teammate they reached followed. */
  readonly yourWork: { readonly followed: number };
}

export interface ReadMyHintOutcomesInput {
  readonly repo: string;
  readonly developerId: string;
  readonly days: number;
}

const EMPTY_TALLY: HintOutcomeTally = {
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

/**
 * Every unasked delivery to the recipients `who` selects, on this repo, in
 * the window — with the developer whose work it pointed at and the word it
 * stands at. The source is THIS repo's: a delivery's ref is the client's own
 * word, so a pointer at another repo's work names nobody (07 §11.9).
 */
const deliveryStates = (repo: string, since: Date, who: SQL): SQL => sql`
  WITH received AS (
    SELECT hd.id, hd.ref_kind, hd.ref_id, s.developer_id AS recipient
    FROM hint_deliveries hd
    JOIN agent_sessions s ON s.id = hd.session_id
    WHERE s.repo = ${repo}
      AND ${who}
      AND hd.channel <> ${PULLED_DELIVERY_CHANNEL}
      AND hd.delivered_at >= ${since.toISOString()}::timestamptz
  ), sourced AS (
    SELECT r.*, (
      SELECT src.developer_id FROM agent_sessions src
      WHERE src.repo = ${repo} AND src.id = CASE WHEN r.ref_kind = 'work_context'
        THEN (SELECT wc.session_id FROM work_contexts wc WHERE wc.id = r.ref_id)
        ELSE (SELECT c.author_session_id FROM claims c WHERE c.id = r.ref_id) END
    ) AS source_id
    FROM received r
  ), stated AS (
    SELECT so.id, so.source_id, latest.outcome, latest.reason,
           latest.created_at AS outcome_at, m.created_at AS noise_at
    FROM sourced so
    LEFT JOIN LATERAL (
      SELECT o.outcome, o.reason, o.created_at FROM hint_outcomes o
      WHERE o.delivery_id = so.id AND o.recorded_by = so.recipient
      ORDER BY o.created_at DESC, o.id DESC LIMIT 1
    ) latest ON true
    LEFT JOIN pilot_marks m ON m.ref_kind = 'hint_delivery' AND m.ref_id = so.id
      AND m.marked_by = so.recipient AND m.mark IN ${NOISE_WORDS}
  ), states AS (
    SELECT id, source_id, outcome_at,
      CASE WHEN noise_at IS NOT NULL AND (outcome_at IS NULL OR noise_at >= outcome_at) THEN 'noise'
           WHEN outcome IS NOT NULL THEN outcome
           ELSE 'unmarked' END AS state,
      CASE WHEN noise_at IS NOT NULL AND (outcome_at IS NULL OR noise_at >= outcome_at) THEN NULL
           ELSE reason END AS reason
    FROM stated
  )`;

type TallyRow = {
  readonly source_id: string | null;
  readonly source: string | null;
  readonly state: DeliveryState;
  readonly n: number;
};

type ReasonRow = {
  readonly outcome: HintOutcome;
  readonly reason: string;
  readonly source: string | null;
  readonly total: number;
};

const added = (tally: HintOutcomeTally, state: DeliveryState, n: number): HintOutcomeTally => {
  const field = TALLY_FIELD[state];
  return { ...tally, received: tally.received + n, [field]: tally[field] + n };
};

const bySourceName = (left: SourceTally, right: SourceTally): number =>
  left.source === null ? 1 : right.source === null ? -1 : left.source.localeCompare(right.source);

const foldTallies = (
  rows: readonly TallyRow[],
): { readonly total: HintOutcomeTally; readonly sources: readonly SourceTally[] } => {
  const sources = new Map<string, SourceTally>();
  for (const row of rows) {
    const key = row.source_id ?? "";
    const current = sources.get(key) ?? { source: row.source, ...EMPTY_TALLY };
    sources.set(key, { ...added(current, row.state, row.n), source: current.source });
  }
  const total = rows.reduce((sum, row) => added(sum, row.state, row.n), EMPTY_TALLY);
  return { total, sources: [...sources.values()].sort(bySourceName) };
};

const readTallies = async (
  deps: Deps,
  input: ReadMyHintOutcomesInput,
  since: Date,
): Promise<readonly TallyRow[]> => {
  const rows = await deps.db.execute<TallyRow>(sql`
    ${deliveryStates(input.repo, since, sql`s.developer_id = ${input.developerId}`)}
    SELECT st.source_id, d.name AS source, st.state, count(*)::int AS n
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
    ${deliveryStates(input.repo, since, sql`s.developer_id = ${input.developerId}`)}
    SELECT st.state AS outcome, st.reason, d.name AS source, count(*) OVER ()::int AS total
    FROM states st LEFT JOIN developers d ON d.id = st.source_id
    WHERE st.reason IS NOT NULL
    ORDER BY st.outcome_at DESC, st.id ASC
    LIMIT ${HINT_OUTCOME_MAX_REASONS}`);
  return rows.rows;
};

/** How often teammates followed hints that pointed at the caller's work — one count, nothing else. */
const readFollowedWork = async (
  deps: Deps,
  input: ReadMyHintOutcomesInput,
  since: Date,
): Promise<number> => {
  const rows = await deps.db.execute<{ n: number }>(sql`
    ${deliveryStates(input.repo, since, sql`s.developer_id <> ${input.developerId}`)}
    SELECT count(*)::int AS n FROM states st
    WHERE st.source_id = ${input.developerId} AND st.state = 'followed'`);
  return Number(rows.rows[0]?.n ?? 0);
};

export const readMyHintOutcomes = async (
  deps: Deps,
  input: ReadMyHintOutcomesInput,
): Promise<MyHintOutcomes | { readonly refusal: "not_enrolled" }> => {
  const settings = await readTeamSettings(deps, input.repo);
  if (!settings.pilotEnrolled) {
    return { refusal: "not_enrolled" };
  }
  const now = deps.now();
  const since = new Date(now.getTime() - input.days * MS_PER_DAY);
  const [tallies, reasons, followedWork] = await Promise.all([
    readTallies(deps, input, since),
    readReasons(deps, input, since),
    readFollowedWork(deps, input, since),
  ]);
  const { total, sources } = foldTallies(tallies);
  const reasonsTotal = Number(reasons[0]?.total ?? 0);
  return {
    repo: input.repo,
    days: input.days,
    sinceIso: since.toISOString(),
    untilIso: now.toISOString(),
    ...total,
    bySource: sources.slice(0, HINT_OUTCOME_MAX_SOURCES),
    bySourceBeyondList: Math.max(0, sources.length - HINT_OUTCOME_MAX_SOURCES),
    reasons: reasons.map((row) => ({ outcome: row.outcome, reason: row.reason, source: row.source })),
    reasonsBeyondList: Math.max(0, reasonsTotal - reasons.length),
    yourWork: { followed: followedWork },
  };
};
