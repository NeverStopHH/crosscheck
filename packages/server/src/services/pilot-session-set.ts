/**
 * THE SESSION SET (1.0 spec 07 §3.6, revised §12): where an ending session's
 * row goes, and what the set holds when the report reads it.
 *
 * Split from services/pilot.ts (the writer) and services/pilot-report.ts
 * (the reader), which both passed the 800-line ceiling with the second
 * review's fixes. Nothing here reads `session_events`: the VERIFY in
 * services/pilot-report.ts's header greps this file too.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { PILOT_LEGACY_COHORT } from "@crosscheck/schema";
import type { PilotCohort } from "@crosscheck/schema";

import {
  PILOT_DISCOVERY_COHORT_SESSIONS,
  PILOT_SESSION_SET_CAP,
} from "../constants.ts";
import { pilotCounters, pilotSessions } from "../db/schema.ts";
import { COHORT_CAP } from "./pilot-label-figures.ts";
import type { Db } from "../db/client.ts";

interface Deps {
  readonly db: Db;
}

/**
 * THE COUNTERS THAT DESCRIBE THE SESSION SET rather than a day's traffic —
 * one definition, read by the report and kept from the prune.
 *
 *   refused       — a start position past PILOT_SESSION_SET_CAP (two hundred).
 *   legacyRefused — what a 0.10 hub booked under its old fifty-session cap.
 *                   Never written here. Its own name keeps it apart, because
 *                   counting it as a refusal at THIS cap made a set of fifty
 *                   read as full (second review, M2).
 *   beforeLabels  — a session that started before labels were available on
 *                   the repo: outside the set (M4), and this says how many.
 */
export const PILOT_SET_COUNTERS = {
  refused: "pilot_set_refused",
  legacyRefused: "pilot_sessions_refused",
  beforeLabels: "pilot_sessions_before_labels",
} as const;

/**
 * Which cohort a slot belongs to, or null past the set. Slots 0–49 are
 * discovery, 50–199 replication; the boundary is the constant, never a
 * literal.
 */
const cohortForSlot = (slot: number): PilotCohort | null => {
  if (slot < PILOT_DISCOVERY_COHORT_SESSIONS) {
    return "discovery";
  }
  return slot < PILOT_SESSION_SET_CAP ? "replication" : null;
};

/** What happens to one ending session's row. */
export type Placement =
  /** It already has a row: a revived session's second end, which updates the residue only. */
  | { readonly kind: "kept" }
  | { readonly kind: "slot"; readonly slot: number; readonly cohort: PilotCohort }
  /** It started before labels became available: outside the set, and counted. */
  | { readonly kind: "before_labels" }
  /** Its start position is past the cap: refused, and counted. */
  | { readonly kind: "refused" }
  | { readonly kind: "unknown_session" };

type PlacementRow = {
  readonly kept: boolean;
  readonly before_labels: boolean;
  readonly base: number;
  readonly ahead: number;
};

/**
 * A SLOT IS A START POSITION (07 §12, second review, M1 and M4): this
 * session's place, in `(started_at, id)` order, among the repo's sessions
 * that started once labels were available. The first pilot counted the rows
 * already STORED and inserted the next: two sessions ending at once both
 * took the fiftieth slot (the review measured 52 in discovery), and a short
 * session that began late took discovery from a long one that began early.
 *
 * A start position is a function of immutable data — `started_at` is
 * stamped by this hub at registration and no `agent_sessions` row is ever
 * deleted — so concurrent ends compute different slots without a lock, and
 * `pilot_sessions_repo_slot_idx` (UNIQUE) holds it at the database too.
 *
 * `base` CONTINUES A RE-ENROLMENT: slots held by rows of an earlier
 * enrolment (sessions that started before the current `pilot_labels_since`)
 * are not handed out again, so a team that leaves and comes back resumes
 * the set instead of starting a second discovery cohort. `ahead` is bounded
 * by the cap, so the count never scans more than two hundred rows.
 */
export const placeSession = async (
  deps: Deps,
  input: { readonly sessionId: string; readonly repo: string },
): Promise<Placement> => {
  const rows = await deps.db.execute<PlacementRow>(sql`
    SELECT EXISTS (SELECT 1 FROM pilot_sessions ps WHERE ps.session_id = me.id) AS kept,
           (me.started_at < ts.pilot_labels_since) IS NOT FALSE AS before_labels,
           (SELECT coalesce(max(ps.slot) + 1, 0) FROM pilot_sessions ps
              JOIN agent_sessions o ON o.id = ps.session_id
              WHERE ps.repo = ${input.repo} AND o.started_at < ts.pilot_labels_since)::int AS base,
           (SELECT count(*) FROM (
              SELECT 1 FROM agent_sessions s2
              WHERE s2.repo = ${input.repo}
                AND s2.started_at >= ts.pilot_labels_since
                AND (s2.started_at, s2.id) < (me.started_at, me.id)
              LIMIT ${PILOT_SESSION_SET_CAP}) ahead)::int AS ahead
    FROM agent_sessions me
    LEFT JOIN team_settings ts ON ts.repo = ${input.repo}
    WHERE me.id = ${input.sessionId}`);
  const row = rows.rows[0];
  if (row === undefined) {
    return { kind: "unknown_session" };
  }
  if (row.kept) {
    return { kind: "kept" };
  }
  if (row.before_labels) {
    return { kind: "before_labels" };
  }
  const slot = row.base + row.ahead;
  const cohort = cohortForSlot(slot);
  return cohort === null ? { kind: "refused" } : { kind: "slot", slot, cohort };
};

export interface SessionSet {
  readonly used: number;
  readonly cap: number;
  /** Start positions past the cap, refused and counted. */
  readonly refused: number;
  /** What a 0.10 hub refused under its old fifty-session cap — never a refusal at THIS cap (M2). */
  readonly legacyRefused: number;
  /** Sessions that started before labels were available: outside the set, counted (M4). */
  readonly beforeLabels: number;
  /** Rows in each cohort, and how many each holds when full (07 §12). */
  readonly discovery: number;
  readonly discoveryCap: number;
  readonly replication: number;
  readonly replicationCap: number;
  /** Rows a 0.10 hub wrote, before labels — in neither cohort and not in `used` (second review, H1). */
  readonly legacy: number;
  /** One epoch and at least one position: a span can be printed. */
  readonly spanned: number;
  /** More than one epoch: the counter restarted, and no span exists (PIL-7). */
  readonly restarted: number;
  /** No positioned record at all: sequence not recorded. */
  readonly notRecorded: number;
}

/** The session set, its two cohorts, and how many of its sequences can be read (PIL-7). */
export const readSessionSet = async (
  deps: Deps,
  repo: string,
): Promise<SessionSet> => {
  const [rows, counts] = await Promise.all([
    deps.db
      .select({ epochs: pilotSessions.seqEpochs, cohort: pilotSessions.cohort })
      .from(pilotSessions)
      .where(eq(pilotSessions.repo, repo)),
    deps.db
      .select({
        counter: pilotCounters.counter,
        n: sql<number>`coalesce(sum(${pilotCounters.value}), 0)::int`,
      })
      .from(pilotCounters)
      .where(
        and(
          eq(pilotCounters.repo, repo),
          inArray(pilotCounters.counter, Object.values(PILOT_SET_COUNTERS)),
        ),
      )
      .groupBy(pilotCounters.counter),
  ]);
  const counted = (name: string): number => counts.find((row) => row.counter === name)?.n ?? 0;
  const discovery = rows.filter((row) => row.cohort === "discovery").length;
  const replication = rows.filter((row) => row.cohort === "replication").length;
  return {
    // THE SET IS THE TWO COHORTS. A 0.10 row is counted apart: it was never
    // in a cohort, and counting it here would fill the set with sessions
    // nobody could label (second review, H1).
    used: discovery + replication,
    cap: PILOT_SESSION_SET_CAP,
    refused: counted(PILOT_SET_COUNTERS.refused),
    legacyRefused: counted(PILOT_SET_COUNTERS.legacyRefused),
    beforeLabels: counted(PILOT_SET_COUNTERS.beforeLabels),
    discovery,
    discoveryCap: COHORT_CAP.discovery,
    replication,
    replicationCap: COHORT_CAP.replication,
    legacy: rows.filter((row) => row.cohort === PILOT_LEGACY_COHORT).length,
    spanned: rows.filter((row) => row.epochs === 1).length,
    restarted: rows.filter((row) => (row.epochs ?? 0) > 1).length,
    notRecorded: rows.filter((row) => (row.epochs ?? 0) === 0).length,
  };
};
