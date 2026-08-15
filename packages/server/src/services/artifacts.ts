/**
 * Artifact reads and the approval flip (DESIGN.md §5, task item 6).
 *
 * OWNERSHIP: an artifact hangs off a claim; its owner is the developer
 * behind the claim's author session — the same resolution every claim
 * reader uses (services/diagnosis.ts states why the author SESSION, not the
 * context owner, is the right join).
 *
 * VISIBILITY (§2.1 "artifacts default to needs_approval — owner-only until
 * released"): team_visible rows show to every member; needs_approval rows
 * show to their owner always, and to everyone else only while approved
 * (approved_by set). Approval is a live flip, not append-only knowledge —
 * revoke re-hides the CONTENT from non-owners; it does not retract that the
 * artifact was once seen.
 *
 * AUTHORIZATION is hub-side: setArtifactApproval refuses everything but the
 * owner, and reports the refusal as not_found so a non-owner cannot even
 * confirm the artifact id exists.
 */
import { and, asc, eq, isNotNull, or, sql } from "drizzle-orm";

import { agentSessions, artifacts, claims, developers } from "../db/schema.ts";
import type { Db } from "../db/client.ts";

const TEAM_VISIBLE_SENSITIVITY = "team_visible";
const NEEDS_APPROVAL_SENSITIVITY = "needs_approval";

export interface ArtifactView {
  readonly id: string;
  readonly claimId: string;
  readonly workContextId: string;
  readonly kind: string;
  readonly content: string;
  readonly sensitivity: string;
  readonly isApproved: boolean;
  readonly ownerDeveloperId: string;
  readonly ownerName: string;
  readonly createdAt: string;
}

type ArtifactRow = {
  readonly artifact: typeof artifacts.$inferSelect;
  readonly workContextId: string;
  readonly ownerDeveloperId: string;
  readonly ownerName: string;
};

const toArtifactView = (row: ArtifactRow): ArtifactView => ({
  id: row.artifact.id,
  claimId: row.artifact.claimId,
  workContextId: row.workContextId,
  kind: row.artifact.kind,
  content: row.artifact.content,
  sensitivity: row.artifact.sensitivity,
  isApproved: row.artifact.approvedBy !== null,
  ownerDeveloperId: row.ownerDeveloperId,
  ownerName: row.ownerName,
  createdAt: row.artifact.createdAt.toISOString(),
});

const artifactSelection = {
  artifact: artifacts,
  workContextId: claims.workContextId,
  ownerDeveloperId: agentSessions.developerId,
  ownerName: developers.name,
};

/**
 * Artifacts a viewer may see on one work-context page — the §5 rule in one
 * WHERE, enforced hub-side so no renderer can forget it.
 */
export const listArtifactsForWorkContext = async (
  db: Db,
  viewerDeveloperId: string,
  workContextId: string,
  limit: number,
): Promise<readonly ArtifactView[]> => {
  const rows = await db
    .select(artifactSelection)
    .from(artifacts)
    .innerJoin(claims, eq(artifacts.claimId, claims.id))
    .innerJoin(agentSessions, eq(claims.authorSessionId, agentSessions.id))
    .innerJoin(developers, eq(agentSessions.developerId, developers.id))
    .where(
      and(
        eq(claims.workContextId, workContextId),
        or(
          eq(artifacts.sensitivity, TEAM_VISIBLE_SENSITIVITY),
          isNotNull(artifacts.approvedBy),
          eq(agentSessions.developerId, viewerDeveloperId),
        ),
      ),
    )
    .orderBy(asc(artifacts.createdAt), asc(artifacts.id))
    .limit(limit);
  return rows.map(toArtifactView);
};

/**
 * The owner's approval queue: every needs_approval artifact they own,
 * approved ones included — revoke has to be reachable from somewhere.
 */
export const listOwnedNeedsApproval = async (
  db: Db,
  ownerDeveloperId: string,
  limit: number,
): Promise<readonly ArtifactView[]> => {
  const rows = await db
    .select(artifactSelection)
    .from(artifacts)
    .innerJoin(claims, eq(artifacts.claimId, claims.id))
    .innerJoin(agentSessions, eq(claims.authorSessionId, agentSessions.id))
    .innerJoin(developers, eq(agentSessions.developerId, developers.id))
    .where(
      and(
        eq(artifacts.sensitivity, NEEDS_APPROVAL_SENSITIVITY),
        eq(agentSessions.developerId, ownerDeveloperId),
      ),
    )
    .orderBy(asc(artifacts.createdAt), asc(artifacts.id))
    .limit(limit);
  return rows.map(toArtifactView);
};

export type ApprovalOutcome = "updated" | "not_found";

/**
 * Approve or revoke one owned needs_approval artifact. `not_found` covers
 * both a missing id and a non-owner caller — deliberately indistinguishable,
 * so probing ids through this endpoint teaches nothing.
 */
export const setArtifactApproval = async (
  db: Db,
  viewerDeveloperId: string,
  artifactId: string,
  isApproving: boolean,
): Promise<ApprovalOutcome> => {
  const updated = await db
    .update(artifacts)
    .set({ approvedBy: isApproving ? viewerDeveloperId : null })
    .where(
      and(
        eq(artifacts.id, artifactId),
        eq(artifacts.sensitivity, NEEDS_APPROVAL_SENSITIVITY),
        // Owner check inside the UPDATE itself — no read-then-write window.
        sql`EXISTS (
          SELECT 1 FROM claims owner_claim
          JOIN agent_sessions owner_session
            ON owner_session.id = owner_claim.author_session_id
          WHERE owner_claim.id = ${artifacts.claimId}
            AND owner_session.developer_id = ${viewerDeveloperId}
        )`,
      ),
    )
    .returning({ id: artifacts.id });
  return updated.length > 0 ? "updated" : "not_found";
};
