/**
 * Whose work a landed commit was (docs/1.0/landed-changes.md, step 3).
 *
 * THE MATCH IS PROBABLE, BY DESIGN (decision 6). The hub keeps no table of
 * commits (spec 02 refused one), and a squash merge lands under a new sha, so
 * no commit identity can carry the link. What survives every way of merging
 * is the person, the file and the time. For each commit, one question:
 * - a work context of the commit's author (the address mapped through
 *   `developer_emails`, aliases an admin linked included) that targeted this
 *   file (in its one canonical spelling, as ingest stores it) in this repo;
 * - from a session still ACTIVE (a heartbeat) within LANDED_WHY_WINDOW_DAYS
 *   before the commit and STARTED no later than it (plus a clock slack: the
 *   start is the hub's clock, the commit time the author's laptop). The
 *   session's start, not when an edit reached the hub — an edit is recorded
 *   when the spool flushes, which on a laptop that was offline can be after
 *   the commit;
 * - preferring a session that had recorded an edit of the file by the commit
 *   (within the clock slack), then one that recorded it within the flush
 *   slack after (a spool that flushed late), then any, and within each the
 *   latest start.
 * A session's last sign of life is its last HEARTBEAT, never `ended_at`:
 * that is when the hub RECEIVED the end — a reap after hub downtime, or a
 * SessionEnd deferred through the spool for up to a week — which can be
 * weeks after the session went quiet.
 * The connector says "work on this file before it landed", with the work's
 * age, never "the reason for this commit".
 *
 * ONE QUERY PER COMMIT (at most LANDED_CONTEXT_MAX_COMMITS), each LIMIT 1, so
 * one busy author on a hot file can never crowd another commit's match out
 * of a shared row cap.
 *
 * AN UNASKED SURFACE: the answer is printed in a stop nobody asked for, so a
 * developer the caller muted is left out. A presence opt-out hides the work
 * only while its session is LIVE — that is presence; an ended session's work
 * is published (services/visibility.ts). Never the caller's own work. Never
 * an address in the answer.
 */
import { and, desc, eq, inArray, isNotNull, lte, ne, or, sql } from "drizzle-orm";

import type { Intent, LandedContextCommit, LandedContextRequest } from "@crosscheck/schema";
import { IntentSchema, canonicalRepoPath } from "@crosscheck/schema";

import {
  LANDED_WHY_CLOCK_SLACK_MS,
  LANDED_WHY_FLUSH_SLACK_MS,
  LANDED_WHY_WINDOW_DAYS,
} from "../constants.ts";
import {
  agentSessions,
  developerEmails,
  developers,
  workContextTargets,
  workContexts,
} from "../db/schema.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";
import { presenceCutoff } from "./presence.ts";
import { notMutedCondition, visiblePresenceCondition } from "./visibility.ts";

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

const MS_PER_DAY = 86_400_000;

export interface LandedContextMatch {
  readonly sha: string;
  readonly workContextId: string;
  readonly title: string;
  readonly developerName: string;
  readonly intent: Intent | null;
  /** When the session behind the work started — the stop prints its age. */
  readonly workStartedAt: string;
}

const lowered = (email: string): string => email.trim().toLowerCase();

/** A stored intent the current schema cannot read costs the line, not the match. */
const intentOf = (stored: unknown): Intent | null => {
  const parsed = IntentSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
};

/**
 * The file in its one spelling, exactly as target ingest stores it — and as
 * the author's notice stores it (services/landed-notices.ts).
 */
export const storedSpelling = (path: string): string => {
  const canonical = canonicalRepoPath(path);
  return canonical.ok ? canonical.path : path;
};

const matchFor = async (
  deps: Deps,
  callerDeveloperId: string,
  request: LandedContextRequest,
  commit: LandedContextCommit,
): Promise<LandedContextMatch | null> => {
  const committedMs = Date.parse(commit.committedAt);
  const activeSince = new Date(committedMs - LANDED_WHY_WINDOW_DAYS * MS_PER_DAY);
  const startedBy = new Date(committedMs + LANDED_WHY_CLOCK_SLACK_MS);
  const editedBy = startedBy;
  const recordedBy = new Date(committedMs + LANDED_WHY_FLUSH_SLACK_MS);
  const live = presenceCutoff(deps.now());
  const rows = await deps.db
    .select({
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
        eq(workContextTargets.value, storedSpelling(request.path)),
        eq(agentSessions.repo, request.repo),
        eq(developerEmails.email, lowered(commit.authorEmail)),
        ne(agentSessions.developerId, callerDeveloperId),
        lte(agentSessions.startedAt, startedBy),
        sql`${agentSessions.lastHeartbeatAt} >= ${activeSince.toISOString()}::timestamptz`,
        notMutedCondition(callerDeveloperId, agentSessions.developerId),
        // Presence opt-out hides a LIVE session's work only.
        or(
          isNotNull(agentSessions.endedAt),
          lte(agentSessions.lastHeartbeatAt, live),
          visiblePresenceCondition(callerDeveloperId, agentSessions.developerId),
        ),
      ),
    )
    .orderBy(
      // A target with no recorded time (older rows) is not "recorded in time":
      // unguarded, NULL would sort FIRST under DESC and win.
      sql`coalesce(${workContextTargets.createdAt} <= ${editedBy.toISOString()}::timestamptz, false) DESC`,
      sql`coalesce(${workContextTargets.createdAt} <= ${recordedBy.toISOString()}::timestamptz, false) DESC`,
      desc(agentSessions.startedAt),
      desc(workContexts.createdAt),
      sql`${workContexts.id} DESC`,
    )
    .limit(1);
  const found = rows[0];
  return found === undefined
    ? null
    : {
        sha: commit.sha,
        workContextId: found.workContextId,
        title: found.title,
        developerName: found.developerName,
        intent: intentOf(found.intent),
        workStartedAt: found.startedAt.toISOString(),
      };
};

/** One match per commit that has one, in the order the commits were asked. */
export const findLandedContexts = async (
  deps: Deps,
  callerDeveloperId: string,
  request: LandedContextRequest,
): Promise<readonly LandedContextMatch[]> => {
  const matches: LandedContextMatch[] = [];
  for (const commit of request.commits) {
    const match = await matchFor(deps, callerDeveloperId, request, commit);
    if (match !== null) {
      matches.push(match);
    }
  }
  return matches;
};

export interface LandedToldAuthor {
  readonly sha: string;
  readonly developerId: string;
  readonly name: string;
}

/**
 * WHO THE STOP TELLS (step 4, decision 11): for each commit asked about, in
 * the order asked, the developer its author address belongs to — never the
 * caller. The stop prints exactly these names ("Mike is told about this
 * stop") and its record carries exactly these ids, so the hub can never
 * notify someone the stop did not name. A mute of the caller is NOT applied
 * here: a mute is never disclosed, so the author is named and the notice is
 * then hidden on the author's side (services/landed-notices.ts), the rule
 * questions follow. Never an address in the answer.
 */
export const toldAuthors = async (
  deps: Deps,
  callerDeveloperId: string,
  request: LandedContextRequest,
): Promise<readonly LandedToldAuthor[]> => {
  const emails = [...new Set(request.commits.map((commit) => lowered(commit.authorEmail)))];
  const rows = await deps.db
    .select({ email: developerEmails.email, developerId: developers.id, name: developers.name })
    .from(developerEmails)
    .innerJoin(developers, eq(developers.id, developerEmails.developerId))
    .where(and(inArray(developerEmails.email, emails), ne(developers.id, callerDeveloperId)));
  const byEmail = new Map(rows.map((row) => [row.email, row]));
  return request.commits.flatMap((commit) => {
    const author = byEmail.get(lowered(commit.authorEmail));
    return author === undefined ? [] : [{ sha: commit.sha, developerId: author.developerId, name: author.name }];
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
