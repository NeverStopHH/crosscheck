/**
 * Whose work a landed commit was (docs/1.0/landed-changes.md, step 3).
 *
 * THE MATCH IS PROBABLE, BY DESIGN (decision 6). The hub keeps no table of
 * commits (spec 02 refused one), and a squash merge lands under a new sha, so
 * no commit identity can carry the link. What survives every way of merging
 * is the person, the file and the time:
 * - the commit's author address, mapped to a developer through
 *   `developer_emails` (aliases an admin linked included);
 * - a work context of that developer that targeted this file, in this repo;
 * - from a session STARTED no later than the commit. The session's start,
 *   not when the edit reached the hub: an edit is recorded when the spool
 *   flushes, which on a laptop that was offline can be after the commit.
 * Of several, the latest such work is named, and the connector says "work on
 * this file before it landed", never "the reason for this commit".
 *
 * AN UNASKED SURFACE: the answer is printed in a stop nobody asked for, so a
 * developer the caller muted is left out. A presence opt-out is not: this is
 * published work, not presence (services/visibility.ts). Never the caller's
 * own work. Never an address in the answer.
 */
import { and, desc, eq, inArray, lte, ne, sql } from "drizzle-orm";

import type { Intent, LandedContextRequest } from "@crosscheck/schema";
import { IntentSchema } from "@crosscheck/schema";

import {
  agentSessions,
  developerEmails,
  developers,
  workContextTargets,
  workContexts,
} from "../db/schema.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";
import { notMutedCondition } from "./visibility.ts";

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

/**
 * Candidate rows one question reads. A handful of commits by at most a few
 * authors on ONE file: this bounds a pathological history (thousands of
 * sessions on one hot file), never an ordinary one.
 */
const MAX_CANDIDATE_ROWS = 200;

export interface LandedContextMatch {
  readonly sha: string;
  readonly workContextId: string;
  readonly title: string;
  readonly developerName: string;
  readonly intent: Intent | null;
}

interface Candidate {
  readonly email: string;
  readonly startedAt: Date;
  readonly workContextId: string;
  readonly title: string;
  readonly developerName: string;
  readonly intent: unknown;
}

const lowered = (email: string): string => email.trim().toLowerCase();

/** A stored intent the current schema cannot read costs the line, not the match. */
const intentOf = (stored: unknown): Intent | null => {
  const parsed = IntentSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
};

const readCandidates = async (
  deps: Deps,
  callerDeveloperId: string,
  request: LandedContextRequest,
): Promise<readonly Candidate[]> => {
  const emails = [...new Set(request.commits.map((commit) => lowered(commit.authorEmail)))];
  const latestCommit = new Date(
    Math.max(...request.commits.map((commit) => Date.parse(commit.committedAt))),
  );
  const rows = await deps.db
    .select({
      email: developerEmails.email,
      startedAt: agentSessions.startedAt,
      workContextId: workContexts.id,
      title: workContexts.title,
      developerName: developers.name,
      intent: workContexts.intent,
    })
    .from(workContextTargets)
    .innerJoin(workContexts, eq(workContextTargets.workContextId, workContexts.id))
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .innerJoin(developers, eq(agentSessions.developerId, developers.id))
    .innerJoin(developerEmails, eq(developerEmails.developerId, agentSessions.developerId))
    .where(
      and(
        eq(workContextTargets.kind, "file"),
        eq(workContextTargets.value, request.path),
        eq(agentSessions.repo, request.repo),
        inArray(developerEmails.email, emails),
        ne(agentSessions.developerId, callerDeveloperId),
        lte(agentSessions.startedAt, latestCommit),
        notMutedCondition(callerDeveloperId, agentSessions.developerId),
      ),
    )
    .orderBy(desc(agentSessions.startedAt), desc(workContexts.createdAt), sql`${workContexts.id} DESC`)
    .limit(MAX_CANDIDATE_ROWS);
  return rows;
};

/**
 * One match per commit that has one, in the order the commits were asked.
 * Rows arrive latest-start first, so the first row of the commit's author
 * that started no later than the commit IS the latest work before it.
 */
export const findLandedContexts = async (
  deps: Deps,
  callerDeveloperId: string,
  request: LandedContextRequest,
): Promise<readonly LandedContextMatch[]> => {
  const candidates = await readCandidates(deps, callerDeveloperId, request);
  return request.commits.flatMap((commit): LandedContextMatch[] => {
    const email = lowered(commit.authorEmail);
    const committedAt = Date.parse(commit.committedAt);
    const found = candidates.find(
      (candidate) => candidate.email === email && candidate.startedAt.getTime() <= committedAt,
    );
    return found === undefined
      ? []
      : [
          {
            sha: commit.sha,
            workContextId: found.workContextId,
            title: found.title,
            developerName: found.developerName,
            intent: intentOf(found.intent),
          },
        ];
  });
};

/**
 * The addresses asked about that belong to NOBODY on this hub, spelled as
 * they were asked (decision 7: doctor names them with the .mailmap line
 * that fixes them). Only what the caller sent comes back.
 */
export const unknownAuthorEmails = async (
  deps: Deps,
  emails: readonly string[],
): Promise<readonly string[]> => {
  const firstSpelling = new Map<string, string>();
  for (const email of emails) {
    const key = lowered(email);
    if (!firstSpelling.has(key)) {
      firstSpelling.set(key, email.trim());
    }
  }
  if (firstSpelling.size === 0) {
    return [];
  }
  const known = await deps.db
    .select({ email: developerEmails.email })
    .from(developerEmails)
    .where(inArray(developerEmails.email, [...firstSpelling.keys()]));
  const knownSet = new Set(known.map((row) => row.email));
  return [...firstSpelling].filter(([key]) => !knownSet.has(key)).map(([, spelling]) => spelling);
};
