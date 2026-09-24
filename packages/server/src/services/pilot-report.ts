/**
 * THE FIVE PROOFS, READ BACK (1.0 spec 07 §5).
 *
 * This module is the only reader of the pilot tables, and it is read-only:
 * nothing here writes, and nothing here decides anything a surface acts on.
 * It turns rows into numbers a person can argue with.
 *
 * EVERY FIGURE IS EITHER MEASURED OR SAYS WHY NOT. That is the one rule this
 * file exists to keep, and it is a TYPE rather than a habit: a `Figure` is
 * `{ measured, value }` or `{ unavailable, reason }`, never a bare number. A
 * zero that means "not measured" printed beside a zero that means "nothing
 * happened" is AT-9's exact confusion, and on a report whose whole purpose is
 * to say whether the product works it would be the product lying about
 * itself in its own favour.
 *
 * PROOFS 1–4 ARE JOINS AT READ TIME, and that is deliberate (§3.5): a stored
 * aggregate for a number that can be re-derived is a second definition
 * waiting to disagree with the first. Only proof 5 has a counter table,
 * because only proof 5 cannot be recomputed.
 *
 * NO PERSON APPEARS ANYWHERE IN THE OUTPUT (§8.4). There is no developer id,
 * no name and no per-developer grouping — this is reliability infrastructure,
 * not employee measurement. The only author-written text is a work-context
 * TITLE, in proof 1's list of the prior work each opened pointer named, and it
 * is framed as quoted data wherever it is rendered.
 *
 * THE AGGREGATES RUN IN THE DATABASE. A busy repo produces thousands of
 * deliveries in eight weeks; pulling them into the process to count them would
 * make the cost of a report scale with the traffic it describes.
 *
 * THE REPORT NEVER READS THE CAUSAL SKELETON, and 01a's retention registry
 * rests on that (07 §11.8): the pilot's tables are declared NON-RETAINING
 * edges to their sessions, which lets the skeleton sweep retire a measured
 * session's events. That is only safe while nothing here reads them. The one
 * pilot reader of `session_events` is `readSeqResidue` in services/pilot.ts,
 * which runs once, when the session ends or is reaped, and stores the residue
 * it needs so the report never goes back. Both halves are pinned:
 *
 * VERIFY: grep -v '^ \*' packages/server/src/services/pilot-report.ts | grep -c sessionEvents
 * PRINTS: 0
 * VERIFY: grep -c 'from(sessionEvents)' packages/server/src/services/pilot.ts
 * PRINTS: 1
 */
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { DELIVERY_CHANNELS } from "@crosscheck/schema";
import type {
  DeliveryChannel,
  PilotUnavailableReason,
} from "@crosscheck/schema";

import {
  GHOST_MIN_SHARED_TARGETS,
  PILOT_CONVERGENCE_WINDOW_HOURS,
  PILOT_MAX_SESSIONS,
  PILOT_REPORT_MAX_PRIOR_WORK,
  PILOT_REPORT_MAX_REPAIRS,
  PILOT_TARGET_FALSE_PROACTIVE_MAX_PER_100,
  PILOT_TARGET_HELPFUL_PER_100_SESSIONS,
} from "../constants.ts";
import {
  agentSessions,
  pilotAttributions,
  pilotCounters,
  pilotMarks,
  pilotSessions,
  pinFiles,
  pins,
  workContextTargets,
  workContexts,
} from "../db/schema.ts";
import { PILOT_ANSWER_SURFACES } from "./pilot.ts";
import { readTeamSettings } from "./team-settings.ts";
import type { PilotAnswerSurface } from "./pilot.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

const MS_PER_DAY = 86_400_000;
const PER_HUNDRED = 100;

export type Figure =
  | { readonly kind: "measured"; readonly value: number }
  | { readonly kind: "unavailable"; readonly reason: PilotUnavailableReason };

const measured = (value: number): Figure => ({ kind: "measured", value });
const unavailable = (reason: PilotUnavailableReason): Figure => ({
  kind: "unavailable",
  reason,
});

/** One opened pointer, named — PIL-2's whole obligation. */
export interface PriorWork {
  readonly workContextId: string;
  readonly title: string;
  /** How many distinct sessions opened a pointer to it. */
  readonly openedBySessions: number;
}

export interface ProofDuplicateWork {
  readonly surfaced: number;
  readonly opened: number;
  readonly converged: number;
  /**
   * ONE BUCKET PER CHANNEL, every channel present, `unknown` included and
   * never folded into its neighbours (PIL-1). A channel with no rows is a
   * measured zero here, because the delivery table IS instrumented — what
   * reads zero really had none.
   */
  readonly byChannel: Readonly<Record<DeliveryChannel, number>>;
  readonly priorWork: readonly PriorWork[];
  /** Opened pointers to prior work beyond the named list, counted not hidden. */
  readonly priorWorkBeyondList: number;
  /** Work contexts that duplicated a surfaced pointer nobody opened. */
  readonly openedAnyway: number;
}

export interface ProofCollisions {
  readonly tripwireFlagged: Figure;
  readonly ghostFlagged: Figure;
  readonly bothLanded: Figure;
  readonly ciRegressed: Figure;
}

/** A repaired attribution the CLI can score with one bounded git diff. */
export interface ScorableRepair {
  readonly pinId: string;
  readonly repairPinId: string;
  /** Where the broken invariant was last verified working. */
  readonly brokenCommit: string;
  /** Where a human re-verified it after the fix. */
  readonly repairCommit: string;
  /**
   * WHAT THE ANSWER NAMED: the pinned files the top session had touched —
   * the overlap that ranked it. A fix touching one of these is a hit.
   */
  readonly namedFiles: readonly string[];
}

export interface ProofAttribution {
  /** Ranked answers on recorded-break pins, every time somebody asked. */
  readonly answers: number;
  /** Distinct (pin, named session) attributions those answers made. */
  readonly attributions: number;
  /** Attributions only ever made under a coverage gap (PIL-5). */
  readonly excluded: number;
  readonly repaired: readonly ScorableRepair[];
  /** Repaired attributions beyond the diff bound, counted not dropped. */
  readonly repairedBeyondBound: number;
  readonly noRepairYet: number;
}

export interface ProofPrecision {
  readonly sessions: number;
  /** Unsolicited pointers an agent opened, per hundred sessions — a pull, not a verdict. */
  readonly openedPer100: Figure;
  readonly openedTargetPer100: number;
  readonly offTargetMarks: number;
  /** A FLOOR, never a value: marks are voluntary (§8.3). */
  readonly offTargetPer100: Figure;
  readonly offTargetCeilingPer100: number;
  readonly surfaceOkMarks: number;
}

export interface SurfaceIntegrity {
  readonly surface: PilotAnswerSurface;
  /** Null when the surface counted nothing — printed "not instrumented" (PIL-4). */
  readonly counters: Readonly<Record<string, number>> | null;
}

export interface SessionSet {
  readonly used: number;
  readonly cap: number;
  readonly refused: number;
  /** One epoch and at least one position: a span can be printed. */
  readonly spanned: number;
  /** More than one epoch: the counter restarted, and no span exists (PIL-7). */
  readonly restarted: number;
  /** No positioned record at all: sequence not recorded. */
  readonly notRecorded: number;
}

export interface PilotReport {
  readonly repo: string;
  readonly enrolled: boolean;
  readonly sinceIso: string;
  readonly untilIso: string;
  readonly days: number;
  readonly sessionSet: SessionSet;
  readonly duplicateWork: ProofDuplicateWork;
  readonly collisions: ProofCollisions;
  readonly attribution: ProofAttribution;
  readonly precision: ProofPrecision;
  readonly integrity: readonly SurfaceIntegrity[];
}

export interface ReadPilotReportInput {
  readonly repo: string;
  readonly days: number;
}

const zeroChannels = (): Record<DeliveryChannel, number> =>
  Object.fromEntries(DELIVERY_CHANNELS.map((channel) => [channel, 0])) as Record<
    DeliveryChannel,
    number
  >;

/** The pointed-at work context of a delivery, whichever ref kind it names. */
const POINTED = sql`CASE WHEN hd.ref_kind = 'work_context' THEN hd.ref_id
  ELSE (SELECT c.work_context_id FROM claims c WHERE c.id = hd.ref_id) END`;

const readDuplicateWork = async (
  deps: Deps,
  repo: string,
  since: Date,
  until: Date,
): Promise<ProofDuplicateWork> => {
  const windowed = sql`s.repo = ${repo}
    AND hd.delivered_at >= ${since.toISOString()}::timestamptz
    AND hd.delivered_at < ${until.toISOString()}::timestamptz`;

  const channels = await deps.db.execute<{
    channel: string;
    surfaced: number;
    opened: number;
  }>(sql`
    SELECT hd.channel AS channel,
           count(*)::int AS surfaced,
           count(hd.pulled_at)::int AS opened
    FROM hint_deliveries hd
    JOIN agent_sessions s ON s.id = hd.session_id
    WHERE ${windowed}
    GROUP BY hd.channel`);

  // CONVERGED: an opened pointer after which the RECEIVING session touched at
  // least GHOST_MIN_SHARED_TARGETS of the pointed work's files within
  // PILOT_CONVERGENCE_WINDOW_HOURS of opening it. OPENED ANYWAY: a receiving
  // work context that touched that many of the files of a pointer it was
  // shown and never opened, after being shown it. Both are FILE OVERLAP — the
  // sensor §8.2 names — and a target row with no `created_at` (older than the
  // column) cannot be placed in time, so it counts toward NEITHER: an
  // unplaceable row under-counts rather than inventing an order.
  const overlap = await deps.db.execute<{
    converged: number;
    opened_anyway: number;
  }>(sql`
    WITH d AS (
      SELECT hd.id AS delivery_id, hd.session_id, hd.delivered_at, hd.pulled_at,
             ${POINTED} AS pointed
      FROM hint_deliveries hd
      JOIN agent_sessions s ON s.id = hd.session_id
      WHERE ${windowed}
    ),
    shared AS (
      SELECT d.delivery_id, d.pulled_at, mine.work_context_id AS mine_context,
             count(DISTINCT mine.value)::int AS n,
             count(DISTINCT mine.value) FILTER (
               WHERE d.pulled_at IS NOT NULL
                 AND mine.created_at >= d.pulled_at
                 AND mine.created_at < d.pulled_at
                   + make_interval(hours => ${PILOT_CONVERGENCE_WINDOW_HOURS})
             )::int AS n_after_open
      FROM d
      JOIN work_contexts wc ON wc.session_id = d.session_id
      JOIN work_context_targets mine
        ON mine.work_context_id = wc.id AND mine.kind = 'file'
       AND mine.created_at >= d.delivered_at
      JOIN work_context_targets theirs
        ON theirs.work_context_id = d.pointed AND theirs.kind = 'file'
       AND theirs.value = mine.value
      WHERE d.pointed IS NOT NULL AND d.pointed <> wc.id
      GROUP BY d.delivery_id, d.pulled_at, mine.work_context_id
    )
    SELECT
      count(DISTINCT delivery_id) FILTER (
        WHERE n_after_open >= ${GHOST_MIN_SHARED_TARGETS})::int AS converged,
      count(DISTINCT mine_context) FILTER (
        WHERE pulled_at IS NULL AND n >= ${GHOST_MIN_SHARED_TARGETS})::int
        AS opened_anyway
    FROM shared`);

  const named = await deps.db.execute<{
    work_context_id: string;
    title: string;
    opened_by: number;
  }>(sql`
    SELECT wc.id AS work_context_id, wc.title AS title,
           count(DISTINCT d.session_id)::int AS opened_by
    FROM (
      SELECT hd.session_id, ${POINTED} AS pointed
      FROM hint_deliveries hd
      JOIN agent_sessions s ON s.id = hd.session_id
      WHERE ${windowed} AND hd.pulled_at IS NOT NULL
    ) d
    JOIN work_contexts wc ON wc.id = d.pointed
    GROUP BY wc.id, wc.title
    ORDER BY opened_by DESC, wc.id ASC`);

  const byChannel = zeroChannels();
  let surfaced = 0;
  let opened = 0;
  for (const row of channels.rows) {
    // A channel this build does not know is still COUNTED in the totals —
    // dropping it would make the channel buckets disagree with the sum.
    if ((DELIVERY_CHANNELS as readonly string[]).includes(row.channel)) {
      byChannel[row.channel as DeliveryChannel] += row.surfaced;
    }
    surfaced += row.surfaced;
    opened += row.opened;
  }
  const allNamed = named.rows.map((row) => ({
    workContextId: row.work_context_id,
    title: row.title,
    openedBySessions: row.opened_by,
  }));
  return {
    surfaced,
    opened,
    converged: overlap.rows[0]?.converged ?? 0,
    byChannel,
    priorWork: allNamed.slice(0, PILOT_REPORT_MAX_PRIOR_WORK),
    priorWorkBeyondList: Math.max(0, allNamed.length - PILOT_REPORT_MAX_PRIOR_WORK),
    openedAnyway: overlap.rows[0]?.opened_anyway ?? 0,
  };
};

/**
 * PROOF 2, and most of it cannot be measured on this hub yet — which the
 * figures say rather than hide.
 *
 * TRIPWIRE: a delivery on the `tripwire` channel is a collision the product
 * flagged BEFORE merge. BOTH LANDED: of those, the ones where the receiving
 * session's work and the flagged work both reached the default branch — the
 * collision really happened, it was not merely possible. §8.2: the sensor is
 * file overlap, so `flagged − both landed` is *did not both land*, never
 * *false*.
 *
 * GHOST: unavailable, and the reason is the briefing's own. A ghost line
 * repeats for as long as the overlap lasts, so the connector deliberately does
 * not book it as a delivery — one would make `hint_deliveries` claim a
 * delivery nothing will ever pull. Counting ghost flags needs a writer that
 * books the FIRST showing of each (session, other context) pair, and no such
 * writer exists; a zero here would read as "no ghost collisions".
 */
const readCollisions = async (
  deps: Deps,
  repo: string,
  since: Date,
  until: Date,
): Promise<ProofCollisions> => {
  const rows = await deps.db.execute<{
    flagged: number;
    both_landed: number;
  }>(sql`
    SELECT count(*)::int AS flagged,
           count(*) FILTER (WHERE mine.landed_at IS NOT NULL
                              AND theirs.landed_at IS NOT NULL)::int AS both_landed
    FROM hint_deliveries hd
    JOIN agent_sessions s ON s.id = hd.session_id
    JOIN work_contexts theirs ON theirs.id = hd.ref_id
    LEFT JOIN LATERAL (
      SELECT wc.landed_at FROM work_contexts wc
      WHERE wc.session_id = hd.session_id
      ORDER BY wc.created_at DESC LIMIT 1
    ) mine ON TRUE
    WHERE s.repo = ${repo}
      AND hd.channel = 'tripwire' AND hd.ref_kind = 'work_context'
      AND hd.delivered_at >= ${since.toISOString()}::timestamptz
      AND hd.delivered_at < ${until.toISOString()}::timestamptz`);
  const flagged = rows.rows[0]?.flagged ?? 0;
  return {
    tripwireFlagged: measured(flagged),
    ghostFlagged: unavailable("ghost_lines_not_recorded"),
    bothLanded:
      flagged === 0
        ? unavailable("nothing_flagged")
        : measured(rows.rows[0]?.both_landed ?? 0),
    // No rule yet says which lane's delta belongs to a collision, and 05's
    // reporter does not write to a hub in 1.0 — so this is a stated absence,
    // never a zero that would read as "no collision broke anything".
    ciRegressed: unavailable("no_ci_reporter"),
  };
};

/**
 * PROOF 3 — was the attribution right?
 *
 * ONLY RANKED ANSWERS ON RECORDED-BREAK PINS, because those are the only ones
 * that named somebody about a break somebody recorded. ONE ATTRIBUTION PER
 * (pin, named session): re-running `suspect` five times gives the same answer
 * five times, and scoring each would measure how often somebody re-ran it
 * rather than whether it was right. The answer count is kept beside it so
 * the difference stays visible.
 *
 * EXCLUDED MEANS ONLY EVER MADE UNDER A GAP (PIL-5). An attribution emitted
 * where a lane was blind should not have been emitted; scoring it as a hit or
 * a miss would launder that failure into a precision figure. If the same
 * attribution was ALSO given under full coverage, that answer is legitimate
 * and is the one scored.
 *
 * HIT / MISS IS NOT DECIDED HERE. It needs `git diff` over the fix range, and
 * the hub holds no repository — so this returns the range and the files the
 * answer named, and the CLI decides on the reader's machine.
 */
const readAttribution = async (
  deps: Deps,
  repo: string,
  since: Date,
  until: Date,
): Promise<ProofAttribution> => {
  const answers = await deps.db
    .select({
      pinId: pilotAttributions.pinId,
      topSessionId: pilotAttributions.topSessionId,
      judgeable: pilotAttributions.coverageJudgeable,
    })
    .from(pilotAttributions)
    .where(
      and(
        eq(pilotAttributions.repo, repo),
        eq(pilotAttributions.outcome, "ranked"),
        eq(pilotAttributions.falsifier, "recorded_break"),
        gte(pilotAttributions.answeredAt, since),
        lt(pilotAttributions.answeredAt, until),
      ),
    );

  const byAttribution = new Map<
    string,
    { pinId: string; topSessionId: string; judgeable: boolean }
  >();
  for (const row of answers) {
    if (row.topSessionId === null) {
      continue;
    }
    const key = JSON.stringify([row.pinId, row.topSessionId]);
    const seen = byAttribution.get(key);
    byAttribution.set(key, {
      pinId: row.pinId,
      topSessionId: row.topSessionId,
      judgeable: (seen?.judgeable ?? false) || row.judgeable,
    });
  }
  const scorable = [...byAttribution.values()].filter((row) => row.judgeable);
  const excluded = byAttribution.size - scorable.length;

  const pinIds = [...new Set(scorable.map((row) => row.pinId))];
  const [repairs, broken] =
    pinIds.length === 0
      ? [[], []]
      : await Promise.all([
          deps.db
            .select({
              repairPinId: pins.id,
              repairsPinId: pins.repairsPinId,
              repairCommit: pins.verifiedAtCommit,
            })
            .from(pins)
            .where(and(eq(pins.repo, repo), inArray(pins.repairsPinId, pinIds))),
          deps.db
            .select({ id: pins.id, commit: pins.verifiedAtCommit })
            .from(pins)
            .where(inArray(pins.id, pinIds)),
        ]);
  const brokenCommit = new Map(broken.map((row) => [row.id, row.commit]));
  const repairOf = new Map<string, { repairPinId: string; repairCommit: string }>();
  for (const row of repairs) {
    if (row.repairsPinId !== null) {
      repairOf.set(row.repairsPinId, {
        repairPinId: row.repairPinId,
        repairCommit: row.repairCommit,
      });
    }
  }

  const repaired = scorable.filter((row) => repairOf.has(row.pinId));
  const scored: ScorableRepair[] = [];
  for (const row of repaired.slice(0, PILOT_REPORT_MAX_REPAIRS)) {
    const repair = repairOf.get(row.pinId);
    const commit = brokenCommit.get(row.pinId);
    if (repair === undefined || commit === undefined) {
      continue;
    }
    const files = await deps.db
      .selectDistinct({ path: pinFiles.path })
      .from(pinFiles)
      .innerJoin(
        workContextTargets,
        and(
          eq(workContextTargets.kind, "file"),
          eq(workContextTargets.value, pinFiles.path),
        ),
      )
      .innerJoin(
        workContexts,
        eq(workContexts.id, workContextTargets.workContextId),
      )
      .where(
        and(
          eq(pinFiles.pinId, row.pinId),
          eq(workContexts.sessionId, row.topSessionId),
        ),
      );
    scored.push({
      pinId: row.pinId,
      repairPinId: repair.repairPinId,
      brokenCommit: commit,
      repairCommit: repair.repairCommit,
      namedFiles: files.map((file) => file.path).sort(),
    });
  }

  return {
    answers: answers.length,
    attributions: byAttribution.size,
    excluded,
    repaired: scored,
    repairedBeyondBound: Math.max(0, repaired.length - PILOT_REPORT_MAX_REPAIRS),
    noRepairYet: scorable.length - repaired.length,
  };
};

/**
 * PROOF 4 — proactive precision, and neither half is a human verdict.
 *
 * *Corrected against the spec's mockup, which labels the first figure
 * "helpful per 100 sessions".* §8.1 refuses exactly that word: `pulled_at` is
 * set when the MODEL calls `get_diagnosis`, so a pull is an agent opening a
 * pointer, and reporting it as "a human found this helpful" is the
 * calibration lie. The figure is "opened"; its target keeps the constant's
 * name because the target was declared before any measurement.
 *
 * `suspect` IS EXCLUDED from "opened": it is a pulled answer, not a proactive
 * one, and proof 4 is about what arrived UNASKED.
 */
const readPrecision = async (
  deps: Deps,
  repo: string,
  since: Date,
  until: Date,
): Promise<ProofPrecision> => {
  const [sessionRows, opened, marks] = await Promise.all([
    deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.repo, repo),
          gte(agentSessions.startedAt, since),
          lt(agentSessions.startedAt, until),
        ),
      ),
    deps.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n
      FROM hint_deliveries hd
      JOIN agent_sessions s ON s.id = hd.session_id
      WHERE s.repo = ${repo} AND hd.pulled_at IS NOT NULL
        AND hd.channel <> 'suspect'
        AND hd.delivered_at >= ${since.toISOString()}::timestamptz
        AND hd.delivered_at < ${until.toISOString()}::timestamptz`),
    deps.db
      .select({ mark: pilotMarks.mark, n: sql<number>`count(*)::int` })
      .from(pilotMarks)
      .where(
        and(
          eq(pilotMarks.repo, repo),
          gte(pilotMarks.createdAt, since),
          lt(pilotMarks.createdAt, until),
        ),
      )
      .groupBy(pilotMarks.mark),
  ]);
  const sessions = sessionRows[0]?.n ?? 0;
  const markCount = (mark: string): number =>
    marks.find((row) => row.mark === mark)?.n ?? 0;
  const per100 = (value: number): Figure =>
    sessions === 0
      ? unavailable("no_sessions")
      : measured((value / sessions) * PER_HUNDRED);
  const offTarget = markCount("off_target");
  return {
    sessions,
    openedPer100: per100(opened.rows[0]?.n ?? 0),
    openedTargetPer100: PILOT_TARGET_HELPFUL_PER_100_SESSIONS,
    offTargetMarks: offTarget,
    offTargetPer100: per100(offTarget),
    offTargetCeilingPer100: PILOT_TARGET_FALSE_PROACTIVE_MAX_PER_100,
    surfaceOkMarks: markCount("surface_ok"),
  };
};

/**
 * PROOF 5, one surface at a time. A surface with no counter rows is NOT
 * INSTRUMENTED — it is never printed as "missed 0" (PIL-4), because an
 * uninstrumented surface would then read exactly like a perfect one.
 */
const readIntegrity = async (
  deps: Deps,
  repo: string,
  since: Date,
): Promise<readonly SurfaceIntegrity[]> => {
  const rows = await deps.db
    .select({
      surface: pilotCounters.surface,
      counter: pilotCounters.counter,
      value: sql<number>`sum(${pilotCounters.value})::int`,
    })
    .from(pilotCounters)
    .where(
      and(
        eq(pilotCounters.repo, repo),
        gte(pilotCounters.day, since.toISOString().slice(0, 10)),
      ),
    )
    .groupBy(pilotCounters.surface, pilotCounters.counter);
  return PILOT_ANSWER_SURFACES.map((surface) => {
    const mine = rows.filter((row) => row.surface === surface);
    return {
      surface,
      counters:
        mine.length === 0
          ? null
          : Object.fromEntries(mine.map((row) => [row.counter, row.value])),
    };
  });
};

/** The 50-session set, and how many of its sequences can be read (PIL-7). */
const readSessionSet = async (
  deps: Deps,
  repo: string,
): Promise<SessionSet> => {
  const [rows, refused] = await Promise.all([
    deps.db
      .select({ epochs: pilotSessions.seqEpochs })
      .from(pilotSessions)
      .where(eq(pilotSessions.repo, repo)),
    deps.db
      .select({ n: sql<number>`coalesce(sum(${pilotCounters.value}), 0)::int` })
      .from(pilotCounters)
      .where(
        and(
          eq(pilotCounters.repo, repo),
          eq(pilotCounters.counter, "pilot_sessions_refused"),
        ),
      ),
  ]);
  return {
    used: rows.length,
    cap: PILOT_MAX_SESSIONS,
    refused: refused[0]?.n ?? 0,
    spanned: rows.filter((row) => row.epochs === 1).length,
    restarted: rows.filter((row) => (row.epochs ?? 0) > 1).length,
    notRecorded: rows.filter((row) => (row.epochs ?? 0) === 0).length,
  };
};

/** What an un-enrolled repo reports: nothing measured, and saying so. */
const notEnrolled = (): Omit<
  PilotReport,
  "repo" | "enrolled" | "sinceIso" | "untilIso" | "days"
> => ({
  sessionSet: {
    used: 0,
    cap: PILOT_MAX_SESSIONS,
    refused: 0,
    spanned: 0,
    restarted: 0,
    notRecorded: 0,
  },
  duplicateWork: {
    surfaced: 0,
    opened: 0,
    converged: 0,
    byChannel: zeroChannels(),
    priorWork: [],
    priorWorkBeyondList: 0,
    openedAnyway: 0,
  },
  collisions: {
    tripwireFlagged: unavailable("not_instrumented"),
    ghostFlagged: unavailable("not_instrumented"),
    bothLanded: unavailable("not_instrumented"),
    ciRegressed: unavailable("not_instrumented"),
  },
  attribution: {
    answers: 0,
    attributions: 0,
    excluded: 0,
    repaired: [],
    repairedBeyondBound: 0,
    noRepairYet: 0,
  },
  precision: {
    sessions: 0,
    openedPer100: unavailable("not_instrumented"),
    openedTargetPer100: PILOT_TARGET_HELPFUL_PER_100_SESSIONS,
    offTargetMarks: 0,
    offTargetPer100: unavailable("not_instrumented"),
    offTargetCeilingPer100: PILOT_TARGET_FALSE_PROACTIVE_MAX_PER_100,
    surfaceOkMarks: 0,
  },
  integrity: PILOT_ANSWER_SURFACES.map((surface) => ({
    surface,
    counters: null,
  })),
});

/**
 * The whole report for one repo over one window.
 *
 * A REPO THAT DID NOT ENROL gets an answer that says so and nothing else:
 * computing figures over a repo nobody agreed to measure would be measuring
 * it anyway, and every figure is `not_instrumented` rather than a zero.
 */
export const readPilotReport = async (
  deps: Deps,
  input: ReadPilotReportInput,
): Promise<PilotReport> => {
  const until = deps.now();
  const since = new Date(until.getTime() - input.days * MS_PER_DAY);
  const settings = await readTeamSettings(deps, input.repo);
  const base = {
    repo: input.repo,
    enrolled: settings.pilotEnrolled,
    sinceIso: since.toISOString(),
    untilIso: until.toISOString(),
    days: input.days,
  };
  if (!settings.pilotEnrolled) {
    return { ...base, ...notEnrolled() };
  }
  const [sessionSet, duplicateWork, collisions, attribution, precision, integrity] =
    await Promise.all([
      readSessionSet(deps, input.repo),
      readDuplicateWork(deps, input.repo, since, until),
      readCollisions(deps, input.repo, since, until),
      readAttribution(deps, input.repo, since, until),
      readPrecision(deps, input.repo, since, until),
      readIntegrity(deps, input.repo, since),
    ]);
  return {
    ...base,
    sessionSet,
    duplicateWork,
    collisions,
    attribution,
    precision,
    integrity,
  };
};
