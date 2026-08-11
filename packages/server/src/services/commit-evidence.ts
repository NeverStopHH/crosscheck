import { and, eq, gt, lt, or, sql } from "drizzle-orm";
import { MAX_COMMIT_CLOCK_SKEW_MS } from "@crosscheck/schema";
import type { CommitEvidence } from "@crosscheck/schema";

import { COMMIT_EVIDENCE_RETENTION_DAYS } from "../constants.ts";
import { commitEvidence } from "../db/schema.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";
import type { HandlerOutcome } from "./record-handlers.ts";

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Matching key discipline: developers.email is compared lowercased too. */
export const normalizeEmail = (email: string): string =>
  email.trim().toLowerCase();

/**
 * Upserts one connector's commit-authorship reading, one row per
 * (repo, author email) — never append-only, so the table is bounded by team
 * size rather than by reporting frequency.
 *
 * `setWhere` keeps replay honest: a spool replay carries an OLDER collectedAt,
 * and overwriting a fresher row with it would move the absence check backwards
 * in time. Only a same-or-newer collection may update — and even then the
 * newest commit timestamp survives via greatest(), because a fresher scan
 * whose window slid past an old commit has not UNSEEN it.
 *
 * BOTH TIMESTAMPS ARE CLAMPED to the hub's own clock plus skew, because both
 * are sender-controlled and both mechanisms above turn a future value into a
 * ratchet: a future collectedAt makes setWhere discard every honest report
 * until the skew elapses, and a future latestCommitAt is kept by greatest()
 * forever — the wire schema bounds them only relative to EACH OTHER, so an
 * internally consistent forgery passes it. The prune below also deletes rows
 * already claiming timestamps past the ceiling: the age test alone can never
 * retire them (a future timestamp is never older than the cutoff), and such
 * rows exist wherever a pre-clamp hub stored one.
 *
 * Always "accepted", including on a no-op replay: the upsert is idempotent and
 * the distinction buys the flush loop nothing it acts on.
 *
 * No outbox event, same reasoning as targets (record-handlers.ts): every
 * SessionStart of every teammate re-reports, and per-report events would drown
 * the signals SSE consumers care about.
 */
export const ingestCommitEvidence = async (
  deps: Deps,
  developerId: string,
  body: CommitEvidence,
): Promise<HandlerOutcome> => {
  const now = deps.now();
  const retentionCutoff = new Date(
    now.getTime() - COMMIT_EVIDENCE_RETENTION_DAYS * MS_PER_DAY,
  );
  const futureCeilingMs = now.getTime() + MAX_COMMIT_CLOCK_SKEW_MS;
  const futureCeiling = new Date(futureCeilingMs);
  const collectedAt = new Date(
    Math.min(Date.parse(body.collectedAt), futureCeilingMs),
  );
  // One transaction so prune + upserts land atomically per record.
  return deps.db.transaction(async (tx) => {
    await tx
      .delete(commitEvidence)
      .where(
        and(
          eq(commitEvidence.repo, body.repo),
          or(
            lt(commitEvidence.latestCommitAt, retentionCutoff),
            gt(commitEvidence.latestCommitAt, futureCeiling),
            gt(commitEvidence.collectedAt, futureCeiling),
          ),
        ),
      );
    for (const author of body.authors) {
      await tx
        .insert(commitEvidence)
        .values({
          repo: body.repo,
          authorEmail: normalizeEmail(author.email),
          authorName: author.name,
          latestCommitAt: new Date(
            Math.min(Date.parse(author.latestCommitAt), futureCeilingMs),
          ),
          commitCount: author.commitCount,
          windowDays: body.windowDays,
          collectedAt,
          reportedBy: developerId,
        })
        .onConflictDoUpdate({
          target: [commitEvidence.repo, commitEvidence.authorEmail],
          set: {
            authorName: sql`excluded.author_name`,
            latestCommitAt: sql`greatest(${commitEvidence.latestCommitAt}, excluded.latest_commit_at)`,
            commitCount: sql`excluded.commit_count`,
            windowDays: sql`excluded.window_days`,
            collectedAt: sql`excluded.collected_at`,
            reportedBy: sql`excluded.reported_by`,
          },
          setWhere: sql`${commitEvidence.collectedAt} <= excluded.collected_at`,
        });
    }
    return { status: "accepted" };
  });
};
