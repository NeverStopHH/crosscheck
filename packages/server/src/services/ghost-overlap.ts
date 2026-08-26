/**
 * Ghost commits, deterministic half (VISION.md §3): which teammate's LIVE
 * plan overlaps the reader's own, and on what. No model runs here and none
 * has to — this query alone yields a factual notice, and the model layer
 * above it (connector-claude ghost/worker.ts) is gated on this returning a
 * candidate, so a repo with no overlap costs no tokens at all.
 *
 * FOUR SIGNALS, ONE RULE EACH, no score. A foreign context qualifies when it
 * shares an error fingerprint with the reader (identity of a FAILURE — one is
 * enough), or GHOST_MIN_SHARED_TARGETS distinct files/symbols, or
 * GHOST_INTENT_MIN_TOKEN_HITS distinct words of the reader's own stated
 * intent. Each is a count somebody can check against the line they were
 * shown; none of them is a tuned float. The intent signal is the one that
 * earns this feature its name — VISION §3's "different files, incompatible
 * designs" case, which no target comparison can reach.
 *
 * WHAT IT MAY DISCLOSE, and why the answer is "nothing new". The shared
 * values on the wire are the INTERSECTION with the reader's own targets, so
 * every path this endpoint names is a path the caller's own session already
 * captured; no teammate's file list leaves the hub through it. Claim bodies
 * never leave through it either — a ghost row is a POINTER (title, author,
 * intent, id) and the anchoring asymmetry is untouched (DESIGN.md §4).
 *
 * PRECISION IS TWO EXCLUSIONS, both borrowed from ConE (Maddila, Nagappan,
 * Bird, Gousios, van Deursen, "ConE: A Concurrent Edit Detection Tool for
 * Large-scale Software Development", TOSEM 31(2), 2021), the only deployed
 * system in this space with published numbers — 775 notifications over
 * 26 000 pull requests on 234 repositories, 554 of them (71.5 %) rated
 * useful:
 *
 *   - a HOT value is dropped (GHOST_HOT_TARGET_MAX_CONTEXTS): a lockfile or
 *     the config every session edits is not evidence of a plan. With the
 *     reader's own value list bounded by the sweep rule, the two together are
 *     also the fan-out bound — a PRODUCT, not a sentence about one value —
 *     so the N² crowding the solved surface had to measure at 1.2 s cannot
 *     arise here;
 *   - a SWEEP is dropped from both sides (GHOST_MAX_CONTEXT_TARGETS): a
 *     context touching fifty values is a rename or a formatter run, and it
 *     would otherwise collide with everybody.
 *
 * Derived fresh per read like the deterministic contradictions and the solved
 * matches — nothing stored, nothing to go stale, no ingest-order dependence.
 */
import { and, asc, count, desc, eq, gte, inArray, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import {
  GHOST_ACTIVE_WINDOW_DAYS,
  GHOST_FINGERPRINT_MIN_SHARED,
  GHOST_HOT_TARGET_MAX_CONTEXTS,
  GHOST_INTENT_MIN_TOKEN_HITS,
  GHOST_MAX_CONTEXT_TARGETS,
  GHOST_MAX_FINDINGS,
  GHOST_MAX_INTENT_CANDIDATES,
  GHOST_MAX_OWN_CONTEXTS,
  GHOST_MAX_PAIR_ROWS,
  GHOST_MAX_SHARED_SHOWN,
  GHOST_MIN_SHARED_TARGETS,
} from "../constants.ts";
import {
  agentSessions,
  developers,
  workContexts,
  workContextTargets,
} from "../db/schema.ts";
import { ftsTokens } from "./search.ts";
import { notMutedCondition, visiblePresenceCondition } from "./visibility.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

/**
 * Target kinds an overlap may be built from, WEAKEST LAST because the sort
 * order is load-bearing: "error_fingerprint" < "file" < "symbol"
 * alphabetically, which is also strongest-first, so an ORDER BY on the kind
 * column gives the pair window to identity matches without a CASE.
 *
 * `component` is absent, and for the reason solved-matches states about
 * symbols: it is a coarse label ("auth", "the ingest pipeline") that recurs
 * across unrelated work, and this feeds a line asserting relevance unasked.
 */
const OVERLAP_TARGET_KINDS = ["error_fingerprint", "file", "symbol"] as const;

/**
 * The kind as the COLUMN types it, kept apart from `GhostSharedTarget.kind`
 * on the wire, which is an open string: a connector must be able to render a
 * row from a newer hub without this enum, and a query must not be able to
 * name a kind the column has never held.
 */
type OverlapKind = (typeof OVERLAP_TARGET_KINDS)[number];

interface SharedValue {
  readonly kind: OverlapKind;
  readonly value: string;
}

/** The one kind whose identity is CONTENT — see GHOST_FINGERPRINT_MIN_SHARED. */
const FINGERPRINT_KIND = "error_fingerprint";

const MS_PER_DAY = 86_400_000;

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

/** One value both sides carry, as the reader's own renderer names it. */
export interface GhostSharedTarget {
  readonly kind: string;
  readonly value: string;
}

export interface GhostOverlapView {
  /** THEIR work context — the id `get_diagnosis` reads. */
  readonly workContextId: string;
  readonly title: string;
  readonly developerId: string;
  readonly developerName: string;
  /** Their stated or derived intent, or null — rendered by the one fragment. */
  readonly intent: Record<string, unknown> | null;
  /** coalesce(updated_at, created_at): the age every surface prints. */
  readonly lastActiveAt: string;
  /**
   * The values BOTH sides carry, bounded at GHOST_MAX_SHARED_SHOWN. A subset
   * of the CALLER'S OWN targets by construction, which is what makes naming
   * them a disclosure of nothing (see the header).
   */
  readonly sharedTargets: readonly GhostSharedTarget[];
  /** Distinct shared values in total — the line says "2 of your files". */
  readonly sharedTargetCount: number;
  /** Distinct words of the READER'S own intent this context's doc matches. */
  readonly intentTokenHits: number;
}

/**
 * A context carrying more than GHOST_MAX_CONTEXT_TARGETS values is a sweep,
 * not a plan (see the header). Correlated, and cheap because the count rides
 * the targets primary key, whose leading column is work_context_id.
 */
const notASweepCondition = (contextId: SQL | AnyPgColumn): SQL =>
  sql`(
    SELECT count(*) FROM work_context_targets sweep_targets
     WHERE sweep_targets.work_context_id = ${contextId}
  ) <= ${GHOST_MAX_CONTEXT_TARGETS}`;

/**
 * `(kind, value) IN (…)` written as one OR branch per kind, so each branch is
 * an index range on work_context_targets_kind_value_idx. A flat OR over
 * tuples would be one branch per pair and a plan nobody can predict.
 */
const targetValueCondition = (
  targets: readonly SharedValue[],
): SQL | undefined => {
  const byKind = new Map<OverlapKind, string[]>();
  for (const target of targets) {
    byKind.set(target.kind, [...(byKind.get(target.kind) ?? []), target.value]);
  }
  const branches = [...byKind.entries()].map(([kind, values]) =>
    and(eq(workContextTargets.kind, kind), inArray(workContextTargets.value, values)),
  );
  return branches.length === 0 ? undefined : or(...branches);
};

const activityExpression = sql`coalesce(${workContexts.updatedAt}, ${workContexts.createdAt})`;

interface OwnContext {
  readonly id: string;
  readonly intentSummary: string | null;
}

/**
 * The reader's own live contexts on this repo, freshest first. Their intents
 * are the text side of the comparison; their targets are the value side.
 */
const listOwnContexts = async (
  deps: Deps,
  viewerDeveloperId: string,
  repo: string,
  cutoff: Date,
): Promise<readonly OwnContext[]> => {
  const rows = await deps.db
    .select({
      id: workContexts.id,
      intentSummary: sql<string | null>`${workContexts.intent} ->> 'summary'`,
    })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(
      and(
        eq(agentSessions.repo, repo),
        eq(agentSessions.developerId, viewerDeveloperId),
        gte(activityExpression, cutoff),
      ),
    )
    .orderBy(desc(activityExpression), asc(workContexts.id))
    .limit(GHOST_MAX_OWN_CONTEXTS);
  return rows.map((row) => ({ id: row.id, intentSummary: row.intentSummary }));
};

/**
 * The reader's own strong target values, with the sweep rule applied IN THE
 * QUERY: a context over the cap contributes NOTHING rather than an arbitrary
 * prefix of itself. The table has no timestamp, so "the newest 50 targets" is
 * not a thing this schema can answer honestly — dropping the whole context is
 * the rule that can be stated.
 *
 * THE EXCLUSION HAS TO BE THE DATABASE'S, not a filter over the rows that
 * came back, and that is not tidiness. With the sweeps admitted, one renaming
 * worktree of mine holds more targets than the whole read window my contexts
 * share, and the window is spent in id order — so the sweep took the budget
 * and the context beside it, the one carrying my real plan, arrived empty and
 * this surface went silent for me. Excluded here, every surviving context
 * carries at most GHOST_MAX_CONTEXT_TARGETS rows, which makes the bound below
 * an arithmetic ceiling rather than a race between my own contexts. It is
 * also the SAME predicate the foreign side applies (listPairRows), so "a
 * sweep is dropped from both sides" is now one rule rather than two spellings
 * that counted different kinds.
 */
const listOwnTargets = async (
  deps: Deps,
  ownIds: readonly string[],
): Promise<readonly SharedValue[]> => {
  if (ownIds.length === 0) {
    return [];
  }
  const rows = await deps.db
    .select({
      workContextId: workContextTargets.workContextId,
      kind: workContextTargets.kind,
      value: workContextTargets.value,
    })
    .from(workContextTargets)
    .where(
      and(
        inArray(workContextTargets.workContextId, [...ownIds]),
        inArray(workContextTargets.kind, [...OVERLAP_TARGET_KINDS]),
        notASweepCondition(workContextTargets.workContextId),
      ),
    )
    .orderBy(
      asc(workContextTargets.workContextId),
      asc(workContextTargets.kind),
      asc(workContextTargets.value),
    )
    // Every context left is under the cap, so this is what all of them
    // together can hold — no context can spend another's share.
    .limit(ownIds.length * GHOST_MAX_CONTEXT_TARGETS);
  const seen = new Set<string>();
  return rows
    .map((row) => ({ kind: row.kind as OverlapKind, value: row.value }))
    .filter((target) => {
      const key = `${target.kind} ${target.value}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
};

const listCoolTargets = async (
  deps: Deps,
  repo: string,
  ownTargets: readonly SharedValue[],
): Promise<readonly SharedValue[]> => {
  const condition = targetValueCondition(ownTargets);
  if (condition === undefined) {
    return [];
  }
  const rows = await deps.db
    .select({
      kind: workContextTargets.kind,
      value: workContextTargets.value,
      contexts: count(),
    })
    .from(workContextTargets)
    .innerJoin(
      workContexts,
      eq(workContexts.id, workContextTargets.workContextId),
    )
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(and(condition, eq(agentSessions.repo, repo)))
    .groupBy(workContextTargets.kind, workContextTargets.value);
  return rows
    .filter((row) => row.contexts <= GHOST_HOT_TARGET_MAX_CONTEXTS)
    .map((row) => ({ kind: row.kind as OverlapKind, value: row.value }));
};

interface PairRow {
  readonly theirId: string;
  readonly kind: string;
  readonly value: string;
}

/**
 * (their context, kind, value) for every non-hot value the reader also holds,
 * on a live foreign context of this repo.
 *
 * BOUNDED BEFORE IT MULTIPLIES, the lesson services/solved-matches.ts paid
 * for: the value list is the reader's own and capped by the sweep rule, and
 * every value in it is shared by at most GHOST_HOT_TARGET_MAX_CONTEXTS
 * foreign contexts. GHOST_MAX_PAIR_ROWS is exactly that product, so the LIMIT
 * below is a safety valve the query cannot reach rather than a budget the
 * crowd competes for — and it has to be, because this window cutting does not
 * shorten the answer, it corrupts the count the floor is read off (the
 * constant records the measurement).
 */
const listPairRows = async (
  deps: Deps,
  viewerDeveloperId: string,
  repo: string,
  coolTargets: readonly SharedValue[],
  cutoff: Date,
): Promise<readonly PairRow[]> => {
  const condition = targetValueCondition(coolTargets);
  if (condition === undefined) {
    return [];
  }
  const rows = await deps.db
    .selectDistinct({
      theirId: workContextTargets.workContextId,
      kind: workContextTargets.kind,
      value: workContextTargets.value,
    })
    .from(workContextTargets)
    .innerJoin(
      workContexts,
      eq(workContexts.id, workContextTargets.workContextId),
    )
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(
      and(
        condition,
        eq(agentSessions.repo, repo),
        // Self-exclusion in the WHERE, never after the LIMIT: a developer
        // with three worktrees on one repo must not fill their own window
        // with themselves (DESIGN.md §4, the tripwire's rule).
        ne(agentSessions.developerId, viewerDeveloperId),
        gte(activityExpression, cutoff),
        notASweepCondition(workContextTargets.workContextId),
        // A ghost line says a named teammate is working on this NOW, which is
        // presence-class information: opt-out hides it, exactly as it hides
        // the tripwire (services/hints.ts listTargetSessions).
        visiblePresenceCondition(viewerDeveloperId, agentSessions.developerId),
        notMutedCondition(viewerDeveloperId, agentSessions.developerId),
      ),
    )
    // Kind first, and OVERLAP_TARGET_KINDS says why that is also
    // strongest-first; then a stable order so repeated reads answer alike.
    .orderBy(
      asc(workContextTargets.kind),
      asc(workContextTargets.value),
      asc(workContextTargets.workContextId),
    )
    .limit(GHOST_MAX_PAIR_ROWS);
  return rows;
};

/**
 * Foreign live contexts whose searchable doc matches enough distinct words of
 * the READER'S OWN intent — the tier that reaches two plans sharing no file.
 *
 * The inputs are the reader's own intents, never the repo's: an intent is a
 * sentence about what ONE developer is doing, and matching teammates against
 * each other's sentences would put lines in this briefing about a topic
 * nobody here raised (the argument solved-matches.ts makes for the same tier).
 */
const listIntentHits = async (
  deps: Deps,
  viewerDeveloperId: string,
  repo: string,
  ownContexts: readonly OwnContext[],
  cutoff: Date,
): Promise<ReadonlyMap<string, number>> => {
  const summaries = ownContexts.flatMap((context) =>
    context.intentSummary === null ? [] : [context.intentSummary],
  );
  const tokens = ftsTokens(summaries.join(" "));
  if (tokens.length < GHOST_INTENT_MIN_TOKEN_HITS) {
    return new Map();
  }
  // One 0/1 term per distinct word, summed: the count the floor is stated in.
  // Stopwords cost nothing — plainto_tsquery drops them, so their term is 0
  // for every row rather than a free hit on all of them.
  const hits = sql<number>`(${sql.join(
    tokens.map(
      (token) =>
        sql`(case when ${workContexts.tsv} @@ plainto_tsquery('english', ${token}) then 1 else 0 end)`,
    ),
    sql` + `,
  )})`;
  // The GIN prefilter first (work_contexts_tsv_idx), so the per-row sum is
  // only ever computed for rows matching at least one word.
  const anyToken = sql`websearch_to_tsquery('english', ${tokens.join(" or ")})`;
  const rows = await deps.db
    .select({ id: workContexts.id, hits })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(
      and(
        eq(agentSessions.repo, repo),
        ne(agentSessions.developerId, viewerDeveloperId),
        gte(activityExpression, cutoff),
        sql`${workContexts.tsv} @@ ${anyToken}`,
        sql`${hits} >= ${GHOST_INTENT_MIN_TOKEN_HITS}`,
        notASweepCondition(workContexts.id),
        visiblePresenceCondition(viewerDeveloperId, agentSessions.developerId),
        notMutedCondition(viewerDeveloperId, agentSessions.developerId),
      ),
    )
    .orderBy(desc(hits), desc(activityExpression), asc(workContexts.id))
    .limit(GHOST_MAX_INTENT_CANDIDATES);
  return new Map(rows.map((row) => [row.id, Number(row.hits)]));
};

interface DisplayRow {
  readonly title: string;
  readonly developerId: string;
  readonly developerName: string;
  readonly intent: Record<string, unknown> | null;
  readonly lastActiveAt: Date;
}

const hydrate = async (
  db: Db,
  ids: readonly string[],
): Promise<ReadonlyMap<string, DisplayRow>> => {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      id: workContexts.id,
      title: workContexts.title,
      intent: workContexts.intent,
      developerId: agentSessions.developerId,
      developerName: developers.name,
      lastActiveAt: sql<string>`coalesce(${workContexts.updatedAt}, ${workContexts.createdAt})`,
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
        developerId: row.developerId,
        developerName: row.developerName,
        intent: row.intent ?? null,
        lastActiveAt: new Date(row.lastActiveAt),
      },
    ]),
  );
};

interface Candidate {
  readonly id: string;
  readonly shared: readonly SharedValue[];
  readonly fingerprints: number;
  readonly intentTokenHits: number;
}

/**
 * The floor, in the words the constants are named in: one shared error
 * fingerprint, or GHOST_MIN_SHARED_TARGETS shared values of any strong kind,
 * or GHOST_INTENT_MIN_TOKEN_HITS distinct intent words. Stated as one
 * predicate so there is a single place the bar can be lowered.
 */
const qualifies = (candidate: Candidate): boolean =>
  candidate.fingerprints >= GHOST_FINGERPRINT_MIN_SHARED ||
  candidate.shared.length >= GHOST_MIN_SHARED_TARGETS ||
  candidate.intentTokenHits >= GHOST_INTENT_MIN_TOKEN_HITS;

/**
 * Overlaps between the reader's live plan and their teammates' — strongest
 * reason first (a shared failure, then the most shared values, then the most
 * shared intent words), then the freshest. Bounded end to end: every query
 * above carries a named limit, and the finding cap is the last one.
 */
export const listGhostOverlaps = async (
  deps: Deps,
  viewerDeveloperId: string,
  repo: string,
): Promise<readonly GhostOverlapView[]> => {
  const cutoff = new Date(
    deps.now().getTime() - GHOST_ACTIVE_WINDOW_DAYS * MS_PER_DAY,
  );
  const ownContexts = await listOwnContexts(deps, viewerDeveloperId, repo, cutoff);
  if (ownContexts.length === 0) {
    // No live plan of my own means nothing to collide WITH: silence, not a
    // repo-wide listing of who is busy (that is what presence is for).
    return [];
  }
  const ownTargets = await listOwnTargets(
    deps,
    ownContexts.map((context) => context.id),
  );
  const coolTargets = await listCoolTargets(deps, repo, ownTargets);
  // The two tiers read different tables and neither needs the other's answer.
  const [pairs, intentHits] = await Promise.all([
    listPairRows(deps, viewerDeveloperId, repo, coolTargets, cutoff),
    listIntentHits(deps, viewerDeveloperId, repo, ownContexts, cutoff),
  ]);
  if (pairs.length === 0 && intentHits.size === 0) {
    return [];
  }

  const byContext = new Map<string, SharedValue[]>();
  for (const pair of pairs) {
    byContext.set(pair.theirId, [
      ...(byContext.get(pair.theirId) ?? []),
      { kind: pair.kind as OverlapKind, value: pair.value },
    ]);
  }
  const candidates: readonly Candidate[] = [
    ...new Set([...byContext.keys(), ...intentHits.keys()]),
  ]
    .map((id) => {
      const shared = byContext.get(id) ?? [];
      return {
        id,
        shared,
        fingerprints: shared.filter((target) => target.kind === FINGERPRINT_KIND)
          .length,
        intentTokenHits: intentHits.get(id) ?? 0,
      };
    })
    .filter(qualifies);
  if (candidates.length === 0) {
    return [];
  }

  const display = await hydrate(
    deps.db,
    candidates.map((candidate) => candidate.id),
  );
  return candidates
    .flatMap((candidate) => {
      const row = display.get(candidate.id);
      return row === undefined ? [] : [{ candidate, row }];
    })
    .sort(
      (left, right) =>
        right.candidate.fingerprints - left.candidate.fingerprints ||
        right.candidate.shared.length - left.candidate.shared.length ||
        right.candidate.intentTokenHits - left.candidate.intentTokenHits ||
        right.row.lastActiveAt.getTime() - left.row.lastActiveAt.getTime() ||
        left.candidate.id.localeCompare(right.candidate.id),
    )
    .slice(0, GHOST_MAX_FINDINGS)
    .map(({ candidate, row }) => ({
      workContextId: candidate.id,
      title: row.title,
      developerId: row.developerId,
      developerName: row.developerName,
      intent: row.intent,
      lastActiveAt: row.lastActiveAt.toISOString(),
      // Strongest kind first on the line too, so a truncated list keeps the
      // values the reader would have wanted to see.
      sharedTargets: [...candidate.shared]
        .sort(
          (left, right) =>
            left.kind.localeCompare(right.kind) ||
            left.value.localeCompare(right.value),
        )
        .slice(0, GHOST_MAX_SHARED_SHOWN),
      sharedTargetCount: candidate.shared.length,
      intentTokenHits: candidate.intentTokenHits,
    }));
};
