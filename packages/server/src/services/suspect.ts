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
    readonly filesTruncated: boolean;
  };
  readonly totals: {
    readonly sessionsTouching: number;
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
  readonly filesTruncated: boolean;
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
        filesTruncated: false,
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
      filesTruncated: false,
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
  readonly sources: readonly string[];
}

/**
 * The intersection, in ONE bounded query. It is driven by the path list
 * through `work_context_targets_kind_value_idx`, so its cost grows with how
 * many contexts touched THESE files — never with the size of the corpus —
 * and the repo and window predicates run inside the WHERE rather than after
 * the bound, so a busy neighbouring repo cannot crowd real candidates out.
 */
const readCandidates = async (
  deps: Deps,
  repo: string,
  files: readonly string[],
  since: Date,
): Promise<readonly CandidateRow[]> => {
  if (files.length === 0) {
    return [];
  }
  const activity = sql`coalesce(${workContexts.updatedAt}, ${workContexts.createdAt})`;
  const rows = await deps.db
    .select({
      workContextId: workContexts.id,
      workContextTitle: workContexts.title,
      intent: workContexts.intent,
      sessionId: agentSessions.id,
      agentKind: agentSessions.agentKind,
      branch: agentSessions.branch,
      developerId: agentSessions.developerId,
      lastActiveAt: sql<Date>`${activity}`,
      overlap: sql<number>`count(distinct ${workContextTargets.value})`,
      sources: sql<string[]>`array_agg(distinct ${workContextTargets.source})`,
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
    )
    .orderBy(sql`count(distinct ${workContextTargets.value}) desc`)
    .limit(SUSPECT_MAX_CANDIDATES);
  return rows.map((row) => ({
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
    sources: expandSources(row.sources ?? []),
  }));
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

/**
 * THE DENOMINATOR: each candidate author's own distinct file touches on this
 * repo inside the window. One grouped query over the candidate authors —
 * bounded by the candidate set (at most SUSPECT_MAX_CANDIDATES authors) and
 * by the window, never by the corpus.
 */
const readAuthorTouches = async (
  deps: Deps,
  repo: string,
  developerIds: readonly string[],
  since: Date,
): Promise<ReadonlyMap<string, number>> => {
  if (developerIds.length === 0) {
    return new Map();
  }
  const activity = sql`coalesce(${workContexts.updatedAt}, ${workContexts.createdAt})`;
  const rows = await deps.db
    .select({
      developerId: agentSessions.developerId,
      touches: sql<number>`count(distinct ${workContextTargets.value})`,
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
        inArray(agentSessions.developerId, [...developerIds]),
        gt(sql`${activity}`, since),
      ),
    )
    .groupBy(agentSessions.developerId);
  return new Map(rows.map((row) => [row.developerId, Number(row.touches)]));
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
  const rows = await readCandidates(deps, input.repo, input.scope.files, since);
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
      filesTruncated: input.scope.filesTruncated,
    },
    totals: {
      sessionsTouching: rows.length,
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
  const [touches, muted] = await Promise.all([
    readAuthorTouches(deps, input.repo, developerIds, since),
    readMutedAuthors(deps, readerDeveloperId, developerIds),
  ]);
  const candidates: SuspectCandidate[] = rows
    .map((row) => {
      // Never zero: this author touched at least the overlapping files, so
      // the floor keeps the ratio finite even if the denominator query and
      // the candidate query disagree after a concurrent write.
      const authorTouches = Math.max(
        touches.get(row.developerId) ?? row.overlap,
        row.overlap,
        1,
      );
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
