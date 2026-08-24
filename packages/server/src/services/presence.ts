import { and, eq, gt, isNull, sql } from "drizzle-orm";

import { PRESENCE_TTL_SECONDS } from "../constants.ts";
import { agentSessions, developers, workContexts } from "../db/schema.ts";
import { notMutedCondition, visiblePresenceCondition } from "./visibility.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

const MS_PER_SECOND = 1000;

export interface PresenceEntry {
  readonly sessionId: string;
  readonly developerId: string;
  readonly developerName: string;
  readonly agentKind: string;
  readonly repo: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly status: string;
  readonly startedAt: string;
  readonly lastHeartbeatAt: string;
  readonly isSelf: boolean;
  /**
   * The session's work-context intent (trial finding #16), raw jsonb, so the
   * briefing's "active now" line and `crosscheck status` can say WHAT a
   * teammate is doing, not only where. Null when none was captured.
   */
  readonly intent: Record<string, unknown> | null;
}

/** Presence rule (DESIGN.md §5): active = last_heartbeat_at > now - TTL. */
export const presenceCutoff = (now: Date): Date =>
  new Date(now.getTime() - PRESENCE_TTL_SECONDS * MS_PER_SECOND);

export const listPresence = async (
  deps: { readonly db: Db; readonly now: Clock },
  viewerDeveloperId: string,
  repo: string,
): Promise<PresenceEntry[]> => {
  const cutoff = presenceCutoff(deps.now());
  const rows = await deps.db
    .select({
      session: agentSessions,
      developerName: developers.name,
      // A SCALAR SUBQUERY, not a join, and the difference is a row count.
      // Presence is one row per SESSION, but nothing makes a session have one
      // work context: `work_contexts.session_id` is a plain foreign key and
      // `POST /api/records` accepts any `wc_*` id whose session the caller
      // owns. A join therefore multiplies the presence row by the number of
      // contexts the client filed — the same teammate twice in every briefing
      // and `crosscheck status`, and a response a client can grow at will.
      // This form returns at most one value whatever the data, and picks the
      // NEWEST context, which is the same "freshest speaks for the developer"
      // rule the briefing's mergeGroup applies one level up. Index behind it:
      // work_contexts_session_created_idx (db/bootstrap.sql) — without one
      // this runs on every SessionStart and every `crosscheck status`.
      intent: sql<Record<string, unknown> | null>`(
        select ${workContexts.intent}
        from ${workContexts}
        where ${workContexts.sessionId} = ${agentSessions.id}
        order by ${workContexts.createdAt} desc
        limit 1
      )`.as("intent"),
    })
    .from(agentSessions)
    .innerJoin(developers, eq(agentSessions.developerId, developers.id))
    .where(
      and(
        eq(agentSessions.repo, repo),
        isNull(agentSessions.endedAt),
        gt(agentSessions.lastHeartbeatAt, cutoff),
        // Privacy filters (services/visibility.ts): an opted-out developer is
        // hidden from every viewer but themself, and a developer the VIEWER
        // muted is hidden from this viewer's briefing/statusline lines.
        visiblePresenceCondition(viewerDeveloperId, agentSessions.developerId),
        notMutedCondition(viewerDeveloperId, agentSessions.developerId),
      ),
    );

  return rows.map((row) => ({
    sessionId: row.session.id,
    developerId: row.session.developerId,
    developerName: row.developerName,
    agentKind: row.session.agentKind,
    repo: row.session.repo,
    branch: row.session.branch,
    baseCommit: row.session.baseCommit,
    status: row.session.status,
    startedAt: row.session.startedAt.toISOString(),
    lastHeartbeatAt: row.session.lastHeartbeatAt.toISOString(),
    isSelf: row.session.developerId === viewerDeveloperId,
    intent: row.intent ?? null,
  }));
};
