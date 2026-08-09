import { asc, count, desc, eq, inArray, or } from "drizzle-orm";

import {
  agentSessions,
  claimEdges,
  claims,
  developers,
  workContexts,
} from "../db/schema.ts";
import type { Db } from "../db/client.ts";

/** Upper bound on claims returned per diagnosis tree; excess sets `truncated`. */
export const DIAGNOSIS_MAX_CLAIMS = 500;

/** Upper bound on edges returned per diagnosis tree; excess sets `truncated`. */
export const DIAGNOSIS_MAX_EDGES = 1000;

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
  readonly createdAt: string;
  readonly updatedAt: string | null;
}

export interface WorkContextListEntry extends WorkContextView {
  readonly developerId: string;
  /** Author is a normative trust label (DESIGN.md §4), so it ships with the row
   * instead of being looked up in the 90 s presence list by the reader. */
  readonly developerName: string;
  readonly claimCount: number;
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

export interface Diagnosis {
  readonly workContext: WorkContextView;
  readonly claims: readonly ClaimView[];
  readonly edges: readonly ClaimEdgeView[];
  readonly externalClaims: readonly ExternalClaimRef[];
  /** True when the claims or edges query hit its limit — the tree is partial. */
  readonly truncated: boolean;
}

const toWorkContextView = (row: WorkContextRow): WorkContextView => ({
  id: row.id,
  sessionId: row.sessionId,
  title: row.title,
  description: row.description,
  intent: row.intent ?? null,
  status: row.status,
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

export const listWorkContextsByRepo = async (
  db: Db,
  repo: string,
): Promise<readonly WorkContextListEntry[]> => {
  const rows = await db
    .select({
      workContext: workContexts,
      developerId: agentSessions.developerId,
      developerName: developers.name,
      claimCount: count(claims.id),
    })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .innerJoin(developers, eq(agentSessions.developerId, developers.id))
    .leftJoin(claims, eq(claims.workContextId, workContexts.id))
    .where(eq(agentSessions.repo, repo))
    .groupBy(workContexts.id, agentSessions.developerId, developers.name)
    .orderBy(desc(workContexts.createdAt));
  return rows.map((row) => ({
    ...toWorkContextView(row.workContext),
    developerId: row.developerId,
    developerName: row.developerName,
    claimCount: row.claimCount,
  }));
};

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
  const contextRows = await db
    .select()
    .from(workContexts)
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

  return {
    workContext: toWorkContextView(contextRow),
    claims: claimRows.map(toClaimView),
    edges: edgeRows.map(toClaimEdgeView),
    externalClaims,
    truncated:
      claimRows.length >= limits.maxClaims ||
      edgeRows.length >= limits.maxEdges,
  };
};
