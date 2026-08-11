import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

import {
  ABSENCE_COMMIT_MAX_AGE_DAYS,
  ABSENCE_EVIDENCE_MAX_AGE_DAYS,
  ABSENCE_MAX_EVIDENCE_ROWS,
  ABSENCE_MAX_FINDINGS,
  ABSENCE_MIN_GAP_HOURS,
} from "../constants.ts";
import { agentSessions, commitEvidence, developers } from "../db/schema.ts";
import { notMutedCondition, visiblePresenceCondition } from "./visibility.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

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
 * legitimately work without an agent, and a member whose git email differs
 * from their hub email will surface as `unconnected` (DESIGN.md §10 risk 3 —
 * this is a surveillance-adjacent surface, renderers must keep the phrasing
 * factual).
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
  const evidenceCutoff = new Date(
    now.getTime() - ABSENCE_EVIDENCE_MAX_AGE_DAYS * MS_PER_DAY,
  );
  const commitCutoff = new Date(
    now.getTime() - ABSENCE_COMMIT_MAX_AGE_DAYS * MS_PER_DAY,
  );
  const rows = await deps.db
    .select({
      authorName: commitEvidence.authorName,
      latestCommitAt: commitEvidence.latestCommitAt,
      collectedAt: commitEvidence.collectedAt,
      developerId: developers.id,
      developerName: developers.name,
    })
    .from(commitEvidence)
    .leftJoin(
      developers,
      eq(sql`lower(${developers.email})`, commitEvidence.authorEmail),
    )
    .where(
      and(
        eq(commitEvidence.repo, repo),
        gte(commitEvidence.collectedAt, evidenceCutoff),
        gte(commitEvidence.latestCommitAt, commitCutoff),
        // Privacy (header): matched members respect opt-out and the viewer's
        // mutes; unmatched rows (developers.id NULL) have no subject to check.
        sql`(${developers.id} IS NULL OR (${visiblePresenceCondition(viewerDeveloperId, developers.id)} AND ${notMutedCondition(viewerDeveloperId, developers.id)}))`,
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
