/**
 * Ghost commits, deterministic half (VISION.md §3): which teammate's LIVE
 * plan overlaps the reader's own, and on what. No model runs here and none
 * has to — this query alone yields a factual notice, and the model layer
 * above it (core derive/ghost/worker.ts) is gated on this returning a
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
 * PRECISION IS ONE EXCLUSION AND ONE QUALIFIER, both borrowed from ConE
 * (Maddila, Nagappan, Bird, Gousios, van Deursen, "ConE: A Concurrent Edit
 * Detection Tool for Large-scale Software Development", TOSEM 31(2), 2021),
 * the only deployed system in this space with published numbers — 775
 * notifications over 26 000 pull requests on 234 repositories, 554 of them
 * (71.5 %) rated useful:
 *
 *   - a HOT value is dropped (GHOST_HOT_TARGET_MAX_CONTEXTS): a lockfile or
 *     the config every session edits is not evidence of a plan. With the
 *     reader's own value list bounded per context (GHOST_MAX_PROBE_VALUES),
 *     the two together are also the fan-out bound — a PRODUCT, not a
 *     sentence about one value — so the N² crowding the solved surface had
 *     to measure at 1.2 s cannot arise here;
 *   - a MECHANICALLY GENERATED, NON-AUTHORITATIVE file is no evidence either
 *     (services/generated-targets.ts) — an authoritative one, a schema or a
 *     migration or what the repo declares, stays evidence:
 *     the hot rule needs twenty contexts to fire, so two people who had only
 *     run `npm install` and a codegen were warned about each other. A
 *     labelled row is kept, every read here asks for `generated IS NULL`, and
 *     a row that qualified on ordinary files counts the generated ones it
 *     also shares as `generatedSharedCount`;
 *   - a LARGE CHANGE is QUALIFIED, never dropped (GHOST_MAX_CONTEXT_TARGETS).
 *     ConE drops a pull request touching more than fifty files, and that
 *     rule, applied here, hid the pilot owner's 180-file worktree context
 *     from every collision check while a teammate edited two of its files.
 *     "A large surface must never mean not collision-relevant" (owner's
 *     reviewer, 2026-10-07): a file shared with a rename is weaker evidence
 *     than one shared with a focused plan, so the row says how large the
 *     change is and ranks after the focused rows — and every file it shares
 *     with the reader still produces it.
 *
 * SELF-EXCLUSION, PRESENCE OPT-OUT AND MUTE are in the WHERE of all THREE
 * queries — the two tiers AND the rarity pre-filter that decides which values
 * reach them (listCoolTargets) — never after a LIMIT. The pre-filter is the
 * one that is easy to forget and the one where forgetting it is worst: a
 * value's rarity decides whether a tier ever sees it, so a muted or opted-out
 * developer counted there would silently shape what the reader is shown while
 * staying invisible to them.
 *
 * LIVE MEANS UNFINISHED, not merely recent: an ended session and a landed
 * work context are both excluded on both sides (liveWorkConditions), because
 * inside a seven-day window most contexts on an active repo are branches
 * somebody already merged. The activity window decides how far back
 * unfinished work counts and nothing else.
 *
 * Derived fresh per read like the deterministic contradictions and the solved
 * matches — nothing stored, nothing to go stale, no ingest-order dependence.
 */
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import {
  GHOST_ACTIVE_WINDOW_DAYS,
  GHOST_FINGERPRINT_MIN_SHARED,
  GHOST_HOT_TARGET_MAX_CONTEXTS,
  GHOST_INTENT_MIN_TOKEN_HITS,
  GHOST_MAX_CONTEXT_TARGETS,
  GHOST_MAX_FINDINGS,
  GHOST_MAX_FINDINGS_PER_DEVELOPER,
  GHOST_MAX_INTENT_CANDIDATES,
  GHOST_MAX_OWN_CONTEXTS,
  GHOST_MAX_PAIR_ROWS,
  GHOST_MAX_PROBE_VALUES,
  GHOST_MAX_SHARED_SHOWN,
  GHOST_MIN_SHARED_TARGETS,
} from "../constants.ts";
import {
  agentSessions,
  developers,
  workContexts,
  workContextTargets,
} from "../db/schema.ts";
import { listGeneratedSharedWithReader, ordinaryTargetCondition } from "./generated-targets.ts";
import { targetInWindowSeenBy, targetTouchedAtSeenBy } from "./live-location.ts";
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
export const OVERLAP_TARGET_KINDS = ["error_fingerprint", "file", "symbol"] as const;

/**
 * The kind as the COLUMN types it, kept apart from `GhostSharedTarget.kind`
 * on the wire, which is an open string: a connector must be able to render a
 * row from a newer hub without this enum, and a query must not be able to
 * name a kind the column has never held.
 */
export type OverlapKind = (typeof OVERLAP_TARGET_KINDS)[number];

export interface SharedValue {
  readonly kind: OverlapKind;
  readonly value: string;
}

/** The one kind whose identity is CONTENT — see GHOST_FINGERPRINT_MIN_SHARED. */
const FINGERPRINT_KIND = "error_fingerprint";

/** The kind a large change is counted in: GHOST_MAX_CONTEXT_TARGETS counts files. */
const FILE_KIND = "file";

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
  /**
   * Files both sides carry that are labelled MECHANICALLY GENERATED AND
   * NON-AUTHORITATIVE on at least one side
   * (services/generated-targets.ts): never in the count above, never a
   * reason for this row, and stated so "2 of your files" is not read as
   * everything the two of you touched. 0 when there are none.
   */
  readonly generatedSharedCount: number;
  /** Distinct words of the READER'S own intent this context's doc matches. */
  readonly intentTokenHits: number;
  /**
   * The files THEIR change touched inside the window when that is more than
   * GHOST_MAX_CONTEXT_TARGETS — the qualifier the line prints — or null for a
   * focused one. Null on a row the intent tier alone found, too: that tier
   * shares no file, so the size of the change says nothing about it.
   */
  readonly largeChangeFiles: number | null;
}

/**
 * The files each of these contexts TOUCHED inside the window, for the ones
 * over GHOST_MAX_CONTEXT_TARGETS only — the size a qualified row states. A
 * QUALIFIER AND A RANK, NEVER A FILTER (see the header): nothing calls this to
 * decide whether an overlap exists, only how it is worded and where it sits.
 *
 * IN THE WINDOW, NOT EVER (pilot finding, 2026-10-05): a long-lived worktree
 * context touches hundreds of files over weeks, and counted over its life the
 * pilot owner's 180-file context read as a formatter run. A file counts when
 * it was first seen or touched again since `cutoff` (targetTouchedAt). For an
 * owner hidden from the viewer every file counts, her times unread
 * (targetInWindowSeenBy) — a count of her files, no more than the
 * `targetCount` the contexts listing already publishes for her.
 *
 * One grouped read over contexts already chosen — candidates that qualified,
 * or the page — riding the targets primary key, whose leading column is
 * work_context_id. It reads each context's own rows once; it is never a
 * factor of the pair computation, which never reads a context whole.
 */
export const listLargeChanges = async (
  db: Db,
  viewerDeveloperId: string,
  ids: readonly string[],
  cutoff: Date,
): Promise<ReadonlyMap<string, number>> => {
  if (ids.length === 0) {
    return new Map();
  }
  const files = sql<number>`count(*)::int`;
  const rows = await db
    .select({ workContextId: workContextTargets.workContextId, files })
    .from(workContextTargets)
    .innerJoin(workContexts, eq(workContexts.id, workContextTargets.workContextId))
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(
      and(
        inArray(workContextTargets.workContextId, [...ids]),
        eq(workContextTargets.kind, FILE_KIND),
        // A regenerated lockfile or client is not the size of anybody's
        // change: a focused plan beside `bun install` stays focused.
        ordinaryTargetCondition(),
        targetInWindowSeenBy(viewerDeveloperId, agentSessions.developerId, workContextTargets, cutoff),
      ),
    )
    .groupBy(workContextTargets.workContextId)
    .having(sql`count(*) > ${GHOST_MAX_CONTEXT_TARGETS}`);
  return new Map(rows.map((row) => [row.workContextId, Number(row.files)]));
};

/** One context's values, as a comparison reads them. */
export interface ContextValues {
  readonly workContextId: string;
  readonly values: readonly SharedValue[];
}

/**
 * THE PROBE: at most GHOST_MAX_PROBE_VALUES strong values of each context,
 * NEWEST TOUCH FIRST — the side of a comparison that is READ; the other side
 * is looked up by these values and never read whole (listPairRows, and the
 * conference's membership read). That is what keeps a large change visible
 * at a bounded price: its size decides neither whether it is compared nor
 * what the comparison costs.
 *
 * RANKED WITHIN EACH CONTEXT, in the database. Ranked across the set, one
 * renaming worktree of the reader's held more values than all of the probe,
 * and the context beside it — the one carrying the real plan — arrived empty
 * and the surface went silent. Newest first, so a long-lived context is read
 * by what it is doing now, and what a cut drops is its oldest touches.
 *
 * Every value of a context, old touches included, the way the looked-up side
 * has always been read: an old touch of a session still open is still in its
 * worktree. An owner hidden from the viewer is ranked by kind and value, her
 * touch times unread (targetTouchedAtSeenBy) — a probe ordered by them would
 * say which of her files she touched last.
 */
export const listProbeValues = async (
  db: Db,
  viewerDeveloperId: string,
  ids: readonly string[],
): Promise<readonly ContextValues[]> => {
  if (ids.length === 0) {
    return [];
  }
  const touched = targetTouchedAtSeenBy(viewerDeveloperId, agentSessions.developerId, workContextTargets);
  const ranked = db
    .select({
      workContextId: workContextTargets.workContextId,
      kind: workContextTargets.kind,
      value: workContextTargets.value,
      probeRank: sql<number>`row_number() over (partition by ${workContextTargets.workContextId} order by ${touched} desc nulls last, ${workContextTargets.kind} asc, ${workContextTargets.value} asc)`.as("probe_rank"),
    })
    .from(workContextTargets)
    .innerJoin(workContexts, eq(workContexts.id, workContextTargets.workContextId))
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(
      and(
        inArray(workContextTargets.workContextId, [...ids]),
        inArray(workContextTargets.kind, [...OVERLAP_TARGET_KINDS]),
        // Before the rank, not after it: a regenerated client must not spend
        // the probe's slots, and a file that is not evidence is never probed.
        ordinaryTargetCondition(),
      ),
    )
    .as("probe");
  const rows = await db
    .select({ workContextId: ranked.workContextId, kind: ranked.kind, value: ranked.value })
    .from(ranked)
    .where(lte(ranked.probeRank, GHOST_MAX_PROBE_VALUES))
    .orderBy(asc(ranked.workContextId), asc(ranked.probeRank));
  const byContext = new Map<string, SharedValue[]>();
  for (const row of rows) {
    byContext.set(row.workContextId, [
      ...(byContext.get(row.workContextId) ?? []),
      { kind: row.kind as OverlapKind, value: row.value },
    ]);
  }
  return [...byContext.entries()].map(([workContextId, values]) => ({ workContextId, values }));
};

/**
 * STILL LIVE WORK, on either side of the comparison — the predicate the
 * activity window alone cannot express.
 *
 * `coalesce(updated_at, created_at)` inside GHOST_ACTIVE_WINDOW_DAYS says a
 * row was TOUCHED recently. It does not say the work is unfinished, and on any
 * active repo most contexts inside a seven-day window are branches somebody
 * already merged: without these two predicates a briefing line reported a
 * session that ended six days ago, on a context that landed five days ago, as
 * a collision — which is DESIGN.md §10 risk 8's failure exactly, a warning
 * fired by ordinary co-location. `ended_at` is the session's own "I stopped",
 * `landed_at` is this codebase's "this already merged", and merged work
 * cannot collide with anything.
 *
 * WHAT IS DELIBERATELY NOT HERE is the tripwire's second predicate,
 * `last_heartbeat_at > presenceCutoff` (services/hints.ts listTargetSessions).
 * The tripwire fires at the instant of an edit and must therefore mean this
 * second; a ghost check answers "whose plan meets mine", and a teammate who
 * opened this branch yesterday and is at lunch is still in the reader's way.
 * So the horizon stays GHOST_ACTIVE_WINDOW_DAYS and the SURFACE stops
 * asserting the present tense instead (briefing/ghost.ts GHOST_SECTION_HEADER,
 * DESIGN.md §4) — one of the two had to give, and this is the half that costs
 * the reader nothing true.
 *
 * Presence opt-out and mute still apply on both tiers regardless: what this
 * discloses is presence-class whether or not the heartbeat is fresh.
 */
const liveWorkConditions = (): readonly SQL[] => [
  isNull(agentSessions.endedAt),
  isNull(workContexts.landedAt),
];

/**
 * `(kind, value) IN (…)` written as one OR branch per kind, so each branch is
 * an index range on work_context_targets_kind_value_idx. A flat OR over
 * tuples would be one branch per pair and a plan nobody can predict.
 */
export const targetValueCondition = (
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

export const activityExpression = sql`coalesce(${workContexts.updatedAt}, ${workContexts.createdAt})`;

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
        // My OWN finished work drives no comparison either: a plan that
        // landed is not a plan anybody can still collide with.
        ...liveWorkConditions(),
      ),
    )
    .orderBy(desc(activityExpression), asc(workContexts.id))
    .limit(GHOST_MAX_OWN_CONTEXTS);
  return rows.map((row) => ({ id: row.id, intentSummary: row.intentSummary }));
};

/**
 * The reader's own strong target values: the probe of each of my live
 * contexts (listProbeValues), deduplicated across them. A large change of
 * mine is compared like any other context of mine — its newest
 * GHOST_MAX_PROBE_VALUES values — and never spends the share of the context
 * beside it, so the bound below is an arithmetic ceiling rather than a race
 * between my own contexts: GHOST_MAX_OWN_CONTEXTS x GHOST_MAX_PROBE_VALUES.
 */
const listOwnTargets = async (
  deps: Deps,
  viewerDeveloperId: string,
  ownIds: readonly string[],
): Promise<readonly SharedValue[]> => {
  const probes = await listProbeValues(deps.db, viewerDeveloperId, ownIds);
  const seen = new Set<string>();
  return probes
    .flatMap((probe) => probe.values)
    .filter((target) => {
      const key = `${target.kind} ${target.value}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
};

/**
 * The reader's own values MINUS the hot ones — a lockfile, the router, the
 * config every session edits (GHOST_HOT_TARGET_MAX_CONTEXTS).
 *
 * IT COUNTS THE POPULATION THE READER COULD BE TOLD ABOUT, which is why the
 * same three predicates the two tiers carry are in this WHERE as well.
 * Counting everybody looked harmless — a lockfile is a lockfile whoever
 * touches it — and is not: a developer with nineteen live worktrees on one
 * repo, or nineteen contexts of a colleague the reader MUTED, or of one who
 * opted OUT of presence, pushes a value over the bar on their own, and the
 * teammate who really shares those two files then vanishes with no way to see
 * why. An invisible developer deciding what the reader is shown inverts the
 * intent of both controls, and the reader's own parallel worktrees —
 * GHOST_MAX_OWN_CONTEXTS exists to support them — would sabotage themselves.
 *
 * The bar therefore reads: how many contexts that could appear in this
 * reader's answer carry this value.
 */
const listCoolTargets = async (
  deps: Deps,
  viewerDeveloperId: string,
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
    .where(
      and(
        condition,
        eq(agentSessions.repo, repo),
        ne(agentSessions.developerId, viewerDeveloperId),
        visiblePresenceCondition(viewerDeveloperId, agentSessions.developerId),
        notMutedCondition(viewerDeveloperId, agentSessions.developerId),
        // The hot count is a count of EVIDENCE: a context that carries this
        // value only as a generated file adds nothing to its rarity.
        ordinaryTargetCondition(),
      ),
    )
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
 * for: the value list is the reader's own probe, and every value in it is
 * shared by at most GHOST_HOT_TARGET_MAX_CONTEXTS foreign contexts.
 * GHOST_MAX_PAIR_ROWS is exactly that product, so the LIMIT below is a safety
 * valve the query cannot reach rather than a budget the crowd competes for —
 * and it has to be, because this window cutting does not shorten the answer,
 * it corrupts the count the floor is read off (the constant records the
 * measurement).
 *
 * NO SIZE RULE IN THIS WHERE, and none may come back. A foreign context is
 * found by the values it shares with the reader, one index range per value,
 * so a 180-file change costs the two rows it shares and is never read whole;
 * dropping it for its size here is exactly what hid the pilot owner's context
 * (see the header). Its size is stated after the fact (listLargeChanges).
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
        ...liveWorkConditions(),
        // A ghost line says a named teammate is working on this NOW, which is
        // presence-class information: opt-out hides it, exactly as it hides
        // the tripwire (services/hints.ts listTargetSessions).
        visiblePresenceCondition(viewerDeveloperId, agentSessions.developerId),
        notMutedCondition(viewerDeveloperId, agentSessions.developerId),
        // THEIR side of a shared value must be ordinary too: a file their
        // connector labelled generated is not evidence of their plan, whatever
        // the reader's row says (services/generated-targets.ts).
        ordinaryTargetCondition(),
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
 *
 * NO SIZE RULE HERE, not even the qualifier. The large-change rule is an
 * argument about SHARING A FILE: a context touching fifty files shares files
 * with everybody, so a file shared with it is weak evidence. This tier shares
 * no value at all — it matches the reader's own intent words against the
 * foreign context's doc, which is built from its title, intent and claims and
 * knows nothing about its target count. A sixty-file implementation session
 * is ordinary work, not a rename, and excluding it here once silently deleted
 * VISION §3's own flagship case: two plans that touch no common file and
 * still collide. The tier keeps its own bar instead —
 * GHOST_INTENT_MIN_TOKEN_HITS distinct words — and its own bound,
 * GHOST_MAX_INTENT_CANDIDATES.
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
        ...liveWorkConditions(),
        sql`${workContexts.tsv} @@ ${anyToken}`,
        sql`${hits} >= ${GHOST_INTENT_MIN_TOKEN_HITS}`,
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
 * A stateful filter that lets each developer through at most
 * GHOST_MAX_FINDINGS_PER_DEVELOPER times. Applied to an ALREADY SORTED list,
 * so "the first one through" is that developer's strongest context.
 *
 * One person with three worktrees is one person, and a block they fill alone
 * is a block the teammate who is in the reader's way for a different reason
 * never reaches (the constant states the rule the questions block states for
 * itself). The doctor line counts the same way — distinct developers, not
 * rows — so "N teammates working where you are" is a fact about people.
 */
const withinPerDeveloperCap = (): ((entry: {
  readonly row: DisplayRow;
}) => boolean) => {
  const seen = new Map<string, number>();
  return ({ row }) => {
    const used = seen.get(row.developerId) ?? 0;
    if (used >= GHOST_MAX_FINDINGS_PER_DEVELOPER) {
      return false;
    }
    seen.set(row.developerId, used + 1);
    return true;
  };
};

interface RankedCandidate {
  readonly candidate: Candidate;
  readonly row: DisplayRow;
  readonly largeChangeFiles: number | null;
}

/**
 * Strongest reason first: a shared FAILURE — the identity of a failure,
 * whatever the size of the change it sits in — then FOCUSED rows before LARGE
 * CHANGES, then the most shared values, the most shared intent words, the
 * freshest. A large change ranks lower and never out: a file shared with a
 * rename is weaker evidence than one shared with a plan, so with more rows
 * than GHOST_MAX_FINDINGS it is the one that waits — and with room it is
 * shown, qualified.
 */
const byStrength = (left: RankedCandidate, right: RankedCandidate): number =>
  right.candidate.fingerprints - left.candidate.fingerprints ||
  Number(left.largeChangeFiles !== null) - Number(right.largeChangeFiles !== null) ||
  right.candidate.shared.length - left.candidate.shared.length ||
  right.candidate.intentTokenHits - left.candidate.intentTokenHits ||
  right.row.lastActiveAt.getTime() - left.row.lastActiveAt.getTime() ||
  left.candidate.id.localeCompare(right.candidate.id);

/**
 * Overlaps between the reader's live plan and their teammates' — strongest
 * reason first (byStrength). Bounded end to end: every query above carries a
 * named limit, and the finding cap is the last one.
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
    viewerDeveloperId,
    ownContexts.map((context) => context.id),
  );
  const coolTargets = await listCoolTargets(
    deps,
    viewerDeveloperId,
    repo,
    ownTargets,
  );
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

  const [display, large] = await Promise.all([
    hydrate(
      deps.db,
      candidates.map((candidate) => candidate.id),
    ),
    // Only rows that SHARE a value can be qualified by size — the intent
    // tier shares none (listIntentHits states why).
    listLargeChanges(
      deps.db,
      viewerDeveloperId,
      candidates.filter((candidate) => candidate.shared.length > 0).map((candidate) => candidate.id),
      cutoff,
    ),
  ]);
  const shown = candidates
    .flatMap((candidate) => {
      const row = display.get(candidate.id);
      return row === undefined ? [] : [{ candidate, row, largeChangeFiles: large.get(candidate.id) ?? null }];
    })
    .sort(byStrength)
    // Per DEVELOPER before per finding, and the order is the whole point:
    // the ranking has run, so what this drops is one person's WEAKER
    // contexts and never somebody else's only one.
    .filter(withinPerDeveloperCap())
    .slice(0, GHOST_MAX_FINDINGS);
  // A QUALIFIER, read for the rows shown and after they were chosen — it can
  // never make a row appear, only say what else the two sides share.
  const generatedShared = await listGeneratedSharedWithReader(
    deps.db,
    ownContexts.map((context) => context.id),
    shown.map(({ candidate }) => candidate.id),
  );
  return shown
    .map(({ candidate, row, largeChangeFiles }) => ({
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
      generatedSharedCount: generatedShared.get(candidate.id) ?? 0,
      intentTokenHits: candidate.intentTokenHits,
      largeChangeFiles,
    }));
};
