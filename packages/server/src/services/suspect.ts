/**
 * `crosscheck suspect` (regression-guard Stage 1): intersect a broken
 * surface's files with every recorded touch in the window, and answer "who
 * was in there, and what did they say they were doing".
 *
 * FULLY POST-HOC. It runs when a person types the command, needs no hook, and
 * therefore behaves identically on Claude Code, Cursor and ACP. It cannot
 * interrupt anybody, which is the property that lets it ship before any
 * notice lane exists. Stolen shape: Sentry suspect commits — intersect the
 * stack trace's files with recent commits and name the likely author.
 *
 * FOUR RULES THAT ARE NOT NEGOTIABLE, each answering a way this could hurt
 * somebody:
 *
 *   1. NOTHING IS NAMED UNTIL THE PIN'S CHECK WAS RUN AND FAILED. The
 *      falsifier is the whole difference between attribution and gossip.
 *   2. RANKING IS BY LIFT — overlap over that author's OWN touches in the
 *      window. Raw overlap times recency makes the busiest person the default
 *      suspect; on a team committing 980/341/240 times a month that is an
 *      accusation generator, not a signal.
 *   3. SESSIONS AND INTENTS, NEVER PEOPLE. The rows carry a session id, an
 *      agent kind, a branch, a work-context title and its declared intent —
 *      no developer name, no developer id. Reaching a person is one
 *      deliberate hop the reader takes (`get_diagnosis <workContextId>`), not
 *      something this answer does for them.
 *   4. THE READER'S OWN SESSIONS COUNT. Nick's own agent breaking Nick's own
 *      pin a week later is the literal case the feature exists for, so the
 *      self-exclusion that the LIVE tripwire needs is wrong here.
 *
 * MUTE IS NOT A FILTER HERE. `services/visibility.ts` mutes the UNASKED
 * surfaces; this is a deliberate pull, like search and get_diagnosis, and
 * dropping a muted author's session would answer "who was in there" with a
 * lie. The row is labelled instead — "notices to this session's author are
 * suppressed by your mute" — because reading a muted author's silence as
 * "they ignored the notice" is how a trial ends socially rather than
 * technically.
 */
import { and, eq, gt, inArray, sql } from "drizzle-orm";

import {
  SUSPECT_MAX_CANDIDATES,
  SUSPECT_SEPARATION_RATIO,
  SUSPECT_TOP_CANDIDATES,
  SUSPECT_WINDOW_DAYS,
} from "../constants.ts";
import {
  agentSessions,
  developerMutes,
  workContextTargets,
  workContexts,
} from "../db/schema.ts";
import { readPin } from "./pins.ts";
import type { TeamSuspectAttribution } from "./team-settings.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

/**
 * WHY the surface is believed broken — printed before any row, because a
 * ranking whose premise is unstated is an accusation with the evidence left
 * off.
 */
export type SuspectFalsifierKind =
  /** A pin whose check recipe was run and recorded failing. */
  | "recorded_break"
  /** A live pin: nobody has recorded running its check and failing. */
  | "not_recorded_broken"
  /** A briefing-only pin with no recipe — nothing to have run. */
  | "no_check_recipe"
  /** No pin at all: the reader named the files, so the reader is the falsifier. */
  | "reader_named_files";

export type SuspectOutcome =
  /** A separated top candidate; rows printed with scores. */
  | "ranked"
  /** Rows printed with scores, and no clear air between the top two. */
  | "no_separation"
  /** Nothing touched these files in the window. */
  | "no_touch"
  /** The falsifier gate, or this team's attribution setting, printed no rows. */
  | "withheld";

export interface SuspectCandidate {
  readonly sessionId: string;
  readonly agentKind: string;
  readonly branch: string;
  readonly workContextId: string;
  readonly workContextTitle: string;
  readonly intent: Record<string, unknown> | null;
  readonly lastActiveAt: string;
  /** Pinned paths this context touched. */
  readonly overlap: number;
  /** That author's distinct file touches on this repo in the window. */
  readonly authorTouches: number;
  /** overlap / authorTouches — see rule 2. */
  readonly lift: number;
  readonly sources: readonly string[];
  readonly readerMuted: boolean;
  readonly isSelf: boolean;
}

export interface SuspectView {
  readonly outcome: SuspectOutcome;
  readonly falsifier: {
    readonly kind: SuspectFalsifierKind;
    readonly at: string | null;
    readonly check: string | null;
  };
  readonly scope: {
    readonly kind: "pin" | "paths";
    readonly pinId: string | null;
    readonly surface: string | null;
    readonly files: readonly string[];
  };
  readonly totals: {
    /** Contexts that touched the surface in the window — the whole of it. */
    readonly sessionsTouching: number;
    /** How many of them the read bound scored. Below the total = cut. */
    readonly sessionsScored: number;
    readonly windowDays: number;
  };
  /** This team's setting, printed with the answer so silence is explicable. */
  readonly attribution: TeamSuspectAttribution;
  readonly candidates: readonly SuspectCandidate[];
}

export interface SuspectScope {
  readonly kind: "pin" | "paths";
  readonly pinId: string | null;
  readonly surface: string | null;
  readonly files: readonly string[];
  readonly falsifierKind: SuspectFalsifierKind;
  readonly falsifierAt: string | null;
  readonly check: string | null;
}

export type ScopeResult =
  | { readonly ok: true; readonly scope: SuspectScope }
  | { readonly ok: false; readonly reason: "pin_not_found" | "repo_mismatch" };

/**
 * Turns "pin=pin_playback" or "path=a&path=b" into the file set plus the
 * falsifier state. The gate is decided HERE, hub-side, and never by the
 * caller: a client-side falsifier check is a client-side promise.
 */
export const resolveSuspectScope = async (
  deps: Deps,
  repo: string,
  input: { readonly pinId?: string; readonly paths: readonly string[] },
): Promise<ScopeResult> => {
  if (input.pinId === undefined) {
    return {
      ok: true,
      scope: {
        kind: "paths",
        pinId: null,
        surface: null,
        files: input.paths,
        // No pin means no recorded claim to falsify: the reader is asserting
        // the breakage themselves, and the renderer says exactly that.
        falsifierKind: "reader_named_files",
        falsifierAt: null,
        check: null,
      },
    };
  }
  const pin = await readPin(deps, input.pinId);
  if (pin === null) {
    return { ok: false, reason: "pin_not_found" };
  }
  if (pin.repo !== repo) {
    return { ok: false, reason: "repo_mismatch" };
  }
  const falsifierKind: SuspectFalsifierKind =
    pin.check === null
      ? "no_check_recipe"
      : pin.brokeAt === null
        ? "not_recorded_broken"
        : "recorded_break";
  return {
    ok: true,
    scope: {
      kind: "pin",
      pinId: pin.id,
      surface: pin.surface,
      files: pin.files.map((file) => file.path),
      falsifierKind,
      falsifierAt: pin.brokeAt,
      check: pin.check,
    },
  };
};

interface CandidateRow {
  readonly workContextId: string;
  readonly workContextTitle: string;
  readonly intent: Record<string, unknown> | null;
  readonly sessionId: string;
  readonly agentKind: string;
  readonly branch: string;
  readonly developerId: string;
  readonly lastActiveAt: Date;
  readonly overlap: number;
  /** That author's own distinct file touches on this repo in the window. */
  readonly authorTouches: number;
  readonly sources: readonly string[];
}

/**
 * The intersection AND its ranking, in ONE bounded query.
 *
 * THE BOUND MUST NOT DECIDE WHAT THE RANKING DECIDES (rule 2). An earlier
 * shape ordered this query by `count(distinct value) desc` and cut at
 * SUSPECT_MAX_CANDIDATES — so the candidate SET was chosen by raw overlap and
 * only the survivors were then scored by lift. Measured at the boundary: with
 * 50 sweep contexts of overlap 2 and one focused session of overlap 1 and
 * lift 1.00, the focused session was ABSENT from the answer entirely, and the
 * printed outcome was "no separated suspect" over three sweeps 26x weaker.
 * The busiest person won anyway, one layer below the metric that exists to
 * stop exactly that.
 *
 * So LIFT IS COMPUTED IN SQL and the bound cuts the lowest scores. The
 * denominator — each author's own distinct file touches on this repo in the
 * window — is the second CTE, restricted to the authors who reached the
 * intersection, so its cost follows the people who touched these files rather
 * than the corpus. A row this bound drops therefore scored below every row it
 * kept, and `suspectSessions` says the list was cut rather than implying the
 * cut rows did not exist.
 *
 * THE TOTAL COMES FROM THE SAME QUERY, before the bound: `count(*) over ()`
 * is evaluated over the whole intersection, so the printed denominator is the
 * number of contexts that touched the surface rather than the number the
 * LIMIT had room for.
 */
interface CandidateSet {
  readonly rows: readonly CandidateRow[];
  /** Contexts that touched these files in the window, BEFORE the bound. */
  readonly totalTouching: number;
}

const readCandidates = async (
  deps: Deps,
  repo: string,
  files: readonly string[],
  since: Date,
): Promise<CandidateSet> => {
  if (files.length === 0) {
    return { rows: [], totalTouching: 0 };
  }
  const activity = sql`coalesce(${workContexts.updatedAt}, ${workContexts.createdAt})`;
  const touching = deps.db.$with("touching").as(
    deps.db
      .select({
        // Aliased one by one: `work_contexts.id` and `agent_sessions.id` both
        // land in this CTE, and an unaliased pair makes every later reference
        // to "id" ambiguous — a runtime error, not a type error.
        workContextId: sql<string>`${workContexts.id}`.as("work_context_id"),
        workContextTitle: sql<string>`${workContexts.title}`.as("work_context_title"),
        intent: sql<Record<string, unknown> | null>`${workContexts.intent}`.as("intent"),
        sessionId: sql<string>`${agentSessions.id}`.as("session_id"),
        agentKind: sql<string>`${agentSessions.agentKind}`.as("agent_kind"),
        branch: sql<string>`${agentSessions.branch}`.as("branch"),
        developerId: sql<string>`${agentSessions.developerId}`.as("developer_id"),
        lastActiveAt: sql<Date>`${activity}`.as("last_active_at"),
        overlap: sql<number>`count(distinct ${workContextTargets.value})`.as("overlap"),
        sources: sql<string[]>`array_agg(distinct ${workContextTargets.source})`.as("sources"),
      })
      .from(workContextTargets)
      .innerJoin(
        workContexts,
        eq(workContextTargets.workContextId, workContexts.id),
      )
      .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
      .where(
        and(
          eq(workContextTargets.kind, "file"),
          inArray(workContextTargets.value, [...files]),
          eq(agentSessions.repo, repo),
          gt(sql`${activity}`, since),
        ),
      )
      .groupBy(
        workContexts.id,
        workContexts.title,
        workContexts.intent,
        agentSessions.id,
        agentSessions.agentKind,
        agentSessions.branch,
        agentSessions.developerId,
      ),
  );
  const windowTouches = deps.db.$with("window_touches").as(
    deps.db
      .select({
        // `author_id`, not `developer_id`: the alias is unique across both
        // CTEs so the join predicate below names one column, not two.
        authorId: sql<string>`${agentSessions.developerId}`.as("author_id"),
        touches: sql<number>`count(distinct ${workContextTargets.value})`.as("touches"),
      })
      .from(workContextTargets)
      .innerJoin(
        workContexts,
        eq(workContextTargets.workContextId, workContexts.id),
      )
      .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
      .where(
        and(
          eq(workContextTargets.kind, "file"),
          eq(agentSessions.repo, repo),
          gt(sql`${activity}`, since),
          sql`${agentSessions.developerId} in (select "developer_id" from "touching")`,
        ),
      )
      .groupBy(agentSessions.developerId),
  );
  // Never zero, and never below the overlap itself: this author touched at
  // least the overlapping files, so the floor keeps the ratio finite even if
  // the two halves disagree after a concurrent write.
  const authorTouches = sql<number>`greatest(coalesce(${windowTouches.touches}, ${touching.overlap}), ${touching.overlap}, 1)`;
  const rows = await deps.db
    .with(touching, windowTouches)
    .select({
      workContextId: touching.workContextId,
      workContextTitle: touching.workContextTitle,
      intent: touching.intent,
      sessionId: touching.sessionId,
      agentKind: touching.agentKind,
      branch: touching.branch,
      developerId: touching.developerId,
      lastActiveAt: touching.lastActiveAt,
      overlap: touching.overlap,
      sources: touching.sources,
      authorTouches: sql<number>`${authorTouches}`,
      totalTouching: sql<number>`count(*) over ()`,
    })
    .from(touching)
    .leftJoin(windowTouches, eq(windowTouches.authorId, touching.developerId))
    // The SAME total order suspectSessions re-applies to these rows, so the
    // bound and the printed ranking can never disagree about which row is top.
    .orderBy(
      sql`${touching.overlap}::float8 / ${authorTouches} desc`,
      sql`${touching.overlap} desc`,
      sql`${touching.sessionId} asc`,
    )
    .limit(SUSPECT_MAX_CANDIDATES);
  return {
    // Every row carries the same window count; no rows means nothing touched.
    totalTouching: Number(rows[0]?.totalTouching ?? 0),
    rows: rows.map((row) => ({
      workContextId: row.workContextId,
      workContextTitle: row.workContextTitle,
      intent: row.intent ?? null,
      sessionId: row.sessionId,
      agentKind: row.agentKind,
      branch: row.branch,
      developerId: row.developerId,
      lastActiveAt:
        row.lastActiveAt instanceof Date
          ? row.lastActiveAt
          : new Date(String(row.lastActiveAt)),
      overlap: Number(row.overlap),
      authorTouches: Number(row.authorTouches),
      sources: expandSources(row.sources ?? []),
    })),
  };
};

/**
 * "both" is one STORED value standing for two observations, so it expands
 * back into the pair the reader cares about. Sorted, so two rows with the
 * same evidence read the same way.
 */
const expandSources = (stored: readonly string[]): readonly string[] => {
  const expanded = new Set<string>();
  for (const value of stored) {
    if (value === "both") {
      expanded.add("tool_edit");
      expanded.add("git_diff");
      continue;
    }
    expanded.add(value);
  }
  return [...expanded].sort();
};

/** The reader's mute list, read once — a label on the row, never a filter. */
const readMutedAuthors = async (
  deps: Deps,
  readerDeveloperId: string,
  developerIds: readonly string[],
): Promise<ReadonlySet<string>> => {
  if (developerIds.length === 0) {
    return new Set();
  }
  const rows = await deps.db
    .select({ mutedDeveloperId: developerMutes.mutedDeveloperId })
    .from(developerMutes)
    .where(
      and(
        eq(developerMutes.readerDeveloperId, readerDeveloperId),
        inArray(developerMutes.mutedDeveloperId, [...developerIds]),
      ),
    );
  return new Set(rows.map((row) => row.mutedDeveloperId));
};

/**
 * "Is there a suspect, or only a list?" — the top score must be at least
 * SUSPECT_SEPARATION_RATIO times the runner-up's. One candidate is separated
 * by definition; a tie is not, and says so.
 */
const separated = (candidates: readonly SuspectCandidate[]): boolean => {
  const top = candidates[0];
  if (top === undefined) {
    return false;
  }
  const runnerUp = candidates[1];
  if (runnerUp === undefined) {
    return true;
  }
  return top.lift >= runnerUp.lift * SUSPECT_SEPARATION_RATIO;
};

export interface SuspectInput {
  readonly repo: string;
  readonly scope: SuspectScope;
  /** This team's setting: "sessions" names them, "counts_only" does not. */
  readonly attribution: TeamSuspectAttribution;
}

/**
 * The whole answer, including the ones that name nobody. Every branch here
 * returns a VIEW rather than an empty list: "no session touched these files"
 * and "the check was never run" are different facts, and a reader who cannot
 * tell them apart learns nothing from either.
 */
export const suspectSessions = async (
  deps: Deps,
  readerDeveloperId: string,
  input: SuspectInput,
): Promise<SuspectView> => {
  const since = new Date(deps.now().getTime() - SUSPECT_WINDOW_DAYS * MS_PER_DAY);
  const { rows, totalTouching } = await readCandidates(
    deps,
    input.repo,
    input.scope.files,
    since,
  );
  const base = {
    falsifier: {
      kind: input.scope.falsifierKind,
      at: input.scope.falsifierAt,
      check: input.scope.check,
    },
    scope: {
      kind: input.scope.kind,
      pinId: input.scope.pinId,
      surface: input.scope.surface,
      files: input.scope.files,
    },
    totals: {
      // The WHOLE intersection, and how much of it was scored. A total taken
      // from the bounded array under-reports by exactly the rows the reader
      // is never told about, and `pin list` already solved this one level up
      // ("showing 200 of 250"). Two numbers, so the renderer can say which.
      sessionsTouching: totalTouching,
      sessionsScored: rows.length,
      windowDays: SUSPECT_WINDOW_DAYS,
    },
    attribution: input.attribution,
  } as const;
  // THE GATE. A pin nobody has falsified names nobody — and the counts still
  // print, so the reader can see there IS something to look at once they have
  // run the check.
  const gated =
    input.scope.falsifierKind === "not_recorded_broken" ||
    input.scope.falsifierKind === "no_check_recipe";
  if (gated || input.attribution === "counts_only") {
    return { ...base, outcome: "withheld", candidates: [] };
  }
  if (rows.length === 0) {
    return { ...base, outcome: "no_touch", candidates: [] };
  }
  const developerIds = [...new Set(rows.map((row) => row.developerId))];
  const muted = await readMutedAuthors(deps, readerDeveloperId, developerIds);
  const candidates: SuspectCandidate[] = rows
    .map((row) => {
      // The denominator the QUERY already ranked by: recomputing it here
      // would let the printed score disagree with the order the bound cut on.
      const authorTouches = row.authorTouches;
      return {
        sessionId: row.sessionId,
        agentKind: row.agentKind,
        branch: row.branch,
        workContextId: row.workContextId,
        workContextTitle: row.workContextTitle,
        intent: row.intent,
        lastActiveAt: row.lastActiveAt.toISOString(),
        overlap: row.overlap,
        authorTouches,
        lift: row.overlap / authorTouches,
        sources: row.sources,
        readerMuted: muted.has(row.developerId),
        isSelf: row.developerId === readerDeveloperId,
      };
    })
    .sort((left, right) => {
      if (right.lift !== left.lift) {
        return right.lift - left.lift;
      }
      if (right.overlap !== left.overlap) {
        return right.overlap - left.overlap;
      }
      // Deterministic tail: the same query twice must print the same order,
      // or two readers comparing notes see two different "top suspects".
      return left.sessionId < right.sessionId ? -1 : 1;
    });
  const top = candidates.slice(0, SUSPECT_TOP_CANDIDATES);
  return {
    ...base,
    outcome: separated(top) ? "ranked" : "no_separation",
    candidates: top,
  };
};
