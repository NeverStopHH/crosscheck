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
 * SEVEN DAYS (LANDED_NOTICE_TTL_DAYS), counted from the FIRST stop of a row
 * that was told: a told row is never refreshed, so a reader still stopped at
 * the same missing commit a week later tells the author again. Rows past
 * the seven days are never listed — which is also why a stop that arrives
 * older than that tells nobody — and are deleted when a stop in the same
 * repo is ingested, which frees their commits for a stop after them.
 *
 * AN UNASKED SURFACE for the author: a reader the author muted is hidden
 * while the mute lasts (services/visibility.ts). The READER's presence
 * opt-out does not hide it (decision 9): the reader's own stop said the
 * author would be told.
 */
import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";

import type { LandedNoticeDelivery, LandedStop, LandedStopCommit } from "@crosscheck/schema";

import {
  LANDED_NOTICE_GROUPS_LISTED,
  LANDED_NOTICE_ROWS_READ,
  LANDED_NOTICE_TTL_DAYS,
} from "../constants.ts";
import { developerEmails, developers, landedNotices } from "../db/schema.ts";
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

export const ingestLandedStop = async (
  deps: Deps,
  developerId: string,
  body: LandedStop,
): Promise<HandlerOutcome> => {
  const sessionIssue = await checkOwnedSession(deps.db, developerId, body.sessionId, "sessionId");
  if (sessionIssue !== null) {
    return rejectedOutcome(sessionIssue);
  }
  const now = deps.now();
  const cutoff = cutoffOf(now);
  // FIRST, so an expired row frees its commit for this very stop.
  await deps.db
    .delete(landedNotices)
    .where(and(eq(landedNotices.repo, body.repo), lte(landedNotices.stoppedAt, cutoff)));
  const stoppedAt = notAfter(body.stoppedAt, now);
  const commits = await toldCommits(deps, developerId, body.commits);
  if (commits.length === 0) {
    return { status: "ignored", issues: ["commits: no named author owns the commit's address"] };
  }
  const path = storedSpelling(body.path);
  const written = await deps.db
    .insert(landedNotices)
    .values(
      commits.map((commit) => ({
        id: `lnt_${crypto.randomUUID()}`,
        repo: body.repo,
        path,
        sha: commit.sha,
        subject: commit.subject,
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
    })
    .returning({ id: landedNotices.id });
  return written.length === 0 ? { status: "duplicate" } : { status: "accepted" };
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
 * The author's waiting notices in this repo, grouped by reader and file,
 * the newest stop first, at most LANDED_NOTICE_GROUPS_LISTED groups.
 */
export const listLandedNotices = async (
  deps: Deps,
  authorDeveloperId: string,
  repo: string,
): Promise<readonly LandedNotice[]> => {
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
        eq(landedNotices.authorDeveloperId, authorDeveloperId),
        eq(landedNotices.repo, repo),
        isNull(landedNotices.deliveredAt),
        gt(landedNotices.stoppedAt, cutoffOf(deps.now())),
        notMutedCondition(authorDeveloperId, landedNotices.readerDeveloperId),
      ),
    )
    .orderBy(desc(landedNotices.stoppedAt), desc(landedNotices.missing), asc(landedNotices.sha))
    .limit(LANDED_NOTICE_ROWS_READ);
  // Rows arrive newest first, so a group's first row is its latest stop.
  const groups = new Map<string, readonly (typeof rows)[number][]>();
  for (const row of rows) {
    const key = `${row.readerDeveloperId}\n${row.path}`;
    const members = groups.get(key);
    if (members !== undefined) {
      groups.set(key, [...members, row]);
    } else if (groups.size < LANDED_NOTICE_GROUPS_LISTED) {
      groups.set(key, [row]);
    }
  }
  return [...groups.values()].flatMap((members) => {
    const [newest] = members;
    return newest === undefined
      ? []
      : [
          {
            id: newest.id,
            readerName: newest.readerName,
            path: newest.path,
            stoppedAt: newest.stoppedAt.toISOString(),
            commits: members
              .map((row) => ({ id: row.id, sha: row.sha, subject: row.subject, missing: row.missing }))
              .sort((a, b) => Number(b.missing) - Number(a.missing) || a.sha.localeCompare(b.sha)),
          },
        ];
  });
};
