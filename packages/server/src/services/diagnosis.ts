import { and, asc, count, desc, eq, gte, inArray, or } from "drizzle-orm";

import { WORK_CONTEXT_LIST_MAX } from "../constants.ts";

import {
  agentSessions,
  claimEdges,
  claims,
  developers,
  workContexts,
  workContextTargets,
} from "../db/schema.ts";
import { notMutedCondition } from "./visibility.ts";
import type { Db } from "../db/client.ts";

/** Upper bound on claims returned per diagnosis tree; excess sets `truncated`. */
export const DIAGNOSIS_MAX_CLAIMS = 500;

/** Upper bound on edges returned per diagnosis tree; excess sets `truncated`. */
export const DIAGNOSIS_MAX_EDGES = 1000;

/**
 * Upper bound on targets returned with a diagnosis — the connector's solved
 * staleness check reads the FILE targets, and its own path cap is far below
 * this (STALENESS_MAX_PATHS in the connector).
 */
export const DIAGNOSIS_MAX_TARGETS = 100;

export interface DiagnosisLimits {
  readonly maxClaims: number;
  readonly maxEdges: number;
}

const DEFAULT_DIAGNOSIS_LIMITS: DiagnosisLimits = {
  maxClaims: DIAGNOSIS_MAX_CLAIMS,
  maxEdges: DIAGNOSIS_MAX_EDGES,
};

const toIsoOrNull = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

type WorkContextRow = typeof workContexts.$inferSelect;
type ClaimRow = typeof claims.$inferSelect;
type ClaimEdgeRow = typeof claimEdges.$inferSelect;

export interface WorkContextView {
  readonly id: string;
  readonly sessionId: string;
  readonly title: string;
  readonly description: string | null;
  readonly intent: Record<string, unknown> | null;
  readonly status: string;
  /**
   * The owning session's base commit — what the connector's drift label and
   * landed ancestry check run against. "" only if the join ever misses
   * (unreachable through ingest, same argument as the claim author join).
   */
  readonly baseCommit: string;
  /** Merged-branch detection (DESIGN.md §5); null while unobserved. */
  readonly landedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string | null;
}

export interface WorkContextListEntry extends WorkContextView {
  readonly developerId: string;
  /** Author is a normative trust label (DESIGN.md §4), so it ships with the row
   * instead of being looked up in the 90 s presence list by the reader. */
  readonly developerName: string;
  readonly claimCount: number;
  /**
   * How many deterministic targets this context captured (trial finding M1).
   *
   * The number the connector's `capture` check and `crosscheck status` need to
   * answer "is capture working at all": a context with claims and zero targets
   * is a session that reported its existence and nothing it touched, which is
   * the H1 cross-worktree drop's signature and was invisible on every surface.
   */
  readonly targetCount: number;
}

export interface WorkContextListWindow {
  /** Oldest `created_at` to include; omitted = no window (see §M8). */
  readonly since?: Date;
  readonly limit?: number;
}

export interface ClaimView {
  readonly id: string;
  readonly workContextId: string;
  readonly authorSessionId: string;
  /**
   * Who wrote this claim, resolved through the author SESSION rather than
   * through the work context's owner — the two differ exactly when the product
   * is doing its job. `extend_diagnosis` puts B's claim inside A's context, and
   * `workContexts.sessionId` names the creating session forever (updates never
   * re-home a context, see record-handlers.ts), so it can only ever answer
   * "whose tree is this", never "who said this".
   *
   * Shipped on the row for the same reason `WorkContextListEntry.developerName`
   * is: author is a normative trust label (DESIGN.md §4), and a reader holding
   * an opaque `cc_<uuid>` has no second endpoint that would turn it into a
   * person.
   */
  readonly authorDeveloperId: string;
  readonly authorDeveloperName: string;
  readonly kind: string;
  readonly body: string;
  readonly status: string;
  readonly confidence: number;
  readonly captureMode: string;
  readonly provenance: string;
  readonly dedupCount: number;
  readonly evidenceRefs: readonly string[];
  readonly lastSeenAt: string | null;
  readonly staleAt: string | null;
  readonly createdAt: string;
}

export interface ClaimEdgeView {
  readonly id: string;
  readonly fromClaimId: string;
  readonly toClaimId: string;
  readonly kind: string;
  readonly authorSessionId: string;
  readonly note: string | null;
  readonly createdAt: string;
}

/** Foreign endpoint of a cross-context edge; body resolution is a follow-up. */
export interface ExternalClaimRef {
  readonly id: string;
  readonly kind: string;
  readonly workContextId: string;
}

/** One deterministic target of the tree (file, symbol, fingerprint …). */
export interface DiagnosisTargetView {
  readonly kind: string;
  readonly value: string;
}

export interface Diagnosis {
  readonly workContext: WorkContextView;
  readonly claims: readonly ClaimView[];
  readonly edges: readonly ClaimEdgeView[];
  readonly externalClaims: readonly ExternalClaimRef[];
  /**
   * The tree's targets, bounded by DIAGNOSIS_MAX_TARGETS — what the solved
   * staleness check reads at pull time (which files this diagnosis was about).
   */
  readonly targets: readonly DiagnosisTargetView[];
  /** True when the claims or edges query hit its limit — the tree is partial. */
  readonly truncated: boolean;
}

const toWorkContextView = (
  row: WorkContextRow,
  baseCommit: string,
): WorkContextView => ({
  id: row.id,
  sessionId: row.sessionId,
  title: row.title,
  description: row.description,
  intent: row.intent ?? null,
  status: row.status,
  baseCommit,
  landedAt: toIsoOrNull(row.landedAt),
  createdAt: row.createdAt.toISOString(),
  updatedAt: toIsoOrNull(row.updatedAt),
});

/** A claim row joined to the developer behind its author session. */
interface AttributedClaimRow {
  readonly claim: ClaimRow;
  readonly authorDeveloperId: string;
  readonly authorDeveloperName: string;
}

const toClaimView = ({
  claim: row,
  authorDeveloperId,
  authorDeveloperName,
}: AttributedClaimRow): ClaimView => ({
  id: row.id,
  workContextId: row.workContextId,
  authorSessionId: row.authorSessionId,
  authorDeveloperId,
  authorDeveloperName,
  kind: row.kind,
  body: row.body,
  status: row.status,
  confidence: row.confidence,
  captureMode: row.captureMode,
  provenance: row.provenance,
  dedupCount: row.dedupCount,
  evidenceRefs: row.evidenceRefs,
  lastSeenAt: toIsoOrNull(row.lastSeenAt),
  staleAt: toIsoOrNull(row.staleAt),
  createdAt: row.createdAt.toISOString(),
});

const toClaimEdgeView = (row: ClaimEdgeRow): ClaimEdgeView => ({
  id: row.id,
  fromClaimId: row.fromClaimId,
  toClaimId: row.toClaimId,
  kind: row.kind,
  authorSessionId: row.authorSessionId,
  note: row.note,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Target counts for a page of contexts, as ONE bounded follow-up query.
 *
 * Deliberately not a second `leftJoin` on the statement below. Two left joins
 * against one grouped row multiply each other's `count()`, so a context with
 * three claims and two targets would report `claimCount: 6` — a silent
 * corruption of a number three surfaces already print. `work_context_targets`
 * also has no `id` column (composite primary key, db/schema.ts), so
 * `countDistinct` is not available to paper over it. The page is capped at
 * WORK_CONTEXT_LIST_MAX, so this is one extra bounded query per list call.
 */
const targetCountsFor = async (
  db: Db,
  workContextIds: readonly string[],
): Promise<ReadonlyMap<string, number>> => {
  if (workContextIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      workContextId: workContextTargets.workContextId,
      targetCount: count(),
    })
    .from(workContextTargets)
    .where(inArray(workContextTargets.workContextId, [...workContextIds]))
    .groupBy(workContextTargets.workContextId);
  return new Map(rows.map((row) => [row.workContextId, row.targetCount]));
};

export const listWorkContextsByRepo = async (
  db: Db,
  viewerDeveloperId: string,
  repo: string,
  window: WorkContextListWindow = {},
): Promise<readonly WorkContextListEntry[]> => {
  // Capped HERE rather than rejected at the route, the EventsQuerySchema
  // discipline: a caller asking for 10 000 rows gets the cap, not a 400.
  const limit = Math.min(
    window.limit ?? WORK_CONTEXT_LIST_MAX,
    WORK_CONTEXT_LIST_MAX,
  );
  const rows = await db
    .select({
      workContext: workContexts,
      developerId: agentSessions.developerId,
      developerName: developers.name,
      baseCommit: agentSessions.baseCommit,
      claimCount: count(claims.id),
    })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .innerJoin(developers, eq(agentSessions.developerId, developers.id))
    .leftJoin(claims, eq(claims.workContextId, workContexts.id))
    // The viewer's mutes apply — this listing feeds the briefing's related-
    // work pointers (an unasked surface). Opt-out does NOT: these rows are
    // published knowledge, not live presence (services/visibility.ts). The
    // by-id diagnosis read below stays unfiltered — that is the pull.
    .where(
      and(
        eq(agentSessions.repo, repo),
        notMutedCondition(viewerDeveloperId, agentSessions.developerId),
        ...(window.since === undefined
          ? []
          : [gte(workContexts.createdAt, window.since)]),
      ),
    )
    .groupBy(
      workContexts.id,
      agentSessions.developerId,
      developers.name,
      agentSessions.baseCommit,
    )
    // Newest first, then the cap: a truncated page must keep the rows the
    // reader would have used, and every consumer of this list wants recent
    // work (the briefing filters to CONTEXT_MAX_AGE_DAYS client-side).
    .orderBy(desc(workContexts.createdAt))
    .limit(limit);
  const targetCounts = await targetCountsFor(
    db,
    rows.map((row) => row.workContext.id),
  );
  return rows.map((row) => ({
    ...toWorkContextView(row.workContext, row.baseCommit),
    developerId: row.developerId,
    developerName: row.developerName,
    claimCount: row.claimCount,
    targetCount: targetCounts.get(row.workContext.id) ?? 0,
  }));
};

/** The tree's targets, bounded, in deterministic (kind, value) order. */
const listDiagnosisTargets = async (
  db: Db,
  workContextId: string,
): Promise<readonly DiagnosisTargetView[]> =>
  db
    .select({
      kind: workContextTargets.kind,
      value: workContextTargets.value,
    })
    .from(workContextTargets)
    .where(eq(workContextTargets.workContextId, workContextId))
    .orderBy(asc(workContextTargets.kind), asc(workContextTargets.value))
    .limit(DIAGNOSIS_MAX_TARGETS);

const listEdgesTouching = async (
  db: Db,
  claimIds: readonly string[],
  limits: DiagnosisLimits,
): Promise<ClaimEdgeRow[]> => {
  if (claimIds.length === 0) {
    return [];
  }
  const cappedIds = claimIds.slice(0, limits.maxClaims);
  return db
    .select()
    .from(claimEdges)
    .where(
      or(
        inArray(claimEdges.fromClaimId, cappedIds),
        inArray(claimEdges.toClaimId, cappedIds),
      ),
    )
    .orderBy(asc(claimEdges.createdAt))
    .limit(limits.maxEdges);
};

const listExternalClaimRefs = async (
  db: Db,
  edges: readonly ClaimEdgeRow[],
  localClaimIds: ReadonlySet<string>,
  limits: DiagnosisLimits,
): Promise<readonly ExternalClaimRef[]> => {
  const externalIds = [
    ...new Set(
      edges
        .flatMap((edge) => [edge.fromClaimId, edge.toClaimId])
        .filter((id) => !localClaimIds.has(id)),
    ),
  ].slice(0, limits.maxEdges);
  if (externalIds.length === 0) {
    return [];
  }
  return db
    .select({
      id: claims.id,
      kind: claims.kind,
      workContextId: claims.workContextId,
    })
    .from(claims)
    .where(inArray(claims.id, externalIds));
};

/**
 * Full diagnosis tree for one work context: the context, its claims, every
 * edge touching those claims, and id/kind refs for claims in other contexts
 * so cross-context chains (e.g. deeper_cause_of) stay visible.
 */
export const getDiagnosis = async (
  db: Db,
  workContextId: string,
  limits: DiagnosisLimits = DEFAULT_DIAGNOSIS_LIMITS,
): Promise<Diagnosis | undefined> => {
  // innerJoin for the base commit: every context reaches the table through
  // checkOwnedSession (record-handlers.ts), so its session always exists.
  const contextRows = await db
    .select({
      workContext: workContexts,
      baseCommit: agentSessions.baseCommit,
    })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(eq(workContexts.id, workContextId))
    .limit(1);
  const contextRow = contextRows[0];
  if (contextRow === undefined) {
    return undefined;
  }

  // innerJoin, not leftJoin: every claim row reaches the table through
  // `checkOwnedSession`, which resolves the author session before the INSERT
  // (record-handlers.ts), so a claim whose session or developer is missing
  // cannot exist. A leftJoin would buy nullable author columns for a state the
  // ingest path makes unreachable, and every reader would then carry the null.
  const claimRows = await db
    .select({
      claim: claims,
      authorDeveloperId: agentSessions.developerId,
      authorDeveloperName: developers.name,
    })
    .from(claims)
    .innerJoin(agentSessions, eq(claims.authorSessionId, agentSessions.id))
    .innerJoin(developers, eq(agentSessions.developerId, developers.id))
    .where(eq(claims.workContextId, workContextId))
    .orderBy(asc(claims.createdAt))
    .limit(limits.maxClaims);
  const localClaimIds = new Set(claimRows.map((row) => row.claim.id));
  const edgeRows = await listEdgesTouching(db, [...localClaimIds], limits);
  const externalClaims = await listExternalClaimRefs(
    db,
    edgeRows,
    localClaimIds,
    limits,
  );
  const targets = await listDiagnosisTargets(db, workContextId);

  return {
    workContext: toWorkContextView(contextRow.workContext, contextRow.baseCommit),
    claims: claimRows.map(toClaimView),
    edges: edgeRows.map(toClaimEdgeView),
    externalClaims,
    targets,
    truncated:
      claimRows.length >= limits.maxClaims ||
      edgeRows.length >= limits.maxEdges,
  };
};
