/**
 * Solved trees matching CURRENT work — the "solved before" surface
 * (VISION.md §1). Deterministic and strong by construction: a solved tree
 * qualifies only through target IDENTITY with a context active inside the
 * recency window, and only for the two highest-precision kinds (error
 * fingerprint ≻ file). Symbols and components recur across unrelated work,
 * and this feeds a SessionStart line that asserts relevance unasked — the
 * anchoring bar is the briefing's, not search's.
 *
 * Derived fresh per read like the deterministic contradictions — no stored
 * pairs, no ingest-order dependence, nothing to go stale.
 */
import { and, asc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
  SOLVED_MATCH_ACTIVE_WINDOW_DAYS,
  SOLVED_MATCH_MAX_FINDINGS,
  SOLVED_MATCH_MAX_PAIR_ROWS,
} from "../constants.ts";
import {
  agentSessions,
  developers,
  workContexts,
  workContextTargets,
} from "../db/schema.ts";
import { listSolvedInfo } from "./solved.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

/** Strong-match target kinds, most precise first. */
const MATCH_TARGET_KINDS = ["error_fingerprint", "file"] as const;

const MS_PER_DAY = 86_400_000;

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

export interface SolvedMatchView {
  readonly workContextId: string;
  readonly title: string;
  readonly developerName: string;
  readonly solvedAt: string;
  readonly landedAt: string | null;
  /** Which shared target kind carried the match — fingerprint wins ties. */
  readonly matchedTargetKind: string;
}

interface PairRow {
  readonly candidateId: string;
  readonly liveId: string;
  readonly kind: string;
}

/**
 * (candidate, live, kind) triples where candidate and live share a strong
 * target on this repo and the live side was active inside the window. Both
 * sides may still be unsolved here — solvedness is resolved after, in one
 * bounded lookup, because the solved rule is a claims-side predicate this
 * join has no business duplicating.
 */
const listSharedTargetPairs = async (
  deps: Deps,
  repo: string,
): Promise<readonly PairRow[]> => {
  const liveTargets = alias(workContextTargets, "live_targets");
  const liveContexts = alias(workContexts, "live_contexts");
  const liveSessions = alias(agentSessions, "live_sessions");
  const cutoff = new Date(
    deps.now().getTime() - SOLVED_MATCH_ACTIVE_WINDOW_DAYS * MS_PER_DAY,
  );
  return deps.db
    .selectDistinct({
      candidateId: workContextTargets.workContextId,
      liveId: liveTargets.workContextId,
      kind: workContextTargets.kind,
    })
    .from(workContextTargets)
    .innerJoin(
      liveTargets,
      and(
        eq(liveTargets.kind, workContextTargets.kind),
        eq(liveTargets.value, workContextTargets.value),
        ne(liveTargets.workContextId, workContextTargets.workContextId),
      ),
    )
    .innerJoin(
      workContexts,
      eq(workContexts.id, workContextTargets.workContextId),
    )
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .innerJoin(liveContexts, eq(liveContexts.id, liveTargets.workContextId))
    .innerJoin(liveSessions, eq(liveContexts.sessionId, liveSessions.id))
    .where(
      and(
        inArray(workContextTargets.kind, [...MATCH_TARGET_KINDS]),
        eq(agentSessions.repo, repo),
        eq(liveSessions.repo, repo),
        gte(
          sql`coalesce(${liveContexts.updatedAt}, ${liveContexts.createdAt})`,
          cutoff,
        ),
      ),
    )
    // LIMIT without ORDER BY hands the planner the choice of WHICH pairs
    // survive the cap — nondeterministic, and worst for exactly the rows
    // that matter most (one hot shared file can fill the window by itself).
    // Highest-precision kind first — "error_fingerprint" sorts before
    // "file", pinned by the crowded-window test — then stable id order so
    // repeated calls answer alike. SELECT DISTINCT restricts ORDER BY to
    // selected columns, which is why precedence rides on the kind value.
    .orderBy(
      asc(workContextTargets.kind),
      asc(workContextTargets.workContextId),
      asc(liveTargets.workContextId),
    )
    .limit(SOLVED_MATCH_MAX_PAIR_ROWS);
};

/** Display rows for the winning solved contexts, keyed by id. */
const hydrateMatches = async (
  db: Db,
  ids: readonly string[],
): Promise<
  ReadonlyMap<
    string,
    { title: string; developerName: string; landedAt: Date | null }
  >
> => {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      id: workContexts.id,
      title: workContexts.title,
      landedAt: workContexts.landedAt,
      developerName: developers.name,
    })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .innerJoin(developers, eq(agentSessions.developerId, developers.id))
    .where(inArray(workContexts.id, [...ids]));
  return new Map(
    rows.map((row) => [
      row.id,
      {
        title: row.title,
        developerName: row.developerName,
        landedAt: row.landedAt,
      },
    ]),
  );
};

/**
 * Solved trees sharing a strong target with currently active work on `repo`,
 * fingerprint matches first, then most recently solved. Bounded end to end:
 * pair rows, the solved lookup (over pair-bounded ids), the hydration, and
 * the finding cap are all named constants.
 */
export const listSolvedMatches = async (
  deps: Deps,
  repo: string,
): Promise<readonly SolvedMatchView[]> => {
  const pairs = await listSharedTargetPairs(deps, repo);
  if (pairs.length === 0) {
    return [];
  }
  const allIds = [
    ...new Set(pairs.flatMap((pair) => [pair.candidateId, pair.liveId])),
  ];
  const solvedInfo = await listSolvedInfo(deps.db, allIds);

  // A pair counts when the candidate is solved and the live side is NOT —
  // two solved trees sharing a fingerprint is history meeting history, not
  // current work meeting an answer.
  const byCandidate = new Map<string, { viaFingerprint: boolean }>();
  for (const pair of pairs) {
    if (!solvedInfo.has(pair.candidateId) || solvedInfo.has(pair.liveId)) {
      continue;
    }
    const known = byCandidate.get(pair.candidateId);
    byCandidate.set(pair.candidateId, {
      viaFingerprint:
        (known?.viaFingerprint ?? false) || pair.kind === "error_fingerprint",
    });
  }
  const winners = [...byCandidate.entries()]
    .map(([id, { viaFingerprint }]) => ({
      id,
      viaFingerprint,
      solvedAtMs: solvedInfo.get(id)?.getTime() ?? 0,
    }))
    .sort(
      (left, right) =>
        Number(right.viaFingerprint) - Number(left.viaFingerprint) ||
        right.solvedAtMs - left.solvedAtMs,
    )
    .slice(0, SOLVED_MATCH_MAX_FINDINGS);

  const display = await hydrateMatches(
    deps.db,
    winners.map((winner) => winner.id),
  );
  return winners.flatMap((winner) => {
    const row = display.get(winner.id);
    const solvedAt = solvedInfo.get(winner.id);
    if (row === undefined || solvedAt === undefined) {
      return [];
    }
    return [
      {
        workContextId: winner.id,
        title: row.title,
        developerName: row.developerName,
        solvedAt: solvedAt.toISOString(),
        landedAt: row.landedAt === null ? null : row.landedAt.toISOString(),
        matchedTargetKind: winner.viaFingerprint
          ? "error_fingerprint"
          : "file",
      },
    ];
  });
};
