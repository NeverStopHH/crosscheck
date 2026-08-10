/**
 * landed_evidence ingest — merged-branch detection, hub side (DESIGN.md §5:
 * "base_commit reachable from main ⇒ context marked landed").
 *
 * WHY A COLUMN AND NOT A STATUS TRANSITION. Three reasons, in order:
 *   1. `status` is the SESSION_STATUSES enum shared by sessions and contexts
 *      on the wire — widening it would touch every consumer for a fact that
 *      is not about what the developer's session was doing.
 *   2. A transition would DESTROY information: a landed context was also
 *      `done` or `blocked`, and that last working status stays meaningful.
 *   3. Presentation needs WHEN it was observed ("landed", stated with age),
 *      which only a timestamp records.
 * Claims are untouched — append-only, as everywhere.
 *
 * MONOTONIC BY CONSTRUCTION: the UPDATE touches only rows whose landed_at is
 * still null, so a replayed or repeated report cannot move the observation
 * and nothing can ever un-land a context (git ancestry never un-happens; a
 * force-pushed default branch is the one case that could, and honesty there
 * costs less than a flag teammates watch flap).
 *
 * TRUST MODEL, same as commit evidence: any hub member may report, because
 * git ancestry is checkable from any clone and the hub maps commit → context
 * through (repo, base_commit) itself. A forged report can therefore mislabel
 * a context as landed — a wrong label with the same blast radius as forged
 * commit evidence, accepted and documented — but it cannot touch claims,
 * ranking (the solved floor keys on SOLVED, services/solved.ts), or another
 * repo's contexts.
 *
 * KNOWN LIMITATION, inherited from the DESIGN §5 semantic: a session that
 * started ON the default branch has a base commit that is trivially an
 * ancestor, so its context reads landed from day one. The connector
 * therefore checks only contexts the hub still lists as open, and renderers
 * state the fact literally ("base commit is on the default branch") rather
 * than claiming the WORK merged.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { LandedEvidence } from "@crosscheck/schema";

import { agentSessions, workContexts } from "../db/schema.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";
import type { HandlerOutcome } from "./record-handlers.ts";

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

/**
 * Stamps landed_at on every still-open context whose owning session is on
 * `body.repo` with a base commit the report names. One bounded UPDATE — the
 * commit list is capped by the wire schema (MAX_LANDED_COMMITS).
 *
 * Always "accepted", including when nothing matched: the write is idempotent
 * and the flush loop acts on nothing finer. No outbox event, same reasoning
 * as targets and commit evidence — every teammate's SessionStart re-reports,
 * and per-report events would drown the signals SSE consumers care about.
 */
export const ingestLandedEvidence = async (
  deps: Deps,
  _developerId: string,
  body: LandedEvidence,
): Promise<HandlerOutcome> => {
  const sessionIds = deps.db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.repo, body.repo),
        inArray(agentSessions.baseCommit, [...body.commits]),
      ),
    );
  await deps.db
    .update(workContexts)
    .set({ landedAt: deps.now() })
    .where(
      and(
        isNull(workContexts.landedAt),
        inArray(workContexts.sessionId, sessionIds),
      ),
    );
  return { status: "accepted" };
};
