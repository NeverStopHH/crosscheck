/**
 * TEAM-level settings for the regression guard (regression-guard Stage 1).
 *
 * WHY THESE TWO ARE SETTINGS AND NOT BEHAVIOUR. Both were decided in a
 * three-person frame, and crosscheck is a product for many teams:
 *
 *   - WHO MAY PIN. The default is "anyone pins anything", which is right at
 *     n=3, where social visibility beats permission machinery and every pin
 *     carries its author's name in `status`. At n=30 the same default rots:
 *     pins appear on code the pinner has never opened, with no findable
 *     owner. `touched_files` is the other setting — you may pin files your
 *     own sessions have actually touched in the window — enforceable from
 *     data the hub already holds, and never a hard block on anything else.
 *   - WHETHER `suspect` NAMES SESSIONS. The default is "sessions", which is
 *     what makes the feature useful. It is a setting because in Germany
 *     tooling from which individual performance or behaviour data can be
 *     derived is mitbestimmungspflichtig (works council) and engages the
 *     GDPR; a team that must switch attribution off should not have to
 *     uninstall the product to do it. `counts_only` answers with counts and
 *     no rows.
 *
 * ABSENT ROW MEANS DEFAULTS, which is why there is no bootstrap INSERT: a
 * hub that has never been configured behaves exactly like one configured
 * with the defaults, and `status` prints the effective values either way, so
 * "what is this team set to" never depends on knowing whether a row exists.
 */
import { randomUUID } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";
import {
  TEAM_PIN_POLICIES,
  TEAM_SUSPECT_ATTRIBUTIONS,
} from "@crosscheck/schema";
import type { TeamPinPolicy, TeamSuspectAttribution } from "@crosscheck/schema";

import { pilotEnrolments, teamSettings } from "../db/schema.ts";
import type { Db, DbExecutor } from "../db/client.ts";
import type { Clock } from "../types.ts";

/**
 * The vocabulary lives in @crosscheck/schema, where both sides of the wire
 * can read it: the CLI prints the effective values and the hub stores them.
 * Re-exported here so a caller of this service has one import, not two.
 */
export { TEAM_PIN_POLICIES, TEAM_SUSPECT_ATTRIBUTIONS };
export type { TeamPinPolicy, TeamSuspectAttribution };

export interface TeamSettingsView {
  readonly repo: string;
  readonly pinPolicy: TeamPinPolicy;
  readonly suspectAttribution: TeamSuspectAttribution;
  /**
   * IS THIS REPO IN THE PILOT (07 §3.6). False unless somebody enrolled it,
   * and false for a repo nobody has configured at all — the absent row and
   * the column default are the same answer on purpose.
   */
  readonly pilotEnrolled: boolean;
  /**
   * WHEN LABELS BECAME AVAILABLE (07 §12, second review): the moment
   * enrolment last turned on. The labelled figures and the cohorts count
   * only sessions that started at or after it. Null until first enrolled.
   */
  readonly pilotLabelsSince: string | null;
  /**
   * WHEN OUTCOMES FIRST BECAME RECORDABLE (07 §13.9): the first enrolment,
   * never restamped (§13.11, review M3) — when the repo was in the pilot since
   * is `pilot_enrolments`. Null until first enrolled.
   */
  readonly pilotOutcomesSince: string | null;
  /** Null while the repo has never been configured — the defaults are in use. */
  readonly updatedAt: string | null;
}

/** Nick's decisions for the trial, and the shipped defaults for everyone. */
export const DEFAULT_TEAM_SETTINGS = {
  pinPolicy: "anyone",
  suspectAttribution: "sessions",
  // OFF, and it is the one default that must never be flipped by a shipped
  // change: enrolling a repo is a team's decision to be measured, and a
  // product that enrolled people by default would be collecting the pilot's
  // numbers from teams that never agreed to be in it.
  pilotEnrolled: false,
} as const satisfies {
  readonly pinPolicy: TeamPinPolicy;
  readonly suspectAttribution: TeamSuspectAttribution;
  readonly pilotEnrolled: boolean;
};

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

/** The answer for a repo nobody configured: the defaults, and no instant at all. */
const defaultSettingsFor = (repo: string): TeamSettingsView => ({
  repo,
  pinPolicy: DEFAULT_TEAM_SETTINGS.pinPolicy,
  suspectAttribution: DEFAULT_TEAM_SETTINGS.suspectAttribution,
  pilotEnrolled: DEFAULT_TEAM_SETTINGS.pilotEnrolled,
  pilotLabelsSince: null,
  pilotOutcomesSince: null,
  updatedAt: null,
});

export const readTeamSettings = async (
  deps: Deps,
  repo: string,
): Promise<TeamSettingsView> => {
  const rows = await deps.db
    .select({
      pinPolicy: teamSettings.pinPolicy,
      suspectAttribution: teamSettings.suspectAttribution,
      pilotEnrolled: teamSettings.pilotEnrolled,
      pilotLabelsSince: teamSettings.pilotLabelsSince,
      pilotOutcomesSince: teamSettings.pilotOutcomesSince,
      updatedAt: teamSettings.updatedAt,
    })
    .from(teamSettings)
    .where(eq(teamSettings.repo, repo))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return defaultSettingsFor(repo);
  }
  return {
    repo,
    pinPolicy: row.pinPolicy,
    suspectAttribution: row.suspectAttribution,
    pilotEnrolled: row.pilotEnrolled,
    pilotLabelsSince: row.pilotLabelsSince?.toISOString() ?? null,
    pilotOutcomesSince: row.pilotOutcomesSince?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
};

/**
 * THE INSTANT LABELS (AND, 07 §13.9, OUTCOMES) BECAME AVAILABLE, after this
 * write — `stored` is the one being carried. Stamped NOW when
 * enrolment turns on — a re-enrolment is a new consent, and the sessions of
 * the gap between were never measured — and otherwise kept as it was,
 * leaving included: a team that leaves keeps the record of when it joined.
 */
const sinceAfter = (stored: string | null, wasEnrolled: boolean, nextEnrolled: boolean, now: Date): Date | null => {
  if (nextEnrolled && !wasEnrolled) {
    return now;
  }
  return stored === null ? null : new Date(stored);
};

type SettingsLockRow = {
  readonly pin_policy: TeamPinPolicy;
  readonly suspect_attribution: TeamSuspectAttribution;
  readonly pilot_enrolled: boolean;
  readonly pilot_labels_since: string | Date | null;
  readonly pilot_outcomes_since: string | Date | null;
  readonly updated_at: string | Date;
};

const isoOrNull = (value: string | Date | null): string | null => (value === null ? null : new Date(value).toISOString());

/**
 * WHAT A WRITE STARTS FROM — the whole settings row, read under its lock
 * inside the write's own transaction (reviews LOW, round-5 LOW-1): two writes
 * at once each start from what the other committed, never from a read made
 * before either began — a write naming no enrolment once carried a stale
 * `pilot_labels_since` (null) over the toggle beside it (P4). PGlite has one
 * connection, so the lock is pinned by the SQL this issues, not by a race.
 */
export const readSettingsForUpdate = async (tx: DbExecutor, repo: string): Promise<TeamSettingsView> => {
  const rows = await tx.execute<SettingsLockRow>(
    sql`SELECT pin_policy, suspect_attribution, pilot_enrolled, pilot_labels_since, pilot_outcomes_since, updated_at FROM team_settings WHERE repo = ${repo} FOR UPDATE`,
  );
  const row = rows.rows[0];
  if (row === undefined) {
    return defaultSettingsFor(repo);
  }
  return {
    repo,
    pinPolicy: row.pin_policy,
    suspectAttribution: row.suspect_attribution,
    pilotEnrolled: row.pilot_enrolled,
    pilotLabelsSince: isoOrNull(row.pilot_labels_since),
    pilotOutcomesSince: isoOrNull(row.pilot_outcomes_since),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
};

/**
 * WHEN OUTCOMES FIRST BECAME RECORDABLE, after this write (07 §13.11, review
 * M3): the first enrolment's instant, kept for ever. A re-enrolment opens a
 * new interval instead — restamping here erased everything recorded before it.
 */
const firstEnrolledAt = (stored: string | null, nextEnrolled: boolean, now: Date): Date | null => {
  if (stored !== null) {
    return new Date(stored);
  }
  return nextEnrolled ? now : null;
};

/**
 * Opens an interval when enrolment turns on, closes the open one when it turns off — never rewrites one.
 * No conflict is swallowed: a second open interval is the partial unique index's to refuse, loudly.
 */
const recordEnrolmentChange = async (
  db: DbExecutor,
  repo: string,
  wasEnrolled: boolean,
  isEnrolled: boolean,
  now: Date,
): Promise<void> => {
  if (isEnrolled && !wasEnrolled) {
    await db.insert(pilotEnrolments).values({ id: `pe_${randomUUID()}`, repo, startedAt: now, endedAt: null });
  }
  if (!isEnrolled && wasEnrolled) {
    // round-6 LOW-2: a wall clock that stepped back past the interval's start closes it at its start —
    // zero length, never ending before it began (the CHECK refused that, and leaving was a 500)
    await db
      .update(pilotEnrolments)
      .set({ endedAt: sql`GREATEST(${now.toISOString()}::timestamptz, ${pilotEnrolments.startedAt})` })
      .where(and(eq(pilotEnrolments.repo, repo), isNull(pilotEnrolments.endedAt)));
  }
};

/**
 * ANOTHER ENROLMENT WON THE RACE (round-5 LOW-10). Two first enrolments of a
 * repo with no settings row yet have no row to lock, so both open an interval;
 * the partial unique index refuses the second. That is the right outcome — the
 * repo is enrolled once — and the loser is told so in a sentence, not a 500.
 */
export class ConcurrentEnrolmentError extends Error {
  constructor() {
    super("another enrolment of this repo landed at the same moment");
    this.name = "ConcurrentEnrolmentError";
  }
}

const ONE_OPEN_INDEX = "pilot_enrolments_one_open_idx";
const UNIQUE_VIOLATION = "23505";

/** Whether an error, or one it wraps, is the one-open-interval index refusing a second open interval. */
const isSecondOpenInterval = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const fields = error as { code?: unknown; constraint?: unknown; cause?: unknown };
  return (fields.code === UNIQUE_VIOLATION && fields.constraint === ONE_OPEN_INDEX) || isSecondOpenInterval(fields.cause);
};

export interface WriteTeamSettingsInput {
  readonly repo: string;
  readonly pinPolicy?: TeamPinPolicy;
  readonly suspectAttribution?: TeamSuspectAttribution;
  readonly pilotEnrolled?: boolean;
}

/**
 * Upsert, PARTIAL on purpose: a hub operator changing the attribution switch
 * must not silently reset the pin policy to a default they never chose.
 * Omitted fields keep whatever is stored, or the default if nothing is.
 */
export const writeTeamSettings = async (
  deps: Deps,
  input: WriteTeamSettingsInput,
): Promise<TeamSettingsView> => {
  try {
    return await writeSettingsOnce(deps, input);
  } catch (error) {
    throw isSecondOpenInterval(error) ? new ConcurrentEnrolmentError() : error;
  }
};

const writeSettingsOnce = async (deps: Deps, input: WriteTeamSettingsInput): Promise<TeamSettingsView> => {
  const next = await deps.db.transaction(async (tx) => {
    // reviews LOW, round-5 LOW-1: the whole row this write starts from is read under its lock,
    // here, and `now` is taken after the lock, so no instant predates the write it is part of
    const current = await readSettingsForUpdate(tx, input.repo);
    const now = deps.now();
    const wasEnrolled = current.pilotEnrolled;
    const pilotEnrolled = input.pilotEnrolled ?? wasEnrolled;
    const row = {
      repo: input.repo,
      pinPolicy: input.pinPolicy ?? current.pinPolicy,
      suspectAttribution: input.suspectAttribution ?? current.suspectAttribution,
      pilotEnrolled,
      pilotLabelsSince: sinceAfter(current.pilotLabelsSince, wasEnrolled, pilotEnrolled, now),
      // 07 §13.9, §13.11: the first consent's instant, kept; a re-enrolment is a new interval.
      pilotOutcomesSince: firstEnrolledAt(current.pilotOutcomesSince, pilotEnrolled, now),
      updatedAt: now,
    };
    await upsertSettings(tx, row);
    await recordEnrolmentChange(tx, input.repo, wasEnrolled, pilotEnrolled, now);
    return row;
  });
  return {
    ...next,
    pilotLabelsSince: next.pilotLabelsSince?.toISOString() ?? null,
    pilotOutcomesSince: next.pilotOutcomesSince?.toISOString() ?? null,
    updatedAt: next.updatedAt.toISOString(),
  };
};

type SettingsRow = typeof teamSettings.$inferInsert;

const upsertSettings = async (tx: DbExecutor, next: SettingsRow): Promise<void> => {
  await tx
    .insert(teamSettings)
    .values(next)
    .onConflictDoUpdate({
      target: teamSettings.repo,
      set: {
        pinPolicy: next.pinPolicy,
        suspectAttribution: next.suspectAttribution,
        pilotEnrolled: next.pilotEnrolled,
        pilotLabelsSince: next.pilotLabelsSince,
        pilotOutcomesSince: next.pilotOutcomesSince,
        updatedAt: next.updatedAt,
      },
    });
};
