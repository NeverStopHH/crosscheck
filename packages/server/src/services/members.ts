/**
 * The member list for /ui/members (task item 5).
 *
 * MEMBERSHIP IS NOT SURVEILLANCE: every developer row shows to every
 * authenticated member — an opted-out developer is still a member of the
 * trust space. What opt-out hides is LIVE presence, and that is enforced
 * here through the same visiblePresenceCondition every other surface uses
 * (services/visibility.ts), inside the bounded query's WHERE.
 *
 * MUTE deliberately does NOT apply (the feed page states the same rule):
 * the member list is a page the reader opened, not an unasked injection
 * surface — visibility.ts scopes mute to hints, briefings and statusline.
 *
 * The viewer's OWN opt-out state rides on their own row (isSelfOptedOut) so
 * the page can show "presence hidden from teammates" to exactly the person
 * it concerns — DESIGN.md §2.1: their own view of themselves is unaffected.
 */
import { and, asc, desc, gt, isNull } from "drizzle-orm";

import { agentSessions, developers } from "../db/schema.ts";
import { UI_MAX_MEMBERS, UI_MAX_PRESENCE_ROWS } from "../ui/constants.ts";
import { presenceCutoff } from "./presence.ts";
import { visiblePresenceCondition } from "./visibility.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

export interface MemberPresence {
  readonly status: string;
  readonly repo: string;
  readonly branch: string;
  readonly lastHeartbeatAt: string;
}

export interface MemberEntry {
  readonly developerId: string;
  readonly name: string;
  readonly joinedAt: string;
  readonly isSelf: boolean;
  /** Null = no visible active session (none, stale, or opt-out hidden). */
  readonly presence: MemberPresence | null;
  /** True only on the viewer's own row while they are opted out. */
  readonly isSelfOptedOut: boolean;
}

export const listMembers = async (
  deps: { readonly db: Db; readonly now: Clock },
  viewerDeveloperId: string,
): Promise<readonly MemberEntry[]> => {
  const memberRows = await deps.db
    .select({
      id: developers.id,
      name: developers.name,
      createdAt: developers.createdAt,
      presenceOptOut: developers.presenceOptOut,
    })
    .from(developers)
    .orderBy(asc(developers.createdAt), asc(developers.id))
    .limit(UI_MAX_MEMBERS);

  const cutoff = presenceCutoff(deps.now());
  const sessionRows = await deps.db
    .select({
      developerId: agentSessions.developerId,
      status: agentSessions.status,
      repo: agentSessions.repo,
      branch: agentSessions.branch,
      lastHeartbeatAt: agentSessions.lastHeartbeatAt,
    })
    .from(agentSessions)
    .where(
      and(
        isNull(agentSessions.endedAt),
        gt(agentSessions.lastHeartbeatAt, cutoff),
        visiblePresenceCondition(viewerDeveloperId, agentSessions.developerId),
      ),
    )
    .orderBy(desc(agentSessions.lastHeartbeatAt))
    .limit(UI_MAX_PRESENCE_ROWS);

  // Newest heartbeat wins: rows arrive newest-first, first write stays.
  const presenceByDeveloper = new Map<string, MemberPresence>();
  for (const row of sessionRows) {
    if (!presenceByDeveloper.has(row.developerId)) {
      presenceByDeveloper.set(row.developerId, {
        status: row.status,
        repo: row.repo,
        branch: row.branch,
        lastHeartbeatAt: row.lastHeartbeatAt.toISOString(),
      });
    }
  }

  return memberRows.map((member) => ({
    developerId: member.id,
    name: member.name,
    joinedAt: member.createdAt.toISOString(),
    isSelf: member.id === viewerDeveloperId,
    presence: presenceByDeveloper.get(member.id) ?? null,
    isSelfOptedOut: member.id === viewerDeveloperId && member.presenceOptOut,
  }));
};
