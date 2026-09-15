/**
 * Coverage integrity (docs/1.0/03-coverage-integrity.md) — "only judge when
 * you know you were watching", as a data structure.
 *
 * THE SHAPE IS THE ARGUMENT. Coverage is FIVE ROWS, one per source, each with
 * its own state and its own named reason. It is never one number: a single
 * `coverage = 87%` collapses "we watched everything except CI" and "we watched
 * nothing but CI" into the same reassuring figure, and the whole point of this
 * record is that the two are different answers. There is no aggregate field
 * and there will not be one — no `overall`, no count, no percentage.
 *
 * A MISSING ROW CANNOT BE READ AS `complete` BECAUSE ROWS ARE NEVER MISSING:
 * `readCoverage` emits all five, in COVERAGE_SOURCES order, always.
 *
 * VERIFY: bun -e 'const c=await import("./packages/server/src/services/coverage.ts");console.log(c.COVERAGE_SOURCES.length, c.COVERAGE_STATES.length)'
 * PRINTS: 5 4
 *
 * DERIVED ON READ. No table, no column, no migration, no retention — because
 * `agent_sessions.reaped_at` is REVOCABLE and says so in its own comment
 * (db/schema.ts:145-152: "an inference has to be revocable"), and
 * services/records.ts revives a reaped session when a record from it arrives.
 * A stored coverage verdict would outlive the evidence that made it.
 *
 * PHRASING CONTRACT, inherited verbatim from services/absences.ts:89-99: every
 * value here is a factual observation — "no session was reported in this
 * window" — never an inference about what somebody did. We see agent sessions,
 * not keystrokes.
 */
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import {
  ABSENCE_EVIDENCE_MAX_AGE_DAYS,
  COVERAGE_SESSION_WINDOW_DAYS,
  SUSPECT_MAX_PATHS,
} from "../constants.ts";
import {
  agentSessions,
  commitEvidence,
  workContextTargets,
  workContexts,
} from "../db/schema.ts";
import { readAbsenceCensus } from "./absences.ts";
import { presenceCutoff } from "./presence.ts";
import type { AbsenceCensus } from "./absences.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 00 §8.2, binding on all eight 1.0 specs. Order is part of the contract. */
export const COVERAGE_SOURCES = [
  "agent_event",
  "git",
  "ci",
  "runtime",
  "human_edit",
] as const;

export const COVERAGE_STATES = [
  "complete",
  "incomplete",
  "unknown",
  "unavailable",
] as const;

export type CoverageSource = (typeof COVERAGE_SOURCES)[number];
export type CoverageState = (typeof COVERAGE_STATES)[number];

/**
 * AN ENUM, NEVER PROSE (§3.3). The consequence every renderer inherits: a
 * coverage line carries no author-written string — enum values, ISO
 * timestamps and renderer-owned literals only — so landing it on a surface
 * adds no untrusted slot to that surface.
 *
 * The last four are RESERVED FOR 05 AND DORMANT until CI ingestion lands.
 * They are minted here rather than there because 05 §9.1 requests them, and a
 * second coverage enum living in a second package is exactly the drift
 * 00 §9.6 forbids.
 */
export const COVERAGE_REASONS = [
  "sessions_reported",
  "session_reaped",
  "session_silent",
  "no_session_in_window",
  "commits_reported",
  "commit_authors_unreported",
  "evidence_stale",
  "no_commit_evidence",
  "no_emitter",
  "out_of_scope_1_0",
  "no_platform_rung",
  "hub_did_not_report",
  "ci_lanes_reported",
  "ci_lanes_missing",
  "ci_awaiting_rerun",
  "ci_not_reported_yet",
] as const;

export type CoverageReason = (typeof COVERAGE_REASONS)[number];

export interface CoverageSourceRecord {
  readonly source: CoverageSource;
  readonly state: CoverageState;
  readonly reason: CoverageReason;
  /** ISO; null unless `incomplete` — when observation demonstrably stopped. */
  readonly gapSince: string | null;
  /** ISO; the newest thing this rung actually saw, null when it saw nothing. */
  readonly observedAt: string | null;
}

/**
 * What the question is about (§3.2a) — because a gap measured about the WHOLE
 * repo over the WHOLE window answers a question nobody asked. The tree's own
 * measurement is that unscoped `complete` is the exception rather than the
 * rule (connector-core/src/state/capture-health.ts:23-30), so an unscoped
 * verdict would be `INDETERMINATE` for ever and the predicate would be
 * useless. Granularity is the fix; softening a state is not.
 */
export interface CoverageScope {
  /** Never older than the window ceiling — `readCoverage` clamps it. */
  readonly sinceIso: string;
  /** Where the question is about a surface (04 passes a pin's file set). */
  readonly paths?: readonly string[];
}

export interface CoverageRecord {
  readonly repo: string;
  readonly computedAt: string;
  readonly scope: CoverageScope;
  /** EXACTLY five, in COVERAGE_SOURCES order. */
  readonly sources: readonly CoverageSourceRecord[];
}

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

export interface ReadCoverageOptions {
  readonly scope?: CoverageScope;
}

const sourceRecord = (
  source: CoverageSource,
  state: CoverageState,
  reason: CoverageReason,
  gapSince: string | null = null,
  observedAt: string | null = null,
): CoverageSourceRecord => ({ source, state, reason, gapSince, observedAt });

/**
 * THREE RUNGS THAT CANNOT EXIST, and the difference between this and an
 * omitted row is the whole of AT-10's "no silent absence, no fake pass".
 *
 *   ci         — nothing on main emits CI results. 05 creates the source;
 *                until its emitter, route and token exist this is
 *                `unavailable`, and doctor prints the refusal by name.
 *   runtime    — nothing exists. Runtime invariant mining is Tier 3.
 *   human_edit — no hook fires on a human keystroke on any platform we
 *                support. `work_context_targets.source = "tool_edit"` records
 *                the AGENT's edit tool, and the git-touch lane is mtime-scoped
 *                to a session and attributed to nobody; calling either
 *                `human_edit` would be the `coverage = 87%` lie in another
 *                shape. Human edits surface through `git`, via the `inactive`
 *                finding (services/absences.ts:30).
 *
 * `unavailable`, never `unknown`: a rung that cannot exist must not read as
 * one that might, or a reader waits for data no code path will ever produce.
 */
const REFUSED_RUNGS: readonly CoverageSourceRecord[] = [
  sourceRecord("ci", "unavailable", "no_emitter"),
  sourceRecord("runtime", "unavailable", "out_of_scope_1_0"),
  sourceRecord("human_edit", "unavailable", "no_platform_rung"),
];

/**
 * The window the answer is about. `sinceIso` is a FLOOR the caller may raise
 * and never lower: a caller asking about the last hour gets an hour, a caller
 * asking about last year gets COVERAGE_SESSION_WINDOW_DAYS, because this hub
 * holds no observation older than that to be honest about.
 */
const effectiveSince = (now: Date, scope: CoverageScope | undefined): Date => {
  const ceiling = new Date(
    now.getTime() - COVERAGE_SESSION_WINDOW_DAYS * MS_PER_DAY,
  );
  if (scope === undefined) {
    return ceiling;
  }
  const asked = Date.parse(scope.sinceIso);
  return Number.isNaN(asked) || asked < ceiling.getTime()
    ? ceiling
    : new Date(asked);
};

/**
 * Bounded by the same constant `crosscheck suspect` bounds its own path list
 * with, for the same reason and against the same index: an unbounded `IN (…)`
 * is the one way a caller makes this query's cost their own choice.
 */
const scopePaths = (scope: CoverageScope | undefined): readonly string[] =>
  (scope?.paths ?? []).slice(0, SUSPECT_MAX_PATHS);

/** Driver-agnostic timestamp read: raw aggregates bypass drizzle's mapping. */
const toIso = (value: unknown): string | null => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  return null;
};

const toCount = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * ONE indexed aggregate over `agent_sessions` by repo (§3.2), riding
 * agent_sessions_repo_idx / agent_sessions_heartbeat_idx (db/schema.ts:156-157).
 *
 * TWO WAYS OBSERVATION STOPS, and neither is an ended session:
 *
 *   `reaped_at` NOT NULL — the hub closed this session on a GUESS after
 *   SESSION_REAP_STALE_HOURS of silence. services/records.ts:71-79 records
 *   that the reap over-fires: "an afternoon of reading and planning looks
 *   like a killed terminal". Whatever it was, nobody was reporting.
 *
 *   `ended_at` NULL past `presenceCutoff` — the session never said goodbye
 *   and is not live either. The trial found 104 of 127 sessions in this
 *   state (connector-core/src/state/capture-health.ts:23-30).
 *
 * ZERO ROWS IS `unknown`, NEVER `complete`. No session is not proof nobody
 * worked; it is proof nobody told us, which is the distinction this whole
 * record exists to keep.
 *
 * `gapSince` is the EARLIEST heartbeat among the sessions that stopped
 * reporting — "observation has been unreliable since at least this instant",
 * which is the direction that cannot overstate what was seen. `observedAt` is
 * the newest heartbeat of any session in the window, gap or not: the last
 * moment this rung saw anything at all.
 *
 * A REAP OUTRANKS A SILENCE when both are present. A reap is a decision this
 * hub made and can revoke, so it is the one a reader can act on.
 */
/**
 * "This session reported a file target" — optionally, one of a given set.
 * The same work_contexts -> work_context_targets join `crosscheck suspect`
 * already makes (services/suspect.ts), riding
 * work_context_targets_kind_value_idx (db/schema.ts).
 */
const reportedFileTargets = (match?: SQL): SQL =>
  sql`exists (select 1 from ${workContexts} join ${workContextTargets} on ${workContextTargets.workContextId} = ${workContexts.id} where ${workContexts.sessionId} = ${agentSessions.id} and ${workContextTargets.kind} = 'file'${match === undefined ? sql.empty() : sql` and ${match}`})`;

/**
 * §3.2a's `paths` half: count only the sessions that touched the surface the
 * question is about.
 *
 * NO STATE IS SOFTENED. A reaped session that touched the scope is still
 * `incomplete` and the reason still names the reap; what changes is that a
 * session which abandoned a different corner of the repo stops being a gap
 * in an answer about THIS surface.
 *
 * AND THE SCOPE MAY NARROW BY WHAT WAS OBSERVED, NEVER BY WHAT WAS NOT —
 * the second arm, and without it this scope was a hole rather than a
 * granularity. A session reaped before it ever reported a work context has
 * NO target row, so asked "did it touch these files" the database cannot
 * answer and a bare EXISTS answers "no". The sessions whose observation
 * failed hardest would drop out of precisely the question they should have
 * qualified, and `complete` — with `isJudgeable` behind it — would be
 * reachable on a repo full of reaped sessions.
 *
 * Unknown provenance fails CLOSED, and the split is exactly the difference
 * between a report and a silence: a session that ENDED cleanly reported
 * everything it had, so "no file target" means "touched no file" and it may
 * leave the scope; a session the hub closed on a guess reported only what it
 * managed to before the silence, so it may not. Only a gap-session can enter
 * the scope this way, so the arm can move an answer towards `incomplete` and
 * never towards `complete`.
 */
const touchedScope = (paths: readonly string[], isGap: SQL): SQL =>
  sql`(${reportedFileTargets(inArray(workContextTargets.value, [...paths]))} or (${isGap} and not ${reportedFileTargets()}))`;

const readAgentEventCoverage = async (
  deps: Deps,
  now: Date,
  repo: string,
  since: Date,
  paths: readonly string[],
): Promise<CoverageSourceRecord> => {
  const cutoff = presenceCutoff(now);
  const isGap = sql`(${agentSessions.reapedAt} is not null or (${agentSessions.endedAt} is null and ${agentSessions.lastHeartbeatAt} <= ${cutoff}))`;
  const rows = await deps.db
    .select({
      total: sql`count(*)`,
      reaped: sql`count(*) filter (where ${agentSessions.reapedAt} is not null)`,
      gaps: sql`count(*) filter (where ${isGap})`,
      gapSince: sql`min(${agentSessions.lastHeartbeatAt}) filter (where ${isGap})`,
      observedAt: sql`max(${agentSessions.lastHeartbeatAt})`,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.repo, repo),
        gt(agentSessions.lastHeartbeatAt, since),
        ...(paths.length === 0 ? [] : [touchedScope(paths, isGap)]),
      ),
    );
  const row = rows[0];
  const total = toCount(row?.total);
  if (total === 0) {
    return sourceRecord("agent_event", "unknown", "no_session_in_window");
  }
  const observedAt = toIso(row?.observedAt);
  if (toCount(row?.gaps) === 0) {
    return sourceRecord(
      "agent_event",
      "complete",
      "sessions_reported",
      null,
      observedAt,
    );
  }
  return sourceRecord(
    "agent_event",
    "incomplete",
    toCount(row?.reaped) > 0 ? "session_reaped" : "session_silent",
    toIso(row?.gapSince),
    observedAt,
  );
};

/**
 * "Observation has been unreliable since at least here" for the git rung: the
 * earliest moment the census says somebody's work was going unreported. An
 * absentee with a session names that session's last heartbeat; one with no
 * session at all can only name the commit, which is §3.2's "else".
 *
 * A LOWER BOUND OR IT IS A LIE. This reads the census's minima, never a
 * minimum over `listAbsences`' kept findings: that list is capped at
 * ABSENCE_MAX_FINDINGS after ordering newest-commit-first, so its minimum is
 * taken over the 20 most RECENT absentees and lands days later than the
 * earliest gap, every time, in the reassuring direction.
 */
const censusGap = (census: AbsenceCensus): string | null =>
  census.earliestSessionAt ?? census.earliestCommitAt;

/**
 * The git rung, and it needs its OWN UNWINDOWED aggregate rather than the rows
 * `listAbsences` reads — which is the one place §3.2's sentence does not
 * survive contact with the code.
 *
 * `listAbsences` filters `collected_at` against ABSENCE_EVIDENCE_MAX_AGE_DAYS
 * inside its evidence query. A repo whose newest collection is nine days old
 * therefore returns ZERO findings — byte-identical to a repo no connector has
 * ever collected evidence for. §3.2 needs those two to read `incomplete` /
 * `evidence_stale` and `unknown` / `no_commit_evidence` respectively, and no
 * query that inherits the staleness filter can tell them apart. So: one
 * `max(collected_at)` + `count(*)` over `commit_evidence` for this repo,
 * unwindowed.
 *
 * AND THE ABSENTEES COME FROM A CENSUS, NOT FROM THE LISTING. §3.2 says this
 * rung reads "rows `listAbsences` already reads", and it cannot: that listing
 * is bounded twice (ABSENCE_MAX_EVIDENCE_ROWS, then ABSENCE_MAX_FINDINGS) and
 * ordered so the rows it drops are the stalest committers — the population
 * this question is about. An empty listing is then a cut, not a census, and
 * reading it as `complete` is AT-5's "fails if" reached by TEAM SIZE. So the
 * count and the earliest instant come from `readAbsenceCensus`, which asks
 * the listing's own predicate with no LIMIT and no ORDER BY
 * (services/absences.ts).
 *
 * `collectCommitEvidence` runs only at SessionStart (00 §4.3), which is why a
 * stale `collected_at` is a gap rather than something to ignore: it means no
 * connected teammate has started a session in a week.
 *
 * THE `paths` SCOPE DOES NOT REACH THIS RUNG, and it cannot. §3.2a says a
 * scoped call counts "only findings touching" the paths; `commit_evidence` is
 * keyed on (repo, author_email) and carries commit_count, latest_commit_at and
 * collected_at — NO PATHS AT ALL (db/schema.ts:404-419). There is nothing to
 * intersect a file set with, so a scoped call answers the repo-wide git
 * question and says so here rather than silently pretending to narrow.
 *
 * NEVER `unavailable`. PR #50 uses that word for the opposite thing —
 * `GitTouchesOutcome.unavailable` (connector-core/src/flows/capture-git-touches.ts:83-88)
 * means "git DID NOT ANSWER — a deadline, no repository, no binary", which is
 * coverage `unknown`: the rung exists and nobody answered. Coverage
 * `unavailable` is "the rung cannot exist", which is never true of git on any
 * platform we support. One word, two meanings, and this is the comment that
 * stops the next reader collapsing them.
 */
const readGitCoverage = async (
  deps: Deps,
  now: Date,
  viewerDeveloperId: string,
  repo: string,
): Promise<CoverageSourceRecord> => {
  const rows = await deps.db
    .select({
      total: sql`count(*)`,
      newest: sql`max(${commitEvidence.collectedAt})`,
    })
    .from(commitEvidence)
    .where(eq(commitEvidence.repo, repo));
  const row = rows[0];
  if (toCount(row?.total) === 0) {
    return sourceRecord("git", "unknown", "no_commit_evidence");
  }
  const newest = toIso(row?.newest);
  const staleBefore = now.getTime() - ABSENCE_EVIDENCE_MAX_AGE_DAYS * MS_PER_DAY;
  if (newest === null || Date.parse(newest) < staleBefore) {
    return sourceRecord("git", "incomplete", "evidence_stale", newest, newest);
  }
  const census = await readAbsenceCensus(deps, viewerDeveloperId, repo);
  if (census.unreportedAuthors === 0) {
    return sourceRecord("git", "complete", "commits_reported", null, newest);
  }
  return sourceRecord(
    "git",
    "incomplete",
    "commit_authors_unreported",
    censusGap(census),
    newest,
  );
};

const stateOf = (
  record: CoverageRecord,
  source: CoverageSource,
): CoverageState | undefined =>
  record.sources.find((row) => row.source === source)?.state;

/**
 * PRINCIPLE 1 — "only judge when you know you were watching" — AS A FUNCTION.
 * AT-5 is decided by this and nothing else; 04's verdict layer CALLS it and
 * must never recompute it, because two spellings of "were we watching" are
 * two answers the moment one of them is edited.
 *
 * THE THIRD TERM IS NOT DECORATION. The first shape read `agent_event` and
 * `git` only. 04 gates `no_touch` on this predicate and on nothing else
 * coverage-shaped, so the moment 05 lands and a repo's `ci` source reads
 * `incomplete` — some expected lanes reported and some did not, or a lane is
 * mid-flight — a pin-lane `no_touch` answer would still have emitted
 * `UNATTRIBUTED`. The system would have said "nobody in the record did this"
 * while knowing a lane it watches had not finished. That is AT-5's "fails if"
 * verbatim, and it was reachable from inside this spec's own predicate.
 *
 * `incomplete` IS THE ONLY DISQUALIFYING STATE FOR THE OTHER THREE,
 * DELIBERATELY. A rung that cannot exist (`unavailable`) must not block
 * judging, or with `runtime` permanently unavailable no verdict is ever
 * reachable and the predicate is useless; and `unknown` on a rung nobody
 * reports is the ordinary state of a fresh install. AT-5 names a KNOWN gap,
 * and `incomplete` is the only state that is one.
 */
export const isJudgeable = (record: CoverageRecord): boolean =>
  stateOf(record, "agent_event") === "complete" &&
  stateOf(record, "git") === "complete" &&
  record.sources.every((row) => row.state !== "incomplete");

/**
 * The five rows for one repo, always, in order.
 *
 * `viewerDeveloperId` rather than §3.2a's bare `(deps, repo, scope?)`: the git
 * rung's census carries the same privacy predicate the absence listing does
 * (services/absences.ts), so coverage is scoped to what this viewer may be
 * told — the same rule every other answer on these routes already follows.
 * Coverage that ignored an opt-out would be a side channel around it.
 */
export const readCoverage = async (
  deps: Deps,
  viewerDeveloperId: string,
  repo: string,
  options: ReadCoverageOptions = {},
): Promise<CoverageRecord> => {
  const now = deps.now();
  const since = effectiveSince(now, options.scope);
  const paths = scopePaths(options.scope);
  const [agentEvent, git] = await Promise.all([
    readAgentEventCoverage(deps, now, repo, since, paths),
    readGitCoverage(deps, now, viewerDeveloperId, repo),
  ]);
  return {
    repo,
    computedAt: now.toISOString(),
    scope: {
      sinceIso: since.toISOString(),
      ...(paths.length === 0 ? {} : { paths }),
    },
    sources: [agentEvent, git, ...REFUSED_RUNGS],
  };
};
