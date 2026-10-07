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
 *   - default:  the session is ON the default branch the operator names
 *               (`--default-branch`), which the rule never lands either;
 *   - named:    the operator names the commit (`--stale-base`) — a known
 *               stale detached commit, say — for a session whose connector
 *               did not say its base was new;
 *   - stale:    a clone dates the base more than LANDED_STALE_BASE_HOURS
 *               before the session took it (`--git-dir`; base_changed_at,
 *               else its start), for a session whose connector said nothing
 *               — the bound the ingest applies.
 *   - override: the operator names the commit with `--stale-base-override`,
 *               which clears it even where the connector said its base was
 *               new — the one way to overrule that word, and a separate flag
 *               so nobody does it by naming a base.
 * A base the connector said was NOT on the default branch keeps its stamp
 * against a date AND against a plain `--stale-base`: its word is the better
 * evidence. Without evidence a stamp stays — the repair corrects what it can
 * show, and guesses nothing.
 */
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { isDefaultBranch, isDetachedBranch } from "@crosscheck/schema";

import { agentSessions, workContexts } from "../db/schema.ts";
import type { DbExecutor } from "../db/client.ts";
import { isStaleBase } from "./landed.ts";

export const FALSE_LANDING_REASONS = ["flagged", "detached", "default", "named", "stale", "override"] as const;
export type FalseLandingReason = (typeof FALSE_LANDING_REASONS)[number];

export interface LandedContextRow {
  readonly id: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly baseOnDefault: boolean | null;
  /** When the session took its base: base_changed_at, else its start. */
  readonly baseAdoptedAt: Date;
}

export interface RepairEvidence {
  /** The repo's default branch, as the operator names it; null — not judged. */
  readonly defaultBranch: string | null;
  /** Commits the operator knows were stale checkouts. */
  readonly namedBases: ReadonlySet<string>;
  /** The same, overruling a connector that said its base was new. */
  readonly overriddenBases: ReadonlySet<string>;
  /** Committer dates from a clone; null when none was given — age not judged. */
  readonly baseCommittedAt: ReadonlyMap<string, Date> | null;
}

export interface RepairPlan {
  readonly landed: number;
  readonly unland: readonly string[];
  readonly byReason: Readonly<Record<FalseLandingReason, number>>;
}

/**
 * WHICH STAMPS A RUN JUDGES. `open`: only contexts whose session has not
 * ended — the ones a false stamp is hiding from collision checks today, and
 * the run the pilot owner chose for the real hub. `all`: every landed
 * context, ended sessions included; that also rewrites the past windows of
 * the pilot report's "both landed" figure.
 */
export const REPAIR_SCOPES = ["open", "all"] as const;
export type RepairScope = (typeof REPAIR_SCOPES)[number];

/** Every landed context in the scope, with what the rule reads about its session. */
export const listLandedContexts = async (
  db: DbExecutor,
  scope: RepairScope,
): Promise<readonly LandedContextRow[]> =>
  (
    await db
      .select({
        id: workContexts.id,
        branch: agentSessions.branch,
        baseCommit: agentSessions.baseCommit,
        baseOnDefault: agentSessions.baseOnDefault,
        baseChangedAt: agentSessions.baseChangedAt,
        startedAt: agentSessions.startedAt,
      })
      .from(workContexts)
      .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
      .where(
        and(
          isNotNull(workContexts.landedAt),
          scope === "open" ? isNull(agentSessions.endedAt) : undefined,
        ),
      )
  ).map(({ baseChangedAt, startedAt, ...row }) => ({ ...row, baseAdoptedAt: baseChangedAt ?? startedAt }));

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
  if (isDefaultBranch(row.branch, evidence.defaultBranch)) {
    return "default";
  }
  if (row.baseOnDefault !== false && evidence.namedBases.has(row.baseCommit)) {
    return "named";
  }
  const committedAt = evidence.baseCommittedAt?.get(row.baseCommit);
  if (row.baseOnDefault === null && committedAt !== undefined && isStaleBase(committedAt, row.baseAdoptedAt)) {
    return "stale";
  }
  return evidence.overriddenBases.has(row.baseCommit) ? "override" : null;
};

/** What the operator's `--stale-base` prefixes name among the judged bases. */
export interface NamedBases {
  /** Full bases a prefix named, each named by exactly one prefix match. */
  readonly resolved: ReadonlySet<string>;
  /** Prefixes that match more than one base, with how many. */
  readonly ambiguous: readonly { readonly prefix: string; readonly matches: number }[];
  /** Prefixes that match no judged base. */
  readonly unmatched: readonly string[];
}

/**
 * A `--stale-base` value names a base by PREFIX, as `git` would take it — the
 * short sha an operator copies from a log. A prefix matching two bases names
 * neither: a run that guessed would un-land a context nobody named, so the
 * caller refuses it whole.
 */
export const resolveNamedBases = (
  prefixes: readonly string[],
  bases: readonly string[],
): NamedBases => {
  const lowered = [...new Set(bases)].map((base) => ({ base, key: base.toLowerCase() }));
  const matchesOf = (prefix: string): readonly string[] =>
    lowered.filter(({ key }) => key.startsWith(prefix.toLowerCase())).map(({ base }) => base);
  const judged = prefixes.map((prefix) => ({ prefix, matches: matchesOf(prefix) }));
  return {
    resolved: new Set(judged.flatMap(({ matches }) => (matches.length === 1 ? matches : []))),
    ambiguous: judged
      .filter(({ matches }) => matches.length > 1)
      .map(({ prefix, matches }) => ({ prefix, matches: matches.length })),
    unmatched: judged.filter(({ matches }) => matches.length === 0).map(({ prefix }) => prefix),
  };
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
