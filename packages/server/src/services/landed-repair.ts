/**
 * WHICH LANDED STAMPS SHOULD NEVER HAVE BEEN MADE, and the operator's
 * un-stamp (pilot finding, 2026-10-05). The only caller is
 * scripts/unland-false-landed.ts: nothing on the hub's own paths ever
 * un-lands a context (services/landed.ts).
 *
 * Before the fix, base ancestry was the only writer of `landed_at`, so every
 * stamp on an older hub was made by it alone. The ones this repairs are the
 * stamps the rule now refuses: a base that was ALREADY on the default branch
 * when its session registered. Evidence of that, in the order a context is
 * attributed to (a context counts once, under its first reason):
 *   - flagged:  the connector said so — `base_on_default` true;
 *   - detached: the session is on a detached HEAD, which the rule never
 *               lands, whatever else is known;
 *   - named:    the operator names the commit (`--stale-base`) — a known
 *               stale detached commit, say;
 *   - stale:    a clone dates the base more than LANDED_STALE_BASE_HOURS
 *               before the context opened (`--git-dir`), for a session whose
 *               connector said nothing — the bound the ingest applies.
 * A base the connector said was NOT on the default branch keeps its stamp
 * against a date: its word is the better evidence. Without evidence a stamp
 * stays — the repair corrects what it can show, and guesses nothing.
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { isDetachedBranch } from "@crosscheck/schema";

import { agentSessions, workContexts } from "../db/schema.ts";
import type { DbExecutor } from "../db/client.ts";
import { isStaleBase } from "./landed.ts";

export const FALSE_LANDING_REASONS = ["flagged", "detached", "named", "stale"] as const;
export type FalseLandingReason = (typeof FALSE_LANDING_REASONS)[number];

export interface LandedContextRow {
  readonly id: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly baseOnDefault: boolean | null;
  readonly contextCreatedAt: Date;
}

export interface RepairEvidence {
  /** Commits the operator knows were stale checkouts. */
  readonly namedBases: ReadonlySet<string>;
  /** Committer dates from a clone; null when none was given — age not judged. */
  readonly baseCommittedAt: ReadonlyMap<string, Date> | null;
}

export interface RepairPlan {
  readonly landed: number;
  readonly unland: readonly string[];
  readonly byReason: Readonly<Record<FalseLandingReason, number>>;
}

/** Every landed context with what the rule reads about its session. */
export const listLandedContexts = (db: DbExecutor): Promise<readonly LandedContextRow[]> =>
  db
    .select({
      id: workContexts.id,
      branch: agentSessions.branch,
      baseCommit: agentSessions.baseCommit,
      baseOnDefault: agentSessions.baseOnDefault,
      contextCreatedAt: workContexts.createdAt,
    })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(isNotNull(workContexts.landedAt));

/** Why this stamp should not have been made, or null when nothing shows it. */
export const falseLandingReason = (
  row: LandedContextRow,
  evidence: RepairEvidence,
): FalseLandingReason | null => {
  if (row.baseOnDefault === true) {
    return "flagged";
  }
  if (isDetachedBranch(row.branch)) {
    return "detached";
  }
  if (evidence.namedBases.has(row.baseCommit)) {
    return "named";
  }
  const committedAt = evidence.baseCommittedAt?.get(row.baseCommit);
  return row.baseOnDefault === null && committedAt !== undefined && isStaleBase(committedAt, row.contextCreatedAt)
    ? "stale"
    : null;
};

/** What a run would change: the ids, and how many under each reason. */
export const planLandedRepair = (
  rows: readonly LandedContextRow[],
  evidence: RepairEvidence,
): RepairPlan => {
  const judged = rows.map((row) => ({ id: row.id, reason: falseLandingReason(row, evidence) }));
  const byReason = Object.fromEntries(
    FALSE_LANDING_REASONS.map((reason) => [reason, judged.filter((entry) => entry.reason === reason).length]),
  ) as Record<FalseLandingReason, number>;
  return {
    landed: rows.length,
    unland: judged.flatMap((entry) => (entry.reason === null ? [] : [entry.id])),
    byReason,
  };
};

/** Clears `landed_at` on exactly these contexts; how many it cleared. */
export const unlandContexts = async (db: DbExecutor, ids: readonly string[]): Promise<number> => {
  if (ids.length === 0) {
    return 0;
  }
  const cleared = await db
    .update(workContexts)
    .set({ landedAt: null })
    .where(and(inArray(workContexts.id, [...ids]), isNotNull(workContexts.landedAt)))
    .returning({ id: workContexts.id });
  return cleared.length;
};
