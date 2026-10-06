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
import { readTeamSettings } from "./team-settings.ts";
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
  /** The pilot paused inside the window: only its enrolled time is counted (07 §13.11, review M3). */
  readonly pausedInWindow: boolean;
  readonly bySource: readonly SourceTally[];
  readonly bySourceBeyondList: number;
  readonly reasons: readonly OutcomeReason[];
  readonly reasonsBeyondList: number;
  /** Hints that pointed at the CALLER's work and that the teammate they reached followed. */
  readonly yourWork: YourWork;
}

/** The source credit: one closed month's follows of the caller's work, or why there is no number. */
export interface YourWork {
  readonly periodStartIso: string;
  readonly periodEndIso: string;
  readonly followed: number | null;
  readonly withheld: HintOutcomeWithholding | null;
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
};

type ReasonRow = {
  readonly outcome: HintOutcome;
  readonly reason: string;
  readonly source: string | null;
  readonly total: number;
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
    sources.set(key, { ...addToTally(current, row.state, row.n), source: current.source });
  }
  const total = rows.reduce((sum, row) => addToTally(sum, row.state, row.n), EMPTY_TALLY);
  return { total, sources: [...sources.values()].sort(bySourceName) };
};

const readTallies = async (
  deps: Deps,
  input: ReadMyHintOutcomesInput,
  since: Date,
): Promise<readonly TallyRow[]> => {
  const rows = await deps.db.execute<TallyRow>(sql`
    ${deliveryStates(input.repo, since, receivedBy(input.developerId))}
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
    ${deliveryStates(input.repo, since, receivedBy(input.developerId))}
    SELECT st.state AS outcome, st.reason, d.name AS source, count(*) OVER ()::int AS total
    FROM states st LEFT JOIN developers d ON d.id = st.source_id
    WHERE st.reason IS NOT NULL
    ORDER BY st.outcome_at DESC, st.id ASC
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
    return { ...stamps, followed: null, withheld: "not_recordable", reconstructed: false };
  }
  const aggregate = await readPeriodAggregate(deps.db, {
    repo: input.repo,
    from: span.from,
    until: period.end,
    who: sql`s.developer_id <> ${input.developerId}`,
    sourceIs: input.developerId,
  });
  // review M-1: a count only once, with any one person left out, three people FOLLOWED — never "followed 0"
  const withheld = withholdingOf(aggregate, { sources: false, recorded: false, followers: true });
  return {
    ...stamps,
    followed: withheld === null ? aggregate.followed : null,
    withheld,
    reconstructed: span.reconstructed,
  };
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
  const since = outcomePopulationStart(
    new Date(now.getTime() - input.days * MS_PER_DAY),
    settings.pilotOutcomesSince,
    now,
  );
  const enrolments = await readEnrolments(deps.db, input.repo);
  const [tallies, reasons, yourWork] = await Promise.all([
    readTallies(deps, input, since),
    readReasons(deps, input, since),
    readYourWork(deps, input, now, enrolments),
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
    reasons: reasons.map((row) => ({ outcome: row.outcome, reason: row.reason, source: row.source })),
    reasonsBeyondList: Math.max(0, reasonsTotal - reasons.length),
    yourWork,
  };
};
