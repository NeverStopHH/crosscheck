/**
 * PROOF 4'S LABELLED FIGURES (1.0 spec 07 §12) — benefit, burden, precision
 * and label coverage over one population of sessions, the reasons people
 * typed, and the two cohorts side by side.
 *
 * Split from services/pilot-report.ts, which stays the one entry point and
 * the only caller: this module is read-only, as that one is, and reads
 * neither `session_events` nor anything else of the causal skeleton (the
 * report header's VERIFY covers both files).
 *
 * An INTERVENTION is an unsolicited delivery to a session in the population;
 * a LABEL is the recipient's word about it.
 *
 *   benefit   = helpful / sessions            (per hundred)
 *   burden    = interventions / sessions      (per hundred)
 *   precision = helpful / (helpful + noise)
 *   coverage  = (helpful + noise + unclear) / interventions
 *
 * `unclear` ABSTAINS FROM PRECISION and counts toward coverage. An
 * abstention scored as a miss would make precision fall with the labelers'
 * honesty — the more often people admit they cannot tell, the worse the
 * product would look — while dropping it from coverage would hide that they
 * looked. It is printed on its own so it can be neither.
 */
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  PILOT_COHORTS,
  PILOT_LEGACY_NOISE_MARK,
  PULLED_DELIVERY_CHANNEL,
} from "@crosscheck/schema";
import type { PilotCohort, PilotInterventionLabel } from "@crosscheck/schema";

import {
  PILOT_DISCOVERY_COHORT_SESSIONS,
  PILOT_REPLICATION_COHORT_SESSIONS,
  PILOT_REPORT_MAX_LABEL_REASONS,
} from "../constants.ts";
import { PER_HUNDRED, measured, unavailable } from "./pilot-figure.ts";
import type { Figure } from "./pilot-figure.ts";
import type { Db } from "../db/client.ts";

interface Deps {
  readonly db: Db;
}

export interface LabelFigures {
  readonly sessions: number;
  readonly interventions: number;
  readonly helpful: number;
  readonly noise: number;
  readonly unclear: number;
  /** helpful + noise + unclear. */
  readonly labelled: number;
  readonly benefitPer100: Figure;
  readonly burdenPer100: Figure;
  readonly precision: Figure;
  /** Printed beside precision, always: a precision from three labels is not a result. */
  readonly labelCoverage: Figure;
}

export interface CohortFigures extends LabelFigures {
  readonly cohort: PilotCohort;
  readonly cap: number;
}

/** One sentence a person typed beside a label. The person is not carried. */
export interface LabelReason {
  readonly label: PilotInterventionLabel;
  readonly reason: string;
}

export const COHORT_CAP: Readonly<Record<PilotCohort, number>> = {
  discovery: PILOT_DISCOVERY_COHORT_SESSIONS,
  replication: PILOT_REPLICATION_COHORT_SESSIONS,
};

/**
 * The SQL that reads as noise for the NOISY-SESSIONS FLOOR: the word written
 * today and the word a 0.10 hub wrote. That floor predates the labels and
 * counts marks of either era. The labelled tally does NOT use it: an
 * `off_target` mark was the only word its era had, so it is counted apart
 * (`readLegacyNoise`) and never enters a precision denominator that could
 * not have held a `helpful` beside it (second review, H1).
 */
export const NOISE_WORDS = sql`('noise', ${PILOT_LEGACY_NOISE_MARK})`;

/** A type alias, not an interface: `db.execute<T>` wants an index-signature-compatible row. */
type LabelTally = {
  readonly sessions: number;
  readonly interventions: number;
  readonly helpful: number;
  readonly noise: number;
  readonly unclear: number;
};

/** The four figures from one tally; each says why when it cannot be a number. */
export const labelFigures = (tally: LabelTally): LabelFigures => {
  const labelled = tally.helpful + tally.noise + tally.unclear;
  const verdicts = tally.helpful + tally.noise;
  const per100 = (value: number): Figure =>
    tally.sessions === 0
      ? unavailable("no_sessions")
      : measured((value * PER_HUNDRED) / tally.sessions);
  return {
    ...tally,
    labelled,
    benefitPer100: per100(tally.helpful),
    burdenPer100: per100(tally.interventions),
    precision:
      verdicts === 0 ? unavailable("no_labels") : measured(tally.helpful / verdicts),
    labelCoverage:
      tally.interventions === 0
        ? unavailable("no_interventions")
        : measured(labelled / tally.interventions),
  };
};

/**
 * THE LABEL TALLY OVER ONE POPULATION, given as a SELECT of session ids: the
 * report's window (sessions that started in it) or one cohort (the rows of
 * `pilot_sessions` that carry it). One statement, in the database, so the
 * cost of a report does not scale with the traffic it describes.
 *
 * A LABEL IS THE RECIPIENT'S. The mark route refuses a mark from anybody but
 * the person a delivery reached, and the unique key allows one per person,
 * so a delivery carries at most one label and `labelled <= interventions`
 * holds by construction rather than by clamping.
 */
export const readLabelTally = async (deps: Deps, population: SQL): Promise<LabelTally> => {
  const rows = await deps.db.execute<LabelTally>(sql`
    WITH population AS (${population}),
    intervention AS (
      SELECT hd.id FROM hint_deliveries hd
      JOIN population p ON p.id = hd.session_id
      WHERE hd.channel <> ${PULLED_DELIVERY_CHANNEL}
    ),
    verdict AS (
      SELECT m.mark FROM pilot_marks m
      JOIN intervention i ON i.id = m.ref_id
      WHERE m.ref_kind = 'hint_delivery'
    )
    SELECT (SELECT count(*)::int FROM population) AS sessions,
           (SELECT count(*)::int FROM intervention) AS interventions,
           count(*) FILTER (WHERE mark = 'helpful')::int AS helpful,
           count(*) FILTER (WHERE mark = 'noise')::int AS noise,
           count(*) FILTER (WHERE mark = 'unclear')::int AS unclear
    FROM verdict`);
  const row = rows.rows[0];
  return {
    sessions: row?.sessions ?? 0,
    interventions: row?.interventions ?? 0,
    helpful: row?.helpful ?? 0,
    noise: row?.noise ?? 0,
    unclear: row?.unclear ?? 0,
  };
};

export const windowPopulation = (repo: string, since: Date, until: Date): SQL =>
  sql`SELECT s.id FROM agent_sessions s
    WHERE s.repo = ${repo}
      AND s.started_at >= ${since.toISOString()}::timestamptz
      AND s.started_at < ${until.toISOString()}::timestamptz`;

const cohortPopulation = (repo: string, cohort: PilotCohort): SQL =>
  sql`SELECT ps.session_id AS id FROM pilot_sessions ps
    WHERE ps.repo = ${repo} AND ps.cohort = ${cohort}`;

/**
 * THE TWO COHORTS, SIDE BY SIDE (07 §12). A cohort is its own population —
 * the fifty or hundred and fifty sessions whose rows carry the word — and no
 * window applies: the discovery cohort is frozen, and a window that cut it
 * would report a different discovery cohort every week.
 */
export const readCohorts = (deps: Deps, repo: string): Promise<readonly CohortFigures[]> =>
  Promise.all(
    PILOT_COHORTS.map(async (cohort) => ({
      cohort,
      cap: COHORT_CAP[cohort],
      ...labelFigures(await readLabelTally(deps, cohortPopulation(repo, cohort))),
    })),
  );

/**
 * THE SENTENCES PEOPLE TYPED BESIDE A LABEL, newest first and bounded, with
 * the total beside the list. The label is normalised so an older hub's word
 * reads as what it meant. No developer id and no name leave the query: the
 * sentence is a person's word about an intervention, not about a person.
 */
export const readReasons = async (
  deps: Deps,
  repo: string,
  since: Date,
  until: Date,
): Promise<{ readonly reasons: readonly LabelReason[]; readonly beyond: number }> => {
  const rows = await deps.db.execute<{ mark: string; reason: string; total: number }>(sql`
    SELECT m.mark AS mark, m.reason AS reason, count(*) OVER ()::int AS total
    FROM pilot_marks m
    JOIN hint_deliveries hd ON hd.id = m.ref_id
    JOIN agent_sessions s ON s.id = hd.session_id
    WHERE m.ref_kind = 'hint_delivery' AND m.reason IS NOT NULL
      AND s.repo = ${repo}
      AND m.created_at >= ${since.toISOString()}::timestamptz
      AND m.created_at < ${until.toISOString()}::timestamptz
    ORDER BY m.created_at DESC, m.id ASC
    LIMIT ${PILOT_REPORT_MAX_LABEL_REASONS}`);
  const reasons = rows.rows.map((row) => ({
    label: (row.mark === PILOT_LEGACY_NOISE_MARK ? "noise" : row.mark) as PilotInterventionLabel,
    reason: row.reason,
  }));
  return {
    reasons,
    beyond: Math.max(0, (rows.rows[0]?.total ?? 0) - reasons.length),
  };
};

/**
 * THE 0.10 NOISE MARKS in the window (second review, H1): `off_target` on an
 * intervention to a session that started in it. Counted — a team's earlier
 * complaints are not erased — and printed on their own line, outside
 * precision: nobody could have labelled those interventions helpful.
 */
const readLegacyNoise = async (
  deps: Deps,
  repo: string,
  since: Date,
  until: Date,
): Promise<number> => {
  const rows = await deps.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
    FROM pilot_marks m
    JOIN hint_deliveries hd ON hd.id = m.ref_id
    JOIN agent_sessions s ON s.id = hd.session_id
    WHERE m.ref_kind = 'hint_delivery' AND m.mark = ${PILOT_LEGACY_NOISE_MARK}
      AND s.repo = ${repo}
      AND s.started_at >= ${since.toISOString()}::timestamptz
      AND s.started_at < ${until.toISOString()}::timestamptz`);
  return rows.rows[0]?.n ?? 0;
};

/** The window's labelled figures, from where labels existed, and what sits beside them. */
export interface LabelledWindow {
  readonly figures: LabelFigures;
  /** The labelled population's start: the window's, or later when labels arrived later. */
  readonly labelledSince: Date;
  readonly reasons: readonly LabelReason[];
  readonly reasonsBeyondList: number;
  readonly legacyNoise: number;
}

/**
 * PROOF 4 OVER THE WINDOW, FROM WHEN LABELS EXISTED (second review, H1, M5).
 * A session that started before `labelsSince` could not be labelled helpful
 * — on a 0.10 hub the word did not exist, and on a repo enrolled today
 * nobody could label yesterday's pointers — so the population starts at the
 * later of the window's start and `labelsSince`. Counting the earlier ones
 * printed a measured 0% precision and a 0.0 benefit that were artefacts of
 * the old data, for eight weeks after an upgrade.
 */
export const readLabelledWindow = async (
  deps: Deps,
  repo: string,
  window: { readonly since: Date; readonly until: Date },
  labelsSince: Date,
): Promise<LabelledWindow> => {
  const from = labelsSince.getTime() > window.since.getTime() ? labelsSince : window.since;
  const [tally, said, legacyNoise] = await Promise.all([
    readLabelTally(deps, windowPopulation(repo, from, window.until)),
    readReasons(deps, repo, window.since, window.until),
    readLegacyNoise(deps, repo, window.since, window.until),
  ]);
  return {
    figures: labelFigures(tally),
    labelledSince: from,
    reasons: said.reasons,
    reasonsBeyondList: said.beyond,
    legacyNoise,
  };
};

/** The labelled figures of a population nobody measured: every one says so. */
export const notInstrumentedLabels = (): LabelFigures => ({
  sessions: 0,
  interventions: 0,
  helpful: 0,
  noise: 0,
  unclear: 0,
  labelled: 0,
  benefitPer100: unavailable("not_instrumented"),
  burdenPer100: unavailable("not_instrumented"),
  precision: unavailable("not_instrumented"),
  labelCoverage: unavailable("not_instrumented"),
});
