/**
 * THE SKELETON SWEEP, GENERATED FROM THE REGISTRY (1.0 spec 01a §3.3a, §3.3g).
 *
 * WHAT IT DELETES: every `session_events` row of a session that
 *
 *   1. ENDED EXPLICITLY (`ended_at` set, `reaped_at` null) more than
 *      SESSION_EVENT_RETENTION_DAYS ago — a reap is an inference from silence
 *      that a later record can disprove, so a reaped session is never swept;
 *   2. is reached by NO root in the registry (services/retention-registry.ts);
 *   3. carries no file touch whose identity is UNRESOLVED — on either side:
 *      a touch with no `file_ref`, or any pin in its repo whose history holds
 *      a NULL, whose file git can no longer find, or which has no history at
 *      all yet (§3.3e);
 *   4. and, in INTERIM mode — the mode this hub ships in — carries no file
 *      touch at all, until CSK-15 and CSK-20 have held against real pins and
 *      real touches (Nick's interim rule, §3.3g).
 *
 * THE UNIT IS THE SESSION (§3.3a). A session's order state is derived from
 * the SET of its rows: remove the one row that carried an epoch conflict and
 * the hub answers `usable` for a session whose order was `broken`. So a
 * session goes whole, in one statement, or not at all.
 *
 * ONE STATEMENT, ONE SNAPSHOT (D-B7). The judgement is a CTE of the DELETE
 * itself, inside a transaction, so a root committed while the sweep runs
 * cannot fall between a check and a delete: there is no between.
 *
 * A PASS COSTS A WINDOW, NEVER THE HUB. A KEPT session stays a candidate for
 * good — in interim nearly every session is kept — so a pass that judged
 * every candidate would grow with everything it had ever decided to keep, on
 * a database that serves one statement at a time. Each pass therefore judges
 * the next SESSION_EVENT_SWEEP_WINDOW candidates after a cursor, oldest end
 * first, and wraps: every session is judged again once per cycle. The same
 * judgement is TALLIED, and each completed cycle is published as the report
 * `doctor` reads — so the report costs a request nothing, and its numbers are
 * the numbers the deleting statement itself computed.
 *
 * WHILE ANY DECLARED ROOT IS NOT BUILT, NOTHING RUNS (§3.3b, CSK-26): its
 * rows will exist, and a session swept before they do is unreachable by the
 * root that was always going to reference it.
 *
 * A FAILED CHECK DELETES NOTHING (CSK-17): the statement rolls back whole,
 * the failure is counted, and the reaper's own pass goes on.
 */
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { MAX_REPORTED_UNRESOLVED_PINS } from "@crosscheck/schema";
import type {
  RetentionRootName,
  SessionEventRetentionMode,
  SkeletonRetentionReport,
} from "@crosscheck/schema";

import {
  SESSION_EVENT_RETENTION,
  SESSION_EVENT_RETENTION_DAYS,
  SESSION_EVENT_SWEEP_WINDOW,
} from "../constants.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";
import { RETENTION_REGISTRY, retentionRoots } from "./retention-registry.ts";
import type { RetentionRelation, RootRelation } from "./retention-registry.ts";

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The session the sweep is asking about, as its fragments see it. */
const SESSION = sql`s.id`;

/**
 * §3.3e: a touch the hub cannot tie to a file, or a pin in the session's repo
 * the hub cannot tie to its files. Either way "no pin references this" is not
 * a fact the hub holds, and the whole session is kept.
 */
export const unresolvedFileReference = (session: SQL): SQL => sql`
  SELECT 1 FROM session_events pe
   WHERE pe.session_id = ${session} AND pe.kind = 'file.modified'
     AND (pe.file_ref IS NULL
          OR EXISTS (SELECT 1 FROM pin_file_refs pr JOIN pins p ON p.id = pr.pin_id
                      WHERE pr.file_ref IS NULL AND p.repo = s.repo)
          OR EXISTS (SELECT 1 FROM pin_files pf
                      WHERE pf.status <> 'present' AND pf.repo = s.repo)
          OR EXISTS (SELECT 1 FROM pins p
                      WHERE p.repo = s.repo
                        AND NOT EXISTS (SELECT 1 FROM pin_file_refs pr WHERE pr.pin_id = p.id)))`;

/** INTERIM (§3.3g): no session with a file touch is swept at all. */
export const fileBearing = (session: SQL): SQL => sql`
  SELECT 1 FROM session_events fm
   WHERE fm.session_id = ${session} AND fm.kind = 'file.modified'`;

export const retentionCutoff = (now: Date): Date =>
  new Date(now.getTime() - SESSION_EVENT_RETENTION_DAYS * MS_PER_DAY);

/** Where the last window stopped: the (ended_at, id) of its newest candidate. */
export interface SweepCursor {
  readonly endedAt: string;
  readonly id: string;
}

export interface SweepStatementInput {
  readonly now: Date;
  readonly cutoff: Date;
  readonly window: number;
  readonly cursor: SweepCursor | null;
  readonly mode: "interim" | "full";
  readonly roots: readonly RootRelation[];
}

const flag = (index: number): SQL => sql.raw(`r${String(index)}`);

/**
 * THE WHOLE PASS AS ONE STATEMENT. The candidates are every session past the
 * window that still holds a skeleton — reaped ones included so the report can
 * count them, and never deleted (`NOT reaped` below). Each is judged once
 * against every root the registry declares (no clause exists outside it), the
 * eligible are deleted, and the tallies of that same judgement come back with
 * the deletion's counts and the cursor for the next window. The `EXISTS …
 * session_events` guard keeps a swept session out of every later window:
 * `agent_sessions` rows are never removed.
 */
export const skeletonSweepStatement = (input: SweepStatementInput): SQL => {
  const rootFlags = input.roots.map(
    (root, index) => sql`EXISTS (${root.reaches(SESSION)}) AS ${flag(index)}`,
  );
  const unreached = input.roots.map((_root, index) => sql`AND NOT ${flag(index)}`);
  const rootCounts = input.roots.map(
    (_root, index) =>
      sql`(SELECT count(*) FILTER (WHERE ${flag(index)} AND NOT reaped)::int FROM judged) AS ${flag(index)}`,
  );
  const after =
    input.cursor === null
      ? sql``
      : sql`AND (s.ended_at, s.id) > (${input.cursor.endedAt}::timestamptz, ${input.cursor.id})`;
  return sql`
    WITH candidates AS (
      SELECT s.id, s.repo, s.ended_at, s.reaped_at IS NOT NULL AS reaped
        FROM agent_sessions s
       WHERE s.ended_at IS NOT NULL AND s.ended_at < ${input.cutoff}
         AND EXISTS (SELECT 1 FROM session_events se WHERE se.session_id = s.id)
         ${after}
       ORDER BY s.ended_at, s.id
       LIMIT ${input.window}
    ),
    judged AS (
      SELECT s.id, s.reaped,
             ${sql.join(rootFlags, sql`, `)},
             EXISTS (${unresolvedFileReference(SESSION)}) AS unresolved,
             EXISTS (${fileBearing(SESSION)}) AS file_bearing
        FROM candidates s
    ),
    eligible AS (
      SELECT id FROM judged
       WHERE NOT reaped
         ${sql.join(unreached, sql` `)}
         AND NOT unresolved
         ${input.mode === "interim" ? sql`AND NOT file_bearing` : sql``}
    ),
    gone AS (
      DELETE FROM session_events WHERE session_id IN (SELECT id FROM eligible)
      RETURNING session_id
    ),
    retired AS (
      UPDATE agent_sessions SET skeleton_retired_at = ${input.now}
       WHERE id IN (SELECT id FROM eligible)
      RETURNING id
    )
    SELECT
      (SELECT count(*)::int FROM retired) AS retired,
      (SELECT count(*) FILTER (WHERE NOT reaped)::int FROM judged) AS judged,
      (SELECT count(*) FILTER (WHERE reaped)::int FROM judged) AS reaped,
      ${sql.join(rootCounts, sql`, `)},
      (SELECT count(*) FILTER (WHERE unresolved AND NOT reaped)::int FROM judged) AS unresolved,
      (SELECT count(*) FILTER (WHERE file_bearing AND NOT reaped)::int FROM judged) AS file_bearing,
      (SELECT count(DISTINCT session_id)::int FROM gone) AS sessions,
      (SELECT count(*)::int FROM gone) AS rows,
      (SELECT count(*)::int FROM candidates) AS window_size,
      (SELECT ended_at::text FROM candidates ORDER BY ended_at DESC, id DESC LIMIT 1) AS last_ended,
      (SELECT id FROM candidates ORDER BY ended_at DESC, id DESC LIMIT 1) AS last_id`;
};

export type SweepOutcome =
  | { readonly kind: "off" }
  | { readonly kind: "held"; readonly heldBy: readonly RetentionRootName[] }
  | { readonly kind: "swept"; readonly sessions: number; readonly rows: number }
  | { readonly kind: "failed" };

export interface SweepOptions {
  readonly mode?: SessionEventRetentionMode;
  readonly registry?: readonly RetentionRelation[];
  /** Candidates judged per pass; tests shrink it to cross window boundaries. */
  readonly window?: number;
}

/** One cycle's judgement, summed window by window. */
interface Tally {
  readonly judged: number;
  readonly reaped: number;
  readonly swept: number;
  readonly keptBy: ReadonlyMap<RetentionRootName, number>;
  readonly unresolved: number;
  readonly fileBearing: number;
}

const EMPTY_TALLY: Tally = {
  judged: 0,
  reaped: 0,
  swept: 0,
  keptBy: new Map(),
  unresolved: 0,
  fileBearing: 0,
};

/**
 * THE HUB'S OWN RECORD OF ITS SWEEP since this process started: where the
 * cycle stands, what the last completed cycle found, when a pass last ran and
 * how many failed. In memory, and labelled as such: a restart begins a new
 * cycle, and `doctor` says so until it completes.
 *
 * KEYED BY THE HUB'S DATABASE, never a module-level variable: two hubs in one
 * process (every test file, any embedding) would otherwise report each
 * other's failures — the full suite showed one hub WARNing about a pass that
 * failed on another.
 */
interface SweepState {
  readonly failures: number;
  readonly lastPassAt: Date | null;
  readonly cursor: SweepCursor | null;
  readonly tally: Tally;
  readonly published: { readonly tally: Tally; readonly completedAt: Date } | null;
}

const EMPTY_STATE: SweepState = {
  failures: 0,
  lastPassAt: null,
  cursor: null,
  tally: EMPTY_TALLY,
  published: null,
};

const states = new WeakMap<object, SweepState>();

/** Whose ledger this is: the hub's own database. */
const ledgerKey = (db: Db): object => db;

const stateOf = (db: Db): SweepState => states.get(ledgerKey(db)) ?? EMPTY_STATE;

export const sweepLedger = (db: Db): { readonly failures: number } => ({
  failures: stateOf(db).failures,
});

const recorded = (
  db: Db,
  at: Date,
  outcome: SweepOutcome,
  cycle: Partial<Pick<SweepState, "cursor" | "tally" | "published">> = {},
): SweepOutcome => {
  const state = stateOf(db);
  states.set(ledgerKey(db), {
    ...state,
    ...cycle,
    failures: state.failures + (outcome.kind === "failed" ? 1 : 0),
    lastPassAt: at,
  });
  return outcome;
};

export const heldByUnbuiltRoots = (
  registry: readonly RetentionRelation[],
): readonly RetentionRootName[] =>
  retentionRoots(registry)
    .filter((root) => root.status === "not_built")
    .map((root) => root.name);

const addTally = (
  tally: Tally,
  roots: readonly RootRelation[],
  row: Readonly<Record<string, unknown>>,
): Tally => {
  const keptBy = new Map(tally.keptBy);
  roots.forEach((root, index) => {
    keptBy.set(root.name, (keptBy.get(root.name) ?? 0) + Number(row[`r${String(index)}`] ?? 0));
  });
  return {
    judged: tally.judged + Number(row["judged"] ?? 0),
    reaped: tally.reaped + Number(row["reaped"] ?? 0),
    swept: tally.swept + Number(row["sessions"] ?? 0),
    keptBy,
    unresolved: tally.unresolved + Number(row["unresolved"] ?? 0),
    fileBearing: tally.fileBearing + Number(row["file_bearing"] ?? 0),
  };
};

export const sweepSkeleton = async (
  deps: Deps,
  options: SweepOptions = {},
): Promise<SweepOutcome> => {
  const now = deps.now();
  const mode = options.mode ?? SESSION_EVENT_RETENTION;
  const registry = options.registry ?? RETENTION_REGISTRY;
  if (mode === "off") {
    return recorded(deps.db, now, { kind: "off" });
  }
  const heldBy = heldByUnbuiltRoots(registry);
  if (heldBy.length > 0) {
    return recorded(deps.db, now, { kind: "held", heldBy });
  }
  const state = stateOf(deps.db);
  const roots = retentionRoots(registry);
  const window = options.window ?? SESSION_EVENT_SWEEP_WINDOW;
  const statement = skeletonSweepStatement({
    now,
    cutoff: retentionCutoff(now),
    window,
    cursor: state.cursor,
    mode,
    roots,
  });
  try {
    const result = await deps.db.transaction((tx) => tx.execute(statement));
    const row = (result.rows[0] ?? {}) as Readonly<Record<string, unknown>>;
    const tally = addTally(state.tally, roots, row);
    const lastEnded = row["last_ended"];
    const lastId = row["last_id"];
    // A window shorter than the bound reached the newest candidate: the cycle
    // is complete, its tally is what doctor reads, and the next pass starts
    // again at the oldest end.
    const complete =
      Number(row["window_size"] ?? 0) < window ||
      typeof lastEnded !== "string" ||
      typeof lastId !== "string";
    return recorded(
      deps.db,
      now,
      { kind: "swept", sessions: Number(row["sessions"] ?? 0), rows: Number(row["rows"] ?? 0) },
      complete
        ? { cursor: null, tally: EMPTY_TALLY, published: { tally, completedAt: now } }
        : { cursor: { endedAt: String(lastEnded), id: String(lastId) }, tally },
    );
  } catch (error) {
    console.error("[crosscheck] skeleton sweep failed; nothing was deleted", error);
    return recorded(deps.db, now, { kind: "failed" });
  }
};

/**
 * WHAT THE SWEEP IS KEEPING, AND WHY (§5) — for `doctor`, and cheap: the
 * counts are the last completed cycle's own judgement, read from memory. The
 * one query is over pins (a hub's target is 5 000), because a person who
 * repairs one wants to see the number move on their next `doctor`, and needs
 * the pin's id to find it.
 */
export const readSkeletonRetentionReport = async (
  deps: Deps,
  registry: readonly RetentionRelation[] = RETENTION_REGISTRY,
): Promise<SkeletonRetentionReport> => {
  const state = stateOf(deps.db);
  const published = state.published;
  const tally = published?.tally ?? EMPTY_TALLY;
  const unresolvedPins = await deps.db.execute(sql`
    SELECT p.id, count(*) OVER ()::int AS total FROM pins p
     WHERE EXISTS (SELECT 1 FROM pin_file_refs pr WHERE pr.pin_id = p.id AND pr.file_ref IS NULL)
        OR EXISTS (SELECT 1 FROM pin_files pf WHERE pf.pin_id = p.id AND pf.status <> 'present')
        OR NOT EXISTS (SELECT 1 FROM pin_file_refs pr WHERE pr.pin_id = p.id)
     ORDER BY p.id
     LIMIT ${MAX_REPORTED_UNRESOLVED_PINS}`);
  const pinRows = unresolvedPins.rows.map((row) => ({
    id: String(row["id"]),
    total: Number(row["total"] ?? 0),
  }));
  return {
    windowDays: SESSION_EVENT_RETENTION_DAYS,
    heldBy: heldByUnbuiltRoots(registry),
    completedAt: published === null ? null : published.completedAt.toISOString(),
    lastPassAt: state.lastPassAt === null ? null : state.lastPassAt.toISOString(),
    aged: tally.judged,
    swept: tally.swept,
    keptBy: retentionRoots(registry)
      .filter((root) => root.status === "built")
      .map((root) => ({ root: root.name, sessions: tally.keptBy.get(root.name) ?? 0 })),
    unresolved: tally.unresolved,
    fileBearing: tally.fileBearing,
    reapedAwaitingEnd: tally.reaped,
    unresolvedPins: Number(pinRows[0]?.total ?? 0),
    unresolvedPinIds: pinRows.map((row) => row.id),
    sweepFailures: state.failures,
  };
};
