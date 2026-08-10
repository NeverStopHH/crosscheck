/**
 * Hybrid search over work contexts (DESIGN.md §6).
 *
 * Three tiers, fused with Reciprocal Rank Fusion and decayed by age:
 *
 *   EXACT — query words against work_context_targets (files, symbols, error
 *   fingerprints). Highest precision: a shared file path or fingerprint hash
 *   is a fact, not a guess. Weighted so that AT EQUAL AGE any exact match
 *   outranks anything no other tier can lift past it — see the weight math on
 *   EXACT_TIER_WEIGHT.
 *
 *   FTS — websearch_to_tsquery over the normalized doc AND over claim bodies,
 *   OR-joined tokens so a sentence-shaped query matches on ANY meaningful
 *   word, with ts_rank rewarding docs that match several.
 *
 *   VECTOR — optional, only while an embedder is configured; silently absent
 *   otherwise, and silently absent again when the embedder fails mid-flight.
 *   Rows are only comparable to a query vector from the SAME model.
 *
 * Time decay multiplies the fused score: half-life ~14 days on last activity.
 * A stale exact match CAN fall below a fresh text match — deliberate, that is
 * the staleness model of DESIGN.md §5 doing its job.
 */
import {
  and,
  cosineDistance,
  eq,
  inArray,
  isNotNull,
  or,
  sql,
} from "drizzle-orm";

import {
  agentSessions,
  claims,
  developers,
  workContextTargets,
  workContexts,
} from "../db/schema.ts";
import type { Db } from "../db/client.ts";
import type { Embedder } from "./embedder.ts";
import type { Clock } from "../types.ts";

export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 25;

/**
 * Words shorter than this are dropped from matching: they carry grammar, not
 * meaning, and the tokens that matter in this domain ("500", "jwt", "ttl")
 * are all three characters or longer. The connector applies the same floor
 * before it even asks (MIN_QUERY_TOKEN_CHARS in its search tool).
 */
export const SEARCH_MIN_TOKEN_CHARS = 3;

/**
 * Hard cap on the query STRING, enforced at the route (400) and clamped again
 * here for callers that bypass it. PGlite is an embedded single-connection
 * WASM database: a ~34 KB query (5000 distinct tokens OR-joined into one
 * tsquery) does not error, it faults the WASM heap and takes the whole hub
 * down until restart — the search test "a query bypassing the route cannot
 * kill the embedded database" holds the door shut.
 */
export const SEARCH_MAX_QUERY_CHARS = 2000;

/**
 * Most distinct tokens a query contributes to matching, per tokenizer.
 * Sixteen meaningful words describe any problem this tool answers; beyond
 * that, OR-joined tokens only add noise to ts_rank — and unbounded they add
 * WASM heap pressure (see SEARCH_MAX_QUERY_CHARS).
 */
export const SEARCH_MAX_QUERY_TOKENS = 16;

/**
 * How long a search waits for the query embedding before degrading to
 * lexical. Must sit well under the connector's per-request MCP_TIMEOUT_MS
 * (10 000 ms) — if the embed deadline loses that race, a hanging embedder
 * turns "degrades to FTS + exact" (DESIGN.md §6) into a hub failure for
 * every search. The premise is machine-checked:
 *
 * VERIFY: grep -c "MCP_TIMEOUT_MS = 10_000" packages/connector-claude/src/constants.ts
 * PRINTS: 1
 */
export const SEARCH_EMBED_DEADLINE_MS = 2_000;

/** Standard RRF constant — dampens the gap between neighboring ranks. */
export const RRF_K = 60;

/**
 * Weight math for "exact above FTS at equal age": each tier list holds at most
 * TIER_CANDIDATES rows, so the weakest exact contribution is
 * 3/(60+30) ≈ 0.0333, while the strongest a non-exact row can reach is
 * rank 1 in BOTH other tiers: 2/(60+1) ≈ 0.0328. Widening TIER_CANDIDATES
 * past 31 or touching a weight breaks that inequality. The margin is checked
 * below from the exported constants, and the search tests pin the behavior
 * ("an exact match outranks a context leading both text tiers" — re-broken on
 * every pull request by mutation-check.ts).
 *
 * VERIFY: bun -e 'const s=await import("./packages/server/src/services/search.ts");const floor=s.EXACT_TIER_WEIGHT/(s.RRF_K+s.TIER_CANDIDATES);const ceiling=2*s.TEXT_TIER_WEIGHT/(s.RRF_K+1);console.log(floor.toFixed(5),ceiling.toFixed(5),floor>ceiling)'
 * PRINTS: 0.03333 0.03279 true
 */
export const EXACT_TIER_WEIGHT = 3;
export const TEXT_TIER_WEIGHT = 1;
export const TIER_CANDIDATES = 30;

/**
 * Half-life of the fused score (DESIGN.md §5: time-decay ranking). Pinned by
 * "time decay demotes a stale exact match below a fresh text match" — decay
 * is the only mechanism that can flip that ordering.
 */
const DECAY_HALF_LIFE_DAYS = 14;

/**
 * Below this cosine similarity a vector "match" is noise, not a neighbor.
 * Pinned by "the vector noise floor keeps orthogonal rows out of the results".
 */
const MIN_VECTOR_SIMILARITY = 0.3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Tier precedence for the label a result carries — most precise wins. */
const TIER_ORDER = ["exact", "fts", "vector", "recency"] as const;
export type SearchTier = (typeof TIER_ORDER)[number];

export interface SearchResultView {
  readonly id: string;
  readonly developerId: string;
  readonly developerName: string;
  readonly title: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly tier: SearchTier;
  readonly score: number;
}

export interface SearchResponse {
  readonly results: readonly SearchResultView[];
  /** True only when the vector tier actually ran for THIS search. */
  readonly vectorTierActive: boolean;
}

export interface SearchDeps {
  readonly db: Db;
  readonly now: Clock;
  readonly embedder: Embedder | null;
}

export interface SearchQuery {
  readonly query: string;
  readonly repo?: string | undefined;
  readonly limit: number;
}

/** Dedupe (a pasted trace repeats itself) and cap — see SEARCH_MAX_QUERY_TOKENS. */
const boundTokens = (tokens: readonly string[]): readonly string[] =>
  [...new Set(tokens)].slice(0, SEARCH_MAX_QUERY_TOKENS);

/** Letter/digit words for FTS — split on everything else, floor applied. */
const ftsTokens = (query: string): readonly string[] =>
  boundTokens(
    query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length >= SEARCH_MIN_TOKEN_CHARS),
  );

/**
 * Whitespace words for the exact tier — a file path or fingerprint hash is
 * one "word" to a human but many to the letter/digit splitter.
 */
const exactTokens = (query: string): readonly string[] =>
  boundTokens(
    query
      .toLowerCase()
      .split(/\s+/u)
      .filter((token) => token.length >= SEARCH_MIN_TOKEN_CHARS),
  );

/** LIKE treats % _ \ as syntax; a query word must arrive as literal text. */
const escapeLike = (token: string): string =>
  token.replace(/[\\%_]/g, (char) => `\\${char}`);

interface TierRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly updatedAt: Date | null;
}

const repoCondition = (repo: string | undefined) =>
  repo === undefined ? undefined : eq(agentSessions.repo, repo);

const activityDesc = sql`coalesce(${workContexts.updatedAt}, ${workContexts.createdAt}) DESC`;

const listExactTier = async (
  db: Db,
  tokens: readonly string[],
  repo: string | undefined,
): Promise<readonly TierRow[]> => {
  if (tokens.length === 0) {
    return [];
  }
  const tokenConditions = tokens.flatMap((token) => [
    eq(sql`lower(${workContextTargets.value})`, token),
    // Basename match for path-shaped targets: "refresh.ts" finds the context
    // that owns "src/auth/refresh.ts".
    sql`lower(${workContextTargets.value}) LIKE ${`%/${escapeLike(token)}`} ESCAPE '\\'`,
  ]);
  return db
    .select({
      id: workContexts.id,
      createdAt: workContexts.createdAt,
      updatedAt: workContexts.updatedAt,
    })
    .from(workContextTargets)
    .innerJoin(
      workContexts,
      eq(workContextTargets.workContextId, workContexts.id),
    )
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(and(repoCondition(repo), or(...tokenConditions)))
    .groupBy(workContexts.id, workContexts.createdAt, workContexts.updatedAt)
    .orderBy(sql`count(*) DESC`, activityDesc)
    .limit(TIER_CANDIDATES);
};

interface RankedRow extends TierRow {
  readonly rank: number;
}

const listFtsTier = async (
  db: Db,
  tokens: readonly string[],
  repo: string | undefined,
): Promise<readonly TierRow[]> => {
  if (tokens.length === 0) {
    return [];
  }
  // OR-joined through websearch's own OR keyword: a model asks in a sentence,
  // and requiring every word would match nothing at all. ts_rank still ranks
  // multi-word matches above single-word ones.
  const orQuery = tokens.join(" or ");
  const tsquery = sql`websearch_to_tsquery('english', ${orQuery})`;

  const contextRows: readonly RankedRow[] = await db
    .select({
      id: workContexts.id,
      createdAt: workContexts.createdAt,
      updatedAt: workContexts.updatedAt,
      rank: sql<number>`ts_rank(${workContexts.tsv}, ${tsquery})`,
    })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(and(repoCondition(repo), sql`${workContexts.tsv} @@ ${tsquery}`))
    .orderBy(sql`ts_rank(${workContexts.tsv}, ${tsquery}) DESC`, activityDesc)
    .limit(TIER_CANDIDATES);

  // Claim bodies get their own pass: the doc caps out at
  // NORMALIZED_DOC_MAX_CLAIMS summaries, and a match in claim 51 still counts.
  const claimRows: readonly RankedRow[] = await db
    .select({
      id: claims.workContextId,
      createdAt: workContexts.createdAt,
      updatedAt: workContexts.updatedAt,
      rank: sql<number>`max(ts_rank(${claims.tsv}, ${tsquery}))`,
    })
    .from(claims)
    .innerJoin(workContexts, eq(claims.workContextId, workContexts.id))
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(and(repoCondition(repo), sql`${claims.tsv} @@ ${tsquery}`))
    .groupBy(
      claims.workContextId,
      workContexts.createdAt,
      workContexts.updatedAt,
    )
    .orderBy(sql`max(ts_rank(${claims.tsv}, ${tsquery})) DESC`)
    .limit(TIER_CANDIDATES);

  const bestRank = new Map<string, RankedRow>();
  for (const row of [...contextRows, ...claimRows]) {
    const known = bestRank.get(row.id);
    if (known === undefined || row.rank > known.rank) {
      bestRank.set(row.id, row);
    }
  }
  return [...bestRank.values()]
    .sort((left, right) => right.rank - left.rank)
    .slice(0, TIER_CANDIDATES);
};

/**
 * Rejects when `work` outlasts the deadline. The work itself is NOT cancelled
 * (the Embedder interface carries no abort signal); its own transport timeout
 * settles it in the background while the search proceeds without it.
 */
const withDeadline = async <T>(
  work: Promise<T>,
  deadlineMs: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`${label} exceeded the ${String(deadlineMs)}ms deadline`),
            ),
          deadlineMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const listVectorTier = async (
  db: Db,
  embedder: Embedder,
  query: string,
  repo: string | undefined,
): Promise<readonly TierRow[]> => {
  const [queryVector] = await withDeadline(
    embedder.embed([query]),
    SEARCH_EMBED_DEADLINE_MS,
    "query embedding",
  );
  if (queryVector === undefined) {
    return [];
  }
  const distance = cosineDistance(workContexts.embedding, [...queryVector]);
  const rows = await db
    .select({
      id: workContexts.id,
      createdAt: workContexts.createdAt,
      updatedAt: workContexts.updatedAt,
      similarity: sql<number>`1 - (${distance})`,
    })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(
      and(
        repoCondition(repo),
        isNotNull(workContexts.embedding),
        eq(workContexts.embeddingModel, embedder.model),
      ),
    )
    .orderBy(distance)
    .limit(TIER_CANDIDATES);
  return rows.filter((row) => row.similarity >= MIN_VECTOR_SIMILARITY);
};

const listRecencyTier = async (
  db: Db,
  repo: string | undefined,
): Promise<readonly TierRow[]> =>
  db
    .select({
      id: workContexts.id,
      createdAt: workContexts.createdAt,
      updatedAt: workContexts.updatedAt,
    })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(repoCondition(repo))
    .orderBy(activityDesc)
    .limit(TIER_CANDIDATES);

interface FusedEntry {
  readonly row: TierRow;
  readonly score: number;
  readonly tiers: ReadonlySet<SearchTier>;
}

interface TierList {
  readonly tier: SearchTier;
  readonly weight: number;
  readonly rows: readonly TierRow[];
}

const decayFactor = (row: TierRow, nowMs: number): number => {
  const activityMs = (row.updatedAt ?? row.createdAt).getTime();
  const ageDays = Math.max(0, nowMs - activityMs) / MS_PER_DAY;
  return 0.5 ** (ageDays / DECAY_HALF_LIFE_DAYS);
};

/** Weighted RRF, then decay — new objects only, nothing mutated in place. */
const fuseTiers = (
  tiers: readonly TierList[],
  nowMs: number,
): readonly FusedEntry[] => {
  const fused = new Map<string, FusedEntry>();
  for (const { tier, weight, rows } of tiers) {
    rows.forEach((row, index) => {
      const contribution = weight / (RRF_K + index + 1);
      const known = fused.get(row.id);
      fused.set(row.id, {
        row: known?.row ?? row,
        score: (known?.score ?? 0) + contribution,
        tiers: new Set([...(known?.tiers ?? []), tier]),
      });
    });
  }
  return [...fused.values()]
    .map((entry) => ({
      ...entry,
      score: entry.score * decayFactor(entry.row, nowMs),
    }))
    .sort((left, right) => right.score - left.score);
};

const tierLabel = (tiers: ReadonlySet<SearchTier>): SearchTier =>
  TIER_ORDER.find((tier) => tiers.has(tier)) ?? "recency";

/** Display rows for the fused winners, in fused order. */
const hydrate = async (
  db: Db,
  entries: readonly FusedEntry[],
): Promise<readonly SearchResultView[]> => {
  if (entries.length === 0) {
    return [];
  }
  const ids = entries.map((entry) => entry.row.id);
  const rows = await db
    .select({
      id: workContexts.id,
      title: workContexts.title,
      status: workContexts.status,
      createdAt: workContexts.createdAt,
      updatedAt: workContexts.updatedAt,
      developerId: agentSessions.developerId,
      developerName: developers.name,
    })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .innerJoin(developers, eq(agentSessions.developerId, developers.id))
    .where(inArray(workContexts.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return entries.flatMap((entry) => {
    const row = byId.get(entry.row.id);
    if (row === undefined) {
      return [];
    }
    return [
      {
        id: row.id,
        developerId: row.developerId,
        developerName: row.developerName,
        title: row.title,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt === null ? null : row.updatedAt.toISOString(),
        tier: tierLabel(entry.tiers),
        score: entry.score,
      },
    ];
  });
};

/**
 * The vector tier runs only when an embedder exists AND its call succeeds;
 * either miss degrades to lexical, never to a failed search.
 */
const tryVectorTier = async (
  deps: SearchDeps,
  query: string,
  repo: string | undefined,
): Promise<{ rows: readonly TierRow[]; active: boolean }> => {
  if (deps.embedder === null) {
    return { rows: [], active: false };
  }
  try {
    const rows = await listVectorTier(deps.db, deps.embedder, query, repo);
    return { rows, active: true };
  } catch (error) {
    console.error("[crosscheck] vector search tier failed, degrading", error);
    return { rows: [], active: false };
  }
};

export const searchWorkContexts = async (
  deps: SearchDeps,
  input: SearchQuery,
): Promise<SearchResponse> => {
  const limit = Math.min(Math.max(1, input.limit), SEARCH_MAX_LIMIT);
  const nowMs = deps.now().getTime();
  // Clamped even though the route already rejects: this service is the layer
  // whose queries can fault the embedded database, so the bound lives here too.
  const query = input.query.slice(0, SEARCH_MAX_QUERY_CHARS);
  const wordTokens = ftsTokens(query);
  const pathTokens = exactTokens(query);

  // A blank query asks "what is happening" — answered by recency alone.
  if (query.trim().length === 0) {
    const rows = await listRecencyTier(deps.db, input.repo);
    const fused = fuseTiers(
      [{ tier: "recency", weight: TEXT_TIER_WEIGHT, rows }],
      nowMs,
    );
    return {
      results: await hydrate(deps.db, fused.slice(0, limit)),
      vectorTierActive: false,
    };
  }

  const [exactRows, ftsRows, vector] = await Promise.all([
    listExactTier(deps.db, pathTokens, input.repo),
    listFtsTier(deps.db, wordTokens, input.repo),
    tryVectorTier(deps, query, input.repo),
  ]);

  const fused = fuseTiers(
    [
      { tier: "exact", weight: EXACT_TIER_WEIGHT, rows: exactRows },
      { tier: "fts", weight: TEXT_TIER_WEIGHT, rows: ftsRows },
      { tier: "vector", weight: TEXT_TIER_WEIGHT, rows: vector.rows },
    ],
    nowMs,
  );
  return {
    results: await hydrate(deps.db, fused.slice(0, limit)),
    vectorTierActive: vector.active,
  };
};
