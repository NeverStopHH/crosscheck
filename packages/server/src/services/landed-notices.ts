/**
 * The author's notice (docs/1.0/landed-changes.md, step 4, decisions 8–11):
 * a reader's edit stopped at an author's landed commit; the author is told
 * once, within seven days.
 *
 * WHO IS TOLD is decided before this module ever runs: the why answer named
 * the developer behind each commit's address (landed-context.ts,
 * `toldAuthors`), the stop printed "Mike is told about this stop", and its
 * record carries exactly those ids. Ingest checks each again — the address
 * must still belong to the named developer, and never to the reader — and
 * drops a commit that fails, so nobody the stop did not name is told.
 *
 * ONCE PER READER, FILE AND COMMIT. The unique index turns a second stop on
 * the same commit into a refresh of a row not yet told (the reader may have
 * pulled it since: `missing` and the time follow the newer stop) and into
 * nothing for one already told. A new commit is a new row.
 *
 * SEVEN DAYS (LANDED_NOTICE_TTL_DAYS), counted from a row's latest stop
 * before it was told — a stop refreshes a row only until it is told, and a
 * told row is never refreshed — so a reader still stopped at the same
 * missing commit a week after that tells the author again. A stop that
 * arrives older than that is not stored. Rows past the seven days are never
 * listed, and are deleted before every stop's ingest (which frees their
 * commits for that stop) and by the reaper pass (so a quiet repo does not
 * keep them, subjects and all, for good).
 *
 * THE READER LEARNS NOTHING FROM HOW A STOP IS RECEIVED. Every admissible
 * stop answers `accepted`, whether it wrote a row, refreshed one, met a row
 * already told, named an address that is not the named developer's, or met
 * the pair's cap. An answer that followed the rows would be a read receipt:
 * a replayed stop flipping from `accepted` to `duplicate` the moment the
 * author opened a session — presence the author may have turned off — and
 * never flipping for a reader the author muted, which would disclose the
 * mute.
 *
 * BOUNDED PER PAIR: one reader holds at most
 * LANDED_NOTICE_MAX_WAITING_PER_PAIR waiting rows for one author, and the
 * listing takes one group per reader before anyone's second, so one reader's
 * stops — or forged records — cannot crowd another reader's out.
 *
 * A subject the local secret scan flags is stored blank: the connector
 * already sends it blank, and the hub does not trust that it did.
 *
 * AN UNASKED SURFACE for the author: a reader the author muted is hidden
 * while the mute lasts (services/visibility.ts). The READER's presence
 * opt-out does not hide it (decision 9): the reader's own stop said the
 * author would be told.
 */
import { and, asc, count, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { containsSecret } from "@crosscheck/schema";
import type { LandedNoticeDelivery, LandedStop, LandedStopCommit } from "@crosscheck/schema";

import {
  LANDED_NOTICE_GROUPS_LISTED,
  LANDED_NOTICE_MAX_WAITING_PER_PAIR,
  LANDED_NOTICE_GROUPS_READ,
  LANDED_NOTICE_TTL_DAYS,
} from "../constants.ts";
import { agentSessions, developerEmails, developers, landedNotices } from "../db/schema.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";
import { storedSpelling } from "./landed-context.ts";
import { checkOwnedSession, rejectedOutcome } from "./record-handlers.ts";
import type { HandlerOutcome } from "./record-handlers.ts";
import { notMutedCondition } from "./visibility.ts";

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

const MS_PER_DAY = 86_400_000;

const cutoffOf = (now: Date): Date => new Date(now.getTime() - LANDED_NOTICE_TTL_DAYS * MS_PER_DAY);

const lowered = (email: string): string => email.trim().toLowerCase();

/** A sender's clock bounded by ours: a stop or a delivery is never in the future. */
const notAfter = (iso: string, now: Date): Date => new Date(Math.min(Date.parse(iso), now.getTime()));

/**
 * The commits whose address belongs to the developer the stop named, and not
 * to the reader; each sha once (one INSERT cannot update the same row twice).
 */
const toldCommits = async (
  deps: Deps,
  readerDeveloperId: string,
  commits: readonly LandedStopCommit[],
): Promise<readonly LandedStopCommit[]> => {
  const emails = [...new Set(commits.map((commit) => lowered(commit.authorEmail)))];
  const known = await deps.db
    .select({ email: developerEmails.email, developerId: developerEmails.developerId })
    .from(developerEmails)
    .where(inArray(developerEmails.email, emails));
  const owner = new Map(known.map((row) => [row.email, row.developerId]));
  const seen = new Set<string>();
  return commits.filter((commit) => {
    const developerId = owner.get(lowered(commit.authorEmail));
    const isTold =
      developerId === commit.authorDeveloperId && developerId !== readerDeveloperId && !seen.has(commit.sha);
    seen.add(commit.sha);
    return isTold;
  });
};

/** Rows past the seven days, in every repo: before each stop, and from the reaper. */
export const pruneLandedNotices = async (deps: Deps): Promise<void> => {
  await deps.db.delete(landedNotices).where(lte(landedNotices.stoppedAt, cutoffOf(deps.now())));
};

/** A stop belongs to the repo its reader's session reports, as a question does. */
const checkSessionRepo = async (deps: Deps, sessionId: string, repo: string): Promise<string | null> => {
  const rows = await deps.db
    .select({ repo: agentSessions.repo })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  return rows[0]?.repo === repo ? null : "repo: must be the repo this session reports";
};

/** The commits whose author still has room in this reader's waiting rows. */
const withinPairBudget = async (
  deps: Deps,
  readerDeveloperId: string,
  commits: readonly LandedStopCommit[],
  cutoff: Date,
): Promise<readonly LandedStopCommit[]> => {
  const authors = [...new Set(commits.map((commit) => commit.authorDeveloperId))];
  if (authors.length === 0) {
    return [];
  }
  const waiting = await deps.db
    .select({ authorDeveloperId: landedNotices.authorDeveloperId, rows: count() })
    .from(landedNotices)
    .where(
      and(
        eq(landedNotices.readerDeveloperId, readerDeveloperId),
        inArray(landedNotices.authorDeveloperId, authors),
        isNull(landedNotices.deliveredAt),
        gt(landedNotices.stoppedAt, cutoff),
      ),
    )
    .groupBy(landedNotices.authorDeveloperId);
  const held = new Map(waiting.map((row) => [row.authorDeveloperId, row.rows]));
  return commits.filter((commit) => (held.get(commit.authorDeveloperId) ?? 0) < LANDED_NOTICE_MAX_WAITING_PER_PAIR);
};

const ACCEPTED: HandlerOutcome = { status: "accepted" };

export const ingestLandedStop = async (
  deps: Deps,
  developerId: string,
  body: LandedStop,
): Promise<HandlerOutcome> => {
  const sessionIssue =
    (await checkOwnedSession(deps.db, developerId, body.sessionId, "sessionId")) ??
    (await checkSessionRepo(deps, body.sessionId, body.repo));
  if (sessionIssue !== null) {
    return rejectedOutcome(sessionIssue);
  }
  const now = deps.now();
  const cutoff = cutoffOf(now);
  // FIRST, so an expired row frees its commit for this very stop.
  await pruneLandedNotices(deps);
  const stoppedAt = notAfter(body.stoppedAt, now);
  if (stoppedAt.getTime() <= cutoff.getTime()) {
    return { status: "ignored", issues: [`stoppedAt: more than ${String(LANDED_NOTICE_TTL_DAYS)} days ago; nobody is told`] };
  }
  const commits = await withinPairBudget(deps, developerId, await toldCommits(deps, developerId, body.commits), cutoff);
  if (commits.length === 0) {
    return ACCEPTED;
  }
  const path = storedSpelling(body.path);
  await deps.db
    .insert(landedNotices)
    .values(
      commits.map((commit) => ({
        id: `lnt_${crypto.randomUUID()}`,
        repo: body.repo,
        path,
        sha: commit.sha,
        subject: containsSecret(commit.subject) ? "" : commit.subject,
        missing: commit.missing,
        authorDeveloperId: commit.authorDeveloperId,
        readerDeveloperId: developerId,
        stoppedAt,
      })),
    )
    .onConflictDoUpdate({
      target: [landedNotices.readerDeveloperId, landedNotices.repo, landedNotices.path, landedNotices.sha],
      set: {
        subject: sql`excluded.subject`,
        missing: sql`excluded.missing`,
        stoppedAt: sql`excluded.stopped_at`,
      },
      // A told row stays told; a replayed OLDER stop never rolls a newer one back.
      setWhere: sql`${landedNotices.deliveredAt} IS NULL AND excluded.stopped_at >= ${landedNotices.stoppedAt}`,
    });
  // The same answer whatever the rows did — see the header.
  return ACCEPTED;
};

/** Marks told only notices addressed to the sender, and only once. */
export const ingestLandedNoticeDelivery = async (
  deps: Deps,
  developerId: string,
  body: LandedNoticeDelivery,
): Promise<HandlerOutcome> => {
  const sessionIssue = await checkOwnedSession(deps.db, developerId, body.sessionId, "sessionId");
  if (sessionIssue !== null) {
    return rejectedOutcome(sessionIssue);
  }
  const marked = await deps.db
    .update(landedNotices)
    .set({ deliveredAt: notAfter(body.deliveredAt, deps.now()) })
    .where(
      and(
        inArray(landedNotices.id, [...new Set(body.noticeIds)]),
        eq(landedNotices.authorDeveloperId, developerId),
        isNull(landedNotices.deliveredAt),
      ),
    )
    .returning({ id: landedNotices.id });
  return marked.length === 0 ? { status: "duplicate" } : { status: "accepted" };
};

export interface LandedNoticeCommit {
  /** The row's id: what a delivery marks. */
  readonly id: string;
  readonly sha: string;
  readonly subject: string;
  readonly missing: boolean;
}

/** One reader's stop(s) on one file, waiting for the author. */
export interface LandedNotice {
  /** The newest row's id: one name for the group, for a prompt's one slot. */
  readonly id: string;
  readonly readerName: string;
  readonly path: string;
  /** The group's latest stop. */
  readonly stoppedAt: string;
  /** Missing first, then by sha. */
  readonly commits: readonly LandedNoticeCommit[];
}

/**
 * The author's waiting notices in this repo, grouped by reader and file, at
 * most LANDED_NOTICE_GROUPS_LISTED groups: every reader's newest group
 * before anyone's second, newest first within a round — so one reader's many
 * stops cannot crowd out another reader's one.
 *
 * GROUPS FIRST, THEN THEIR ROWS. Choosing the groups from an aggregate and
 * then reading every row of exactly those groups means a listed group comes
 * whole: a row cap applied before grouping would cut an older commit off a
 * listed group, and it would come back later as a second notice about the
 * same reader and file. A group holds at most one reader's waiting rows for
 * this author, which LANDED_NOTICE_MAX_WAITING_PER_PAIR bounds.
 */
export const listLandedNotices = async (
  deps: Deps,
  authorDeveloperId: string,
  repo: string,
): Promise<readonly LandedNotice[]> => {
  const waiting = and(
    eq(landedNotices.authorDeveloperId, authorDeveloperId),
    eq(landedNotices.repo, repo),
    isNull(landedNotices.deliveredAt),
    gt(landedNotices.stoppedAt, cutoffOf(deps.now())),
    notMutedCondition(authorDeveloperId, landedNotices.readerDeveloperId),
  );
  const newest = sql<Date>`max(${landedNotices.stoppedAt})`.mapWith(landedNotices.stoppedAt);
  const groups = await deps.db
    .select({ readerDeveloperId: landedNotices.readerDeveloperId, path: landedNotices.path, newest })
    .from(landedNotices)
    .where(waiting)
    .groupBy(landedNotices.readerDeveloperId, landedNotices.path)
    .orderBy(desc(newest), asc(landedNotices.readerDeveloperId), asc(landedNotices.path))
    .limit(LANDED_NOTICE_GROUPS_READ);
  const roundOf = new Map<string, number>();
  const chosen = groups
    .map((group) => {
      const round = roundOf.get(group.readerDeveloperId) ?? 0;
      roundOf.set(group.readerDeveloperId, round + 1);
      return { ...group, round };
    })
    .sort((a, b) => a.round - b.round || b.newest.getTime() - a.newest.getTime())
    .slice(0, LANDED_NOTICE_GROUPS_LISTED);
  if (chosen.length === 0) {
    return [];
  }
  const rows = await deps.db
    .select({
      id: landedNotices.id,
      path: landedNotices.path,
      sha: landedNotices.sha,
      subject: landedNotices.subject,
      missing: landedNotices.missing,
      stoppedAt: landedNotices.stoppedAt,
      readerDeveloperId: landedNotices.readerDeveloperId,
      readerName: developers.name,
    })
    .from(landedNotices)
    .innerJoin(developers, eq(developers.id, landedNotices.readerDeveloperId))
    .where(
      and(
        waiting,
        or(
          ...chosen.map((group) =>
            and(eq(landedNotices.readerDeveloperId, group.readerDeveloperId), eq(landedNotices.path, group.path)),
          ),
        ),
      ),
    )
    .orderBy(desc(landedNotices.stoppedAt), asc(landedNotices.id));
  return chosen.flatMap((group) => {
    const members = rows.filter(
      (row) => row.readerDeveloperId === group.readerDeveloperId && row.path === group.path,
    );
    const [latest] = members;
    return latest === undefined
      ? []
      : [
          {
            id: latest.id,
            readerName: latest.readerName,
            path: latest.path,
            stoppedAt: latest.stoppedAt.toISOString(),
            commits: members
              .map((row) => ({ id: row.id, sha: row.sha, subject: row.subject, missing: row.missing }))
              .sort((a, b) => Number(b.missing) - Number(a.missing) || a.sha.localeCompare(b.sha)),
          },
        ];
  });
};
