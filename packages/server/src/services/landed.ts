/**
 * landed_evidence ingest — merged-branch detection, hub side (DESIGN.md §5:
 * "base_commit reachable from main ⇒ context marked landed").
 *
 * WHY A COLUMN AND NOT A STATUS TRANSITION. Three reasons, in order:
 *   1. `status` is the SESSION_STATUSES enum shared by sessions and contexts
 *      on the wire — widening it would touch every consumer for a fact that
 *      is not about what the developer's session was doing.
 *   2. A transition would DESTROY information: a landed context was also
 *      `done` or `blocked`, and that last working status stays meaningful.
 *   3. Presentation needs WHEN it was observed ("landed", stated with age),
 *      which only a timestamp records.
 * Claims are untouched — append-only, as everywhere.
 *
 * MONOTONIC BY CONSTRUCTION: the UPDATE touches only rows whose landed_at is
 * still null, so a replayed or repeated report cannot move the observation
 * and no report can ever un-land a context (git ancestry never un-happens; a
 * force-pushed default branch is the one case that could, and honesty there
 * costs less than a flag teammates watch flap). The one writer that clears
 * it is an operator's: scripts/unland-false-landed.ts, for stamps this rule
 * would have refused (services/landed-repair.ts).
 *
 * ONLY A BASE THAT ARRIVED IS EVIDENCE (pilot finding, 2026-10-05). The
 * ancestry test alone cannot say "this session's work landed": a session
 * detached at an old main commit — every orchestration worktree — or on a
 * branch cut from main with nothing committed yet has a base that is an
 * ancestor from its first second. A teammate's report stamped exactly such a
 * context, a six-week-old detached base, and its 180 captured files left
 * ghost checks and the conference while the teammate edited the same files.
 * So a reported ancestor lands a context only when its base reaching the
 * default branch can be NEW (ancestryLandsContext):
 *   - never for a detached session, whatever else is known — its HEAD is a
 *     checkout of a commit, and its session's work happens elsewhere;
 *   - never for a session ON the default branch the report names
 *     (isDefaultBranch, the connector's own isOnDefaultBranch rule): 6 of the
 *     pilot hub's 16 fresh-dated false stamps were sessions on main, whose
 *     base is main's tip by construction;
 *   - by the connector's word where it gave one: `base_on_default`, its own
 *     ancestry probe at register — true never lands, false lands;
 *   - for a connector from before that word, only until
 *     LANDED_UNFLAGGED_FALLBACK_ENDS_AT, and only when the report dates the
 *     base (`commitDates`) and the base was committed no more than
 *     LANDED_STALE_BASE_HOURS before the session TOOK it (`base_changed_at`)
 *     — not before its context opened, which a pull onto an older commit
 *     days later makes look young. An undated base is not stamped: its age
 *     is unknown, and unknown is not evidence.
 * Every refusal leaves the context unlanded, the direction in which it stays
 * visible to every collision check.
 *
 * PER WORK CONTEXT, NEVER PER SESSION (topic review C1). One session that
 * works in a dozen sibling worktrees owns one TOPIC context per (repo,
 * worktree, branch), each with its own branch and base commit (DESIGN.md "One
 * session, many topics"). A report naming the SESSION's base stamped every
 * context of the session, so one teammate's SessionStart took every topic —
 * mid-work, elsewhere, on other branches — out of the ghost checks and the
 * conference at once. So the session's base lands only the session's OWN
 * context, and a topic lands only by its own base, judged by the same rules
 * on its own facts: its branch (detached, default), its connector's word
 * about its base (`work_contexts.base_on_default` — a branch freshly cut from
 * main says its base was there already), and, for a topic without a word,
 * the dated fallback against when the TOPIC took its base (its created_at). The hub has no default-branch history
 * to derive "already on main at creation" from — commit evidence is one
 * aggregate row per author, no hashes — so the connector says it, or the
 * date stands in for it.
 *
 * TRUST MODEL, same as commit evidence: any hub member may report, because
 * git ancestry is checkable from any clone and the hub maps commit → context
 * through (repo, base_commit) itself — except about a developer who opted
 * out of presence, whose contexts take evidence from their own sessions
 * only (the base commit is their HEAD; see ingestLandedEvidence). A forged report can therefore mislabel
 * a context as landed — a wrong label with the same blast radius as forged
 * commit evidence, accepted and documented — but it cannot touch claims,
 * ranking (the solved floor keys on SOLVED, services/solved.ts), or another
 * repo's contexts. A forged date widens nothing: it can only stamp what a
 * forged sha already could.
 *
 * Renderers still state the fact literally ("base commit is on the default
 * branch") rather than claiming the WORK merged: a squash merge lands under
 * a new sha that no base names, so this lane can miss a landing — it must
 * never invent one.
 */
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { isDefaultBranch, isDetachedBranch } from "@crosscheck/schema";
import type { LandedEvidence } from "@crosscheck/schema";

import { LANDED_STALE_BASE_HOURS, LANDED_UNFLAGGED_FALLBACK_ENDS_AT } from "../constants.ts";
import { agentSessions, workContexts } from "../db/schema.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";
import type { HandlerOutcome } from "./record-handlers.ts";
import { visiblePresenceCondition } from "./visibility.ts";

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

const MS_PER_HOUR = 3_600_000;
const UNFLAGGED_FALLBACK_ENDS_MS = Date.parse(LANDED_UNFLAGGED_FALLBACK_ENDS_AT);

/** What the rule reads about one open context and the session that owns it. */
export interface LandingCandidate {
  readonly branch: string;
  /** The connector's word at register; null when it gave none. */
  readonly baseOnDefault: boolean | null;
  /** When the session took its base: base_changed_at, else its start. */
  readonly baseAdoptedAt: Date;
}

/** What the rule reads about the report itself. */
export interface LandingReport {
  /** The default branch the reporter checked against; null when it named none. */
  readonly defaultBranch: string | null;
  /** When the hub judges it — its own clock. */
  readonly at: Date;
}

/** A base committed more than LANDED_STALE_BASE_HOURS before the session took it. */
export const isStaleBase = (baseCommittedAt: Date, baseAdoptedAt: Date): boolean =>
  baseCommittedAt.getTime() < baseAdoptedAt.getTime() - LANDED_STALE_BASE_HOURS * MS_PER_HOUR;

/**
 * May "this base commit is on the default branch now" stamp this context?
 * The module header gives the rules and why; `baseCommittedAt` is the
 * report's date for the base, when it gave one.
 */
export const ancestryLandsContext = (
  candidate: LandingCandidate,
  baseCommittedAt: Date | undefined,
  report: LandingReport,
): boolean => {
  if (isDetachedBranch(candidate.branch)) {
    return false;
  }
  if (isDefaultBranch(candidate.branch, report.defaultBranch)) {
    return false;
  }
  if (candidate.baseOnDefault !== null) {
    return !candidate.baseOnDefault;
  }
  if (report.at.getTime() >= UNFLAGGED_FALLBACK_ENDS_MS) {
    return false;
  }
  return baseCommittedAt !== undefined && !isStaleBase(baseCommittedAt, candidate.baseAdoptedAt);
};

const commitDatesOf = (body: LandedEvidence): ReadonlyMap<string, Date> =>
  new Map((body.commitDates ?? []).map((entry) => [entry.sha, new Date(entry.committedAt)]));

/** One context as the rule reads it: its own base, and the facts about that base. */
export interface JudgedContext extends LandingCandidate {
  readonly id: string;
  readonly baseCommit: string;
}

/** What one candidate row holds: the context's own topic fields beside its session's. */
export interface CandidateRow {
  readonly id: string;
  readonly topicBranch: string | null;
  readonly topicBaseCommit: string | null;
  readonly topicBaseOnDefault: boolean | null;
  readonly createdAt: Date;
  readonly sessionBaseCommit: string;
  readonly sessionBranch: string;
  readonly sessionBaseOnDefault: boolean | null;
  readonly baseChangedAt: Date | null;
  readonly startedAt: Date;
}

/** A session's OWN context: no topic field of its own, so its base and word are its session's. */
const isSessionOwn = (row: Pick<CandidateRow, "topicBranch" | "topicBaseCommit">): boolean =>
  row.topicBranch === null && row.topicBaseCommit === null;

/** The columns a CandidateRow is read from, for every reader that judges a stamp. */
export const CANDIDATE_COLUMNS = {
  id: workContexts.id,
  topicBranch: workContexts.branch,
  topicBaseCommit: workContexts.baseCommit,
  topicBaseOnDefault: workContexts.baseOnDefault,
  createdAt: workContexts.createdAt,
  sessionBaseCommit: agentSessions.baseCommit,
  sessionBranch: agentSessions.branch,
  sessionBaseOnDefault: agentSessions.baseOnDefault,
  baseChangedAt: agentSessions.baseChangedAt,
  startedAt: agentSessions.startedAt,
} as const;

/**
 * A row as the rule judges it — a topic on ITS OWN facts: its base, its
 * branch, its word, and its first touch as the instant it took its base.
 * The operator's repair judges a stamp on the same facts
 * (services/landed-repair.ts).
 */
export const judgedContextOf = (row: CandidateRow): JudgedContext =>
  isSessionOwn(row)
    ? {
        id: row.id,
        baseCommit: row.sessionBaseCommit,
        branch: row.sessionBranch,
        baseOnDefault: row.sessionBaseOnDefault,
        baseAdoptedAt: row.baseChangedAt ?? row.startedAt,
      }
    : {
        id: row.id,
        baseCommit: row.topicBaseCommit ?? "",
        branch: row.topicBranch ?? row.sessionBranch,
        baseOnDefault: row.topicBaseOnDefault,
        baseAdoptedAt: row.createdAt,
      };

/**
 * WHICH CONTEXTS A REPORT CAN NAME: a session's own context by its session's
 * base, a topic by its own base only — never through its session's, and a
 * topic with no base of its own by none.
 */
const namedByReport = (commits: readonly string[]): SQL | undefined =>
  or(
    and(isNull(workContexts.branch), isNull(workContexts.baseCommit), inArray(agentSessions.baseCommit, [...commits])),
    inArray(workContexts.baseCommit, [...commits]),
  );

/**
 * Stamps landed_at on every still-open context on `body.repo` whose OWN base
 * commit the report names (namedByReport), and whose base reaching the
 * default branch is evidence of new work (ancestryLandsContext, judged per
 * context). The candidates are read once, judged here, and stamped in one
 * UPDATE that re-checks `landed_at IS NULL` — the commit list is capped by
 * the wire schema (MAX_LANDED_COMMITS).
 *
 * Always "accepted", including when nothing matched: the write is idempotent
 * and the flush loop acts on nothing finer. No outbox event, same reasoning
 * as targets and commit evidence — every teammate's SessionStart re-reports,
 * and per-report events would drown the signals SSE consumers care about.
 */
export const ingestLandedEvidence = async (
  deps: Deps,
  developerId: string,
  body: LandedEvidence,
): Promise<HandlerOutcome> => {
  const candidates: readonly CandidateRow[] = await deps.db
    .select(CANDIDATE_COLUMNS)
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(
      and(
        isNull(workContexts.landedAt),
        eq(agentSessions.repo, body.repo),
        namedByReport(body.commits),
        // A HIDDEN OWNER'S SESSIONS TAKE EVIDENCE FROM THE OWNER ONLY. The
        // stamp is visible to every colleague, so accepting anybody's report
        // let a colleague submit a guessed sha, watch `landedAt` flip and
        // read an opted-out developer's HEAD back one guess at a time
        // (services/live-location.ts). The cost is stated in visibility.ts:
        // teammates' SessionStart no longer marks her work landed; her own
        // sessions still do.
        visiblePresenceCondition(developerId, agentSessions.developerId),
      ),
    );
  const committedAt = commitDatesOf(body);
  const report: LandingReport = { defaultBranch: body.defaultBranch ?? null, at: deps.now() };
  const landing = candidates
    .map(judgedContextOf)
    .filter((context) => ancestryLandsContext(context, committedAt.get(context.baseCommit), report))
    .map((context) => context.id);
  if (landing.length > 0) {
    await deps.db
      .update(workContexts)
      .set({ landedAt: deps.now() })
      .where(and(isNull(workContexts.landedAt), inArray(workContexts.id, landing)));
  }
  return { status: "accepted" };
};
