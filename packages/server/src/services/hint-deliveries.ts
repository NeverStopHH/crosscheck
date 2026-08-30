/**
 * hint_deliveries — the precision loop's ledger (DESIGN.md §4).
 *
 * A row is written when the connector's UserPromptSubmit hook injects a hint
 * (ingested through /api/records like every other spooled record), and marked
 * `pulled_at` when the receiving developer later reads the hinted work context
 * through the diagnosis endpoint. pulled/delivered is the measurable hint
 * precision that tunes thresholds — telemetry, so every failure here is
 * non-fatal to the read it rides on.
 */
import { and, count, eq, gte, inArray, isNull } from "drizzle-orm";
import type { HintDelivery } from "@crosscheck/schema";

import {
  agentSessions,
  claims,
  hintDeliveries,
  workContexts,
} from "../db/schema.ts";
import { checkOwnedSession, rejectedOutcome } from "./record-handlers.ts";
import type { HandlerOutcome } from "./record-handlers.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

/**
 * Most deliveries one diagnosis read may mark pulled. The connector caps
 * deliveries at 5 per receiving session, so this bound is generous headroom,
 * not a working limit — it exists so the marking queries are bounded like
 * every other query on the hub.
 */
export const MAX_PULL_MARKS_PER_READ = 50;

/**
 * GET /api/hints/stats (trial finding #20 + M1): the precision loop's numbers,
 * per repo, over a bounded trailing window — delivered hints, how many of them
 * were pulled, and the repo's claim count. Read-only, two aggregate queries;
 * `crosscheck doctor` and `status` print them when the hub is reachable. The
 * window is capped so the aggregates stay bounded on a long-lived hub.
 */
export const HINT_STATS_DEFAULT_WINDOW_DAYS = 7;
export const HINT_STATS_MAX_WINDOW_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface HintStats {
  readonly delivered: number;
  /** Deliveries whose ref the receiving developer later read (pulled_at set). */
  readonly pulled: number;
  readonly windowDays: number;
  /**
   * Claims that exist on this repo AT ALL — the number that decides whether
   * hints CAN fire.
   *
   * Trial finding H3/M1: the hint selector only ever proposes claims, so a
   * repo with zero claims delivers zero hints no matter how well the ranking
   * works, and nothing anywhere said so. `delivered: 0` reads like a tuning
   * problem; `delivered: 0, claims: 0` reads like the structural fact it is.
   *
   * UNWINDOWED on purpose while delivered/pulled are windowed: a claim
   * published two months ago is still something a hint can point at, so
   * windowing this number would turn a healthy quiet repo into the same "0
   * claims" the WARN exists to name. The field's meaning is the repo's, not
   * the window's, and the surfaces print it outside the window clause.
   */
  readonly claims: number;
}

const countRows = async (
  rows: Promise<readonly { readonly value: number }[]>,
): Promise<number> => (await rows)[0]?.value ?? 0;

export const readHintStats = async (
  deps: Deps,
  repo: string,
  windowDays: number,
): Promise<HintStats> => {
  const days = Math.min(Math.max(1, Math.floor(windowDays)), HINT_STATS_MAX_WINDOW_DAYS);
  const since = new Date(deps.now().getTime() - days * MS_PER_DAY);
  const [rows, claimCount] = await Promise.all([
    deps.db
      .select({
        delivered: count(hintDeliveries.id),
        // count(column) counts NON-NULL values: the pulled subset.
        pulled: count(hintDeliveries.pulledAt),
      })
      .from(hintDeliveries)
      .innerJoin(agentSessions, eq(hintDeliveries.sessionId, agentSessions.id))
      .where(and(eq(agentSessions.repo, repo), gte(hintDeliveries.deliveredAt, since))),
    countRows(
      deps.db
        .select({ value: count() })
        .from(claims)
        .innerJoin(workContexts, eq(claims.workContextId, workContexts.id))
        .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
        .where(eq(agentSessions.repo, repo)),
    ),
  ]);
  const row = rows[0];
  return {
    delivered: row?.delivered ?? 0,
    pulled: row?.pulled ?? 0,
    windowDays: days,
    claims: claimCount,
  };
};

/**
 * Idempotent on spool replay by construction: the connector derives the
 * delivery id deterministically from (receiving session, ref), so a replayed
 * batch re-sends the same primary key and lands here as a duplicate.
 */
export const ingestHintDelivery = async (
  deps: Deps,
  developerId: string,
  body: HintDelivery,
): Promise<HandlerOutcome> => {
  const sessionIssue = await checkOwnedSession(
    deps.db,
    developerId,
    body.sessionId,
    "sessionId",
  );
  if (sessionIssue !== null) {
    return rejectedOutcome(sessionIssue);
  }
  const inserted = await deps.db
    .insert(hintDeliveries)
    .values({
      id: body.id,
      sessionId: body.sessionId,
      refKind: body.refKind,
      refId: body.refId,
      deliveredAt: new Date(body.deliveredAt),
    })
    .onConflictDoNothing()
    .returning({ id: hintDeliveries.id });
  return inserted.length === 0
    ? { status: "duplicate", id: body.id }
    : { status: "accepted", id: body.id };
};

/** Unpulled deliveries of this developer whose CLAIM ref lives in the tree. */
const listClaimRefCandidates = (
  deps: Deps,
  developerId: string,
  workContextId: string,
): Promise<readonly { id: string }[]> =>
  deps.db
    .select({ id: hintDeliveries.id })
    .from(hintDeliveries)
    .innerJoin(agentSessions, eq(hintDeliveries.sessionId, agentSessions.id))
    .innerJoin(claims, eq(claims.id, hintDeliveries.refId))
    .where(
      and(
        isNull(hintDeliveries.pulledAt),
        eq(agentSessions.developerId, developerId),
        eq(hintDeliveries.refKind, "claim"),
        eq(claims.workContextId, workContextId),
      ),
    )
    .limit(MAX_PULL_MARKS_PER_READ);

/** Unpulled deliveries of this developer that name the tree itself. */
const listContextRefCandidates = (
  deps: Deps,
  developerId: string,
  workContextId: string,
): Promise<readonly { id: string }[]> =>
  deps.db
    .select({ id: hintDeliveries.id })
    .from(hintDeliveries)
    .innerJoin(agentSessions, eq(hintDeliveries.sessionId, agentSessions.id))
    .where(
      and(
        isNull(hintDeliveries.pulledAt),
        eq(agentSessions.developerId, developerId),
        eq(hintDeliveries.refKind, "work_context"),
        eq(hintDeliveries.refId, workContextId),
      ),
    )
    .limit(MAX_PULL_MARKS_PER_READ);

/**
 * Marks the reading developer's unpulled deliveries for one work context —
 * both context refs and refs to claims inside it. Bounded statements only:
 * candidates first (LIMIT), then one update by id.
 *
 * Only the FIRST pull is recorded (`isNull` predicate): the signal is "the
 * hint led to a read", and re-reads would only launder the timestamp.
 */
export const markHintsPulled = async (
  deps: Deps,
  developerId: string,
  workContextId: string,
): Promise<void> => {
  const [claimRefs, contextRefs] = await Promise.all([
    listClaimRefCandidates(deps, developerId, workContextId),
    listContextRefCandidates(deps, developerId, workContextId),
  ]);
  const ids = [...new Set([...claimRefs, ...contextRefs].map((row) => row.id))];
  if (ids.length === 0) {
    return;
  }
  await deps.db
    .update(hintDeliveries)
    .set({ pulledAt: deps.now() })
    .where(inArray(hintDeliveries.id, ids));
};
