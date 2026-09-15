import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

import {
  ABSENCE_COMMIT_MAX_AGE_DAYS,
  ABSENCE_EVIDENCE_MAX_AGE_DAYS,
  ABSENCE_MAX_EVIDENCE_ROWS,
  ABSENCE_MAX_FINDINGS,
  ABSENCE_MIN_GAP_HOURS,
} from "../constants.ts";
import {
  agentSessions,
  commitEvidence,
  developerEmails,
  developers,
} from "../db/schema.ts";
import { notMutedCondition, visiblePresenceCondition } from "./visibility.ts";
import type { SQL } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * The evidence rows this repo's absence question is asked over: fresh enough
 * to be worth reading, recent enough to be worth reporting, and visible to
 * THIS viewer. Shared verbatim by the bounded listing below and by the
 * unbounded census beside it, because two spellings of "which rows count" is
 * how a cap quietly turns into a claim.
 */
const absenceEvidenceWhere = (
  now: Date,
  viewerDeveloperId: string,
): SQL | undefined =>
  and(
    gte(
      commitEvidence.collectedAt,
      new Date(now.getTime() - ABSENCE_EVIDENCE_MAX_AGE_DAYS * MS_PER_DAY),
    ),
    gte(
      commitEvidence.latestCommitAt,
      new Date(now.getTime() - ABSENCE_COMMIT_MAX_AGE_DAYS * MS_PER_DAY),
    ),
    // Privacy (header): matched members respect opt-out and the viewer's
    // mutes; unmatched rows (developers.id NULL) have no subject to check.
    sql`(${developers.id} IS NULL OR (${visiblePresenceCondition(viewerDeveloperId, developers.id)} AND ${notMutedCondition(viewerDeveloperId, developers.id)}))`,
  );

/**
 * The two findings the design insists stay distinct (absence detection):
 * `inactive` — a hub member whose commits postdate their last reported agent
 * session on this repo; `unconnected` — a commit author no hub member's email
 * matches at all. Conflating them would send half the readers to the wrong
 * fix (a dead connector vs. a missing invitation).
 */
export type AbsenceKind = "inactive" | "unconnected";

export interface AbsenceFinding {
  readonly kind: AbsenceKind;
  /** Hub display name for members, git author name otherwise — NEVER an email. */
  readonly name: string;
  readonly latestCommitAt: string;
  /** Null when the developer has no reported session on this repo at all. */
  readonly lastSessionAt: string | null;
  /** When the evidence behind this line was read from git — staleness surface. */
  readonly evidenceCollectedAt: string;
}

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

/** Driver-agnostic timestamp read: raw aggregates bypass drizzle's mapping. */
const toDate = (value: unknown): Date | null => {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  return null;
};

const lastSessionByDeveloper = async (
  deps: Deps,
  repo: string,
  developerIds: readonly string[],
): Promise<ReadonlyMap<string, Date>> => {
  if (developerIds.length === 0) {
    return new Map();
  }
  const rows = await deps.db
    .select({
      developerId: agentSessions.developerId,
      lastAt: sql`max(${agentSessions.lastHeartbeatAt})`,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.repo, repo),
        inArray(agentSessions.developerId, [...developerIds]),
      ),
    )
    .groupBy(agentSessions.developerId);
  return new Map(
    rows.flatMap((row) => {
      const lastAt = toDate(row.lastAt);
      return lastAt === null ? [] : [[row.developerId, lastAt] as const];
    }),
  );
};

/**
 * Absence findings for one repo, freshest commit first.
 *
 * PHRASING CONTRACT: every finding is a factual observation — "newest commit
 * at X, last reported session at Y" — never an inference about what somebody
 * did or did not do. We see agent sessions, not keystrokes: a developer can
 * legitimately work without an agent, and a member committing under an email
 * the hub knows NONE of — primary or alias (developer_emails, trial finding
 * #7) — still surfaces as `unconnected`; the alias admin API is the fix for
 * that noise, not a phrasing change (DESIGN.md §10 risk 3 — this is a
 * surveillance-adjacent surface, renderers must keep the phrasing factual).
 *
 * PRIVACY (DESIGN.md §10 risk 3, services/visibility.ts): `inactive` findings
 * report the same person's activity presence does, so an opted-out member is
 * excluded from every viewer's findings but their own, and a member the
 * VIEWER muted is excluded from that viewer's. Both conditions sit in the
 * evidence query's WHERE — after the LIMIT they could crowd includable rows
 * out of the bound. `unconnected` rows are exempt by construction: they exist
 * precisely because no developer row matches, so there is nobody whose
 * setting could apply.
 *
 * Every bound is a named constant: evidence read LIMIT, per-response finding
 * cap, evidence staleness cutoff, commit-age cutoff, and the grace gap that
 * keeps the normal commit-after-session workflow silent.
 */
export const listAbsences = async (
  deps: Deps,
  viewerDeveloperId: string,
  repo: string,
): Promise<readonly AbsenceFinding[]> => {
  const now = deps.now();
  const rows = await deps.db
    .select({
      authorName: commitEvidence.authorName,
      latestCommitAt: commitEvidence.latestCommitAt,
      collectedAt: commitEvidence.collectedAt,
      developerId: developers.id,
      developerName: developers.name,
    })
    .from(commitEvidence)
    // ALL of a member's emails match, not just the primary (trial finding
    // #7): the alias table stores every address lowercased, commit evidence
    // stores its author_email lowercased, so the join is a plain equality.
    // developer_emails' PK on email guarantees at most one alias row — and
    // therefore at most one developer — per evidence row.
    .leftJoin(
      developerEmails,
      eq(developerEmails.email, commitEvidence.authorEmail),
    )
    .leftJoin(developers, eq(developers.id, developerEmails.developerId))
    .where(
      and(
        eq(commitEvidence.repo, repo),
        absenceEvidenceWhere(now, viewerDeveloperId),
      ),
    )
    .orderBy(desc(commitEvidence.latestCommitAt))
    .limit(ABSENCE_MAX_EVIDENCE_ROWS);

  const memberIds = rows.flatMap((row) =>
    row.developerId === null ? [] : [row.developerId],
  );
  const lastSessions = await lastSessionByDeveloper(deps, repo, memberIds);

  const graceMs = ABSENCE_MIN_GAP_HOURS * MS_PER_HOUR;
  const findings = rows.flatMap((row): readonly AbsenceFinding[] => {
    const base = {
      latestCommitAt: row.latestCommitAt.toISOString(),
      evidenceCollectedAt: row.collectedAt.toISOString(),
    };
    if (row.developerId === null || row.developerName === null) {
      return [
        { kind: "unconnected", name: row.authorName, lastSessionAt: null, ...base },
      ];
    }
    const lastSession = lastSessions.get(row.developerId) ?? null;
    const isReported =
      lastSession !== null &&
      row.latestCommitAt.getTime() - lastSession.getTime() <= graceMs;
    if (isReported) {
      return [];
    }
    return [
      {
        kind: "inactive",
        name: row.developerName,
        lastSessionAt: lastSession === null ? null : lastSession.toISOString(),
        ...base,
      },
    ];
  });
  return findings.slice(0, ABSENCE_MAX_FINDINGS);
};

/**
 * THE SAME QUESTION WITHOUT THE BOUNDS — because `listAbsences` answers a
 * RENDERING question and coverage asks an OBSERVATION one.
 *
 * `listAbsences` cuts twice: ABSENCE_MAX_EVIDENCE_ROWS rows ordered
 * `latest_commit_at DESC`, then ABSENCE_MAX_FINDINGS findings. Both bounds
 * drop the STALEST committers first, which is precisely the population an
 * absence check exists to find, and both are crossed by TEAM SIZE rather than
 * by anything about observation — `commit_evidence` is keyed
 * (repo, author_email), so 200 addresses fill the first cap whatever the hub
 * saw. A git coverage rung reading the resulting empty list as "nobody is
 * absent" turns "we stopped looking" into `complete`, and `isJudgeable` with
 * it; a `min()` over the kept findings is a minimum over the 20 most RECENT
 * absentees, which is later than the earliest gap and always in the
 * reassuring direction.
 *
 * So this returns a CENSUS: one aggregate, no LIMIT, no ORDER BY, nothing to
 * truncate. It carries no names and no addresses — a count and two instants —
 * which is also why it may be unbounded where the listing may not.
 *
 * The gap predicate is the listing's, in SQL: a commit author no member's
 * address matches, or one whose newest commit postdates their newest reported
 * session on this repo by more than ABSENCE_MIN_GAP_HOURS. Drift between the
 * two spellings is a red build rather than a review catch — coverage.test.ts
 * pins them against each other on a corpus under both caps, where the listing
 * is a census too.
 */
export interface AbsenceCensus {
  /** Commit authors on this repo with no reported session. Never truncated. */
  readonly unreportedAuthors: number;
  /** Earliest last-reported session among them; null when none ever reported. */
  readonly earliestSessionAt: string | null;
  /** Earliest commit among them — the "else" when no session was reported. */
  readonly earliestCommitAt: string | null;
}

export const readAbsenceCensus = async (
  deps: Deps,
  viewerDeveloperId: string,
  repo: string,
): Promise<AbsenceCensus> => {
  const now = deps.now();
  const graceMs = ABSENCE_MIN_GAP_HOURS * MS_PER_HOUR;
  // A CORRELATED LOOKUP, ON PURPOSE, because `agent_sessions_developer_repo_idx`
  // is (developer_id, repo) and serves exactly this shape in one index probe
  // per evidence row. A grouped subquery joined in instead looks cheaper and
  // is not: on a hub whose planner has no statistics — PGlite runs a
  // single-process Postgres with no background workers, so autovacuum never
  // fires and `reltuples` stays -1 — it is re-evaluated per row. Measured on
  // a 200-developer corpus (5,000 sessions on the repo, 260 evidence rows):
  // the joined subquery p50 225.6 ms, this p50 7.8 ms.
  const lastSessionAt = sql`(select max(${agentSessions.lastHeartbeatAt}) from ${agentSessions} where ${agentSessions.developerId} = ${developers.id} and ${agentSessions.repo} = ${repo})`;
  // The listing's two findings in one predicate. An address no member matches
  // loses the `developers` join, so the lookup above is over a NULL id and
  // answers null — the same gap as a member who never reported a session on
  // this repo. What is left is the grace rule: a commit more than
  // ABSENCE_MIN_GAP_HOURS after its author's newest reported session.
  const isGap = sql`(${lastSessionAt} is null or (extract(epoch from (${commitEvidence.latestCommitAt} - ${lastSessionAt})) * 1000) > ${graceMs})`;
  const rows = await deps.db
    .select({
      gaps: sql`count(*) filter (where ${isGap})`,
      earliestSessionAt: sql`min(${lastSessionAt}) filter (where ${isGap})`,
      earliestCommitAt: sql`min(${commitEvidence.latestCommitAt}) filter (where ${isGap})`,
    })
    .from(commitEvidence)
    .leftJoin(
      developerEmails,
      eq(developerEmails.email, commitEvidence.authorEmail),
    )
    .leftJoin(developers, eq(developers.id, developerEmails.developerId))
    .where(
      and(
        eq(commitEvidence.repo, repo),
        absenceEvidenceWhere(now, viewerDeveloperId),
      ),
    );
  const row = rows[0];
  const counted = Number(row?.gaps);
  return {
    unreportedAuthors: Number.isFinite(counted) ? counted : 0,
    earliestSessionAt: toDate(row?.earliestSessionAt)?.toISOString() ?? null,
    earliestCommitAt: toDate(row?.earliestCommitAt)?.toISOString() ?? null,
  };
};
