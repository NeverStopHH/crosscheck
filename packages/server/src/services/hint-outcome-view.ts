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
 * NO RANKING. Teammates are listed in name order, never by count: a list of
 * people sorted by how often their work was taken is a score, and 00 §8.5
 * bans scoring people.
 *
 * What a delivery stands at is defined once, in `outcome-population.ts`.
 */
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { HintOutcome } from "@crosscheck/schema";

import { HINT_OUTCOME_MAX_REASONS, HINT_OUTCOME_MAX_SOURCES } from "../constants.ts";
import { EMPTY_TALLY, addToTally, deliveryStates, outcomePopulationStart } from "./outcome-population.ts";
import type { DeliveryState, HintOutcomeTally } from "./outcome-population.ts";
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
  const since = outcomePopulationStart(
    new Date(now.getTime() - input.days * MS_PER_DAY),
    settings.pilotOutcomesSince,
    now,
  );
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
