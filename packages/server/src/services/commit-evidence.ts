import { and, eq, gt, lt, or, sql } from "drizzle-orm";
import { MAX_COMMIT_CLOCK_SKEW_MS } from "@crosscheck/schema";
import type { CommitEvidence } from "@crosscheck/schema";

import type { SeqField } from "@crosscheck/schema";

import { COMMIT_EVIDENCE_RETENTION_DAYS } from "../constants.ts";
import { commitEvidence } from "../db/schema.ts";
import { recordSessionEvent } from "./session-events.ts";
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
  seq?: SeqField,
  producerSessionId?: string,
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
    // `commit.observed` — the ONE canonical event whose session cannot come
    // from a body or a join. The aggregate's own key is (repo, author_email),
    // and author_email NEVER LEAVES THE HUB: hashing it would make the
    // referent a content-derived pseudonymous identifier of a person, which
    // data minimisation forbids outright. So the event refs the SESSION whose
    // SessionStart ran the collection, which is all a position can honestly
    // assert about an aggregate — that a collection happened, here in the
    // order.
    //
    // That session is the PRODUCER, and a producer is rewritten by whichever
    // session drains the spool. `withProducer` therefore strips the position
    // from exactly this class of record when it rewrites one, so a foreign
    // drain arrives unsequenced instead of filing A's position under B.
    //
    // `observed`, NOT `emitted` — SessionStart's collection is spec 01 §3.6's
    // third producer of an upper bound, beside the git_diff lane and the
    // detached workers. The position is allocated when the aggregate is
    // WRITTEN DOWN, and what it describes is older: commits authored up to
    // COMMIT_EVIDENCE_WINDOW_DAYS before the session existed. §3.6's own
    // sentence about the workers is the argument verbatim — "the position it
    // allocates records when the row was written, not when the fact it
    // describes was seen".
    //
    // WHY THE "IT ONLY ASSERTS THAT A COLLECTION HAPPENED" READING DOES NOT
    // SURVIVE. A SessionStart RE-FIRE collects the SAME aggregate again, so
    // one set of commits holds two positions in one usable epoch; measured on
    // the hub's own readers, a claim between them was answered +1 against the
    // first row and -1 against the second. -1 is `predeclared` — the value
    // that CLEARS the agent — about commits authored days before the session
    // opened. An upper bound makes both of those a refusal, which is the
    // answer an aggregate of older facts can honestly support.
    if (producerSessionId !== undefined) {
      await recordSessionEvent(
        { db: tx, now: deps.now },
        {
          sessionId: producerSessionId,
          kind: "commit.observed",
          seq,
          seqKind: "observed",
          refKind: "session",
          refId: producerSessionId,
        },
      );
    }
    return { status: "accepted" };
  });
};
