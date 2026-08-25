/**
 * The asynchronous question channel (roadmap R2) — hub side.
 *
 * WHY A RECORD AND NOT A CHANNEL. Agent-to-agent conversation was cut from v1
 * deliberately (DESIGN.md §9), and a live channel would be theatre anyway:
 * Ken's agent is not running when Nick asks. So a question WAITS. It reaches
 * its target at their next SessionStart, it is answered by a claim, and the
 * answer reaches the asker at their next prompt. Nobody has to be online at
 * the same time, and nobody has to do anything except start a session.
 *
 * FOUR RULES, each borrowed from a system that learned them the hard way:
 *
 *   TARGETED, NEVER BROADCAST. The addressee is a CHECK constraint, not a
 *   convention. Jira's own guidance prefers an @mention over a watcher
 *   because it notifies exactly once; a channel that can address everybody
 *   becomes a channel everybody mutes.
 *
 *   BUDGETED. Three hub-enforced ceilings (constants.ts says why each exists).
 *   A connector cannot lift them, because the budget is what keeps the
 *   "Questions for you" block from becoming one person's megaphone.
 *
 *   EXPIRING, LAZILY. `QUESTION_TTL_DAYS`, applied on READ: every listing
 *   demands `expires_at > now()` in SQL, so a question that outlived its
 *   window cannot haunt a briefing even if no status flip ever ran. The flip
 *   itself is opportunistic and AUTHOR-SCOPED (`expireOwnQuestions`), so the
 *   asker's own counters can say "expired unanswered" without a cron job.
 *
 *   DEDUPED. An identical open question is a DUPLICATE naming the existing
 *   id, not a second row and not a rejection — the same "a record that
 *   carries nothing new is a duplicate" rule ingest applies everywhere else.
 *   GitHub now surfaces likely-duplicate issues BEFORE the submit for the
 *   same reason: the asker wanted an answer, not a second thread.
 *
 * ANSWERS ARE CLAIMS. One claim, plus the `answers` edge, written in ONE
 * transaction (`answerQuestion`) — an answer that is not attributable is a
 * comment, and Stack Overflow's whole comments-vs-answers rule is that a
 * comment cannot be accepted, cited, or found later. The claim lands on the
 * ANSWERER's own work context (`publish_claim` semantics): it is their
 * assertion, in their own tree, and the edge is what carries it to the asker.
 */
import { and, asc, desc, eq, gt, lte, sql } from "drizzle-orm";
import type { Question, QuestionAnswer } from "@crosscheck/schema";

import {
  MAX_OPEN_QUESTIONS_PER_AUTHOR,
  MAX_OPEN_QUESTIONS_PER_TARGET,
  MAX_QUESTIONS_LISTED,
  MAX_QUESTIONS_PER_AUTHOR_PER_DAY,
  MAX_QUESTION_ANSWERS_LISTED,
  QUESTION_ANSWER_WINDOW_DAYS,
  QUESTION_TTL_DAYS,
} from "../constants.ts";
import {
  agentSessions,
  claims,
  developers,
  questionAnswers,
  questions,
  workContexts,
} from "../db/schema.ts";
import { ingestClaimWithin, prepareClaimVector } from "./record-handlers.ts";
import { notMutedCondition } from "./visibility.ts";
import type { Db, DbExecutor } from "../db/client.ts";
import type { Embedder } from "./embedder.ts";
import type { Clock } from "../types.ts";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

/** Same normalization the claim dedup gate uses — one rule, two callers. */
const normalizeBody = (body: string): string =>
  body.trim().replace(/\s+/g, " ").toLowerCase();

export const questionExpiry = (createdAt: Date): Date =>
  new Date(createdAt.getTime() + QUESTION_TTL_DAYS * MS_PER_DAY);

/**
 * OPEN AND NOT YET EXPIRED, in SQL. Never `status = 'open'` alone: the flip
 * to `expired` is opportunistic, so the status column is a cache of this
 * expression and a read that trusted the cache could serve a fortnight-old
 * question into somebody's briefing.
 */
const isLive = (now: Date) =>
  and(eq(questions.status, "open"), gt(questions.expiresAt, now));

export interface QuestionRow {
  readonly id: string;
  readonly repo: string;
  readonly authorDeveloperId: string;
  readonly targetDeveloperId: string | null;
  readonly workContextId: string | null;
  readonly body: string;
  readonly status: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export type AskOutcome =
  | { readonly outcome: "asked"; readonly question: QuestionRow }
  | { readonly outcome: "duplicate"; readonly questionId: string }
  | { readonly outcome: "budget"; readonly reason: string }
  | { readonly outcome: "invalid"; readonly reason: string };

const toRow = (row: typeof questions.$inferSelect): QuestionRow => ({
  id: row.id,
  repo: row.repo,
  authorDeveloperId: row.authorDeveloperId,
  targetDeveloperId: row.targetDeveloperId,
  workContextId: row.workContextId,
  body: row.body,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
  expiresAt: row.expiresAt.toISOString(),
});

const resolveContextOwner = async (
  db: DbExecutor,
  workContextId: string,
): Promise<string | undefined> => {
  const rows = await db
    .select({ developerId: agentSessions.developerId })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(eq(workContexts.id, workContextId))
    .limit(1);
  return rows[0]?.developerId;
};

/**
 * The budget probes, over the author's own live questions. Bounded by
 * construction: the open list is at most MAX_OPEN_QUESTIONS_PER_AUTHOR + 1
 * rows, and the day probe counts rather than reads.
 */
const checkBudgets = async (
  db: DbExecutor,
  now: Date,
  authorDeveloperId: string,
  targetDeveloperId: string,
): Promise<string | null> => {
  const dayAgo = new Date(now.getTime() - MS_PER_DAY);
  const asked = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(questions)
    .where(
      and(
        eq(questions.authorDeveloperId, authorDeveloperId),
        gt(questions.createdAt, dayAgo),
      ),
    );
  if ((asked[0]?.count ?? 0) >= MAX_QUESTIONS_PER_AUTHOR_PER_DAY) {
    return (
      `you have asked ${String(MAX_QUESTIONS_PER_AUTHOR_PER_DAY)} questions in the last 24 hours, ` +
      "which is the daily limit — wait for some to be answered before asking more."
    );
  }
  const open = await db
    .select({ targetDeveloperId: questions.targetDeveloperId })
    .from(questions)
    .where(and(eq(questions.authorDeveloperId, authorDeveloperId), isLive(now)))
    .limit(MAX_OPEN_QUESTIONS_PER_AUTHOR + 1);
  if (open.length >= MAX_OPEN_QUESTIONS_PER_AUTHOR) {
    return (
      `you already have ${String(open.length)} questions open and the limit is ` +
      `${String(MAX_OPEN_QUESTIONS_PER_AUTHOR)} — answers arrive on their own, and an unanswered ` +
      "backlog is what makes a question channel ignorable."
    );
  }
  const toTarget = open.filter(
    (row) => row.targetDeveloperId === targetDeveloperId,
  ).length;
  if (toTarget >= MAX_OPEN_QUESTIONS_PER_TARGET) {
    return (
      `you already have ${String(toTarget)} questions open to that teammate and the limit is ` +
      `${String(MAX_OPEN_QUESTIONS_PER_TARGET)} — their briefing shows a bounded block, so more ` +
      "would only push your own earlier questions out of it."
    );
  }
  return null;
};

const findOpenDuplicate = async (
  db: DbExecutor,
  now: Date,
  authorDeveloperId: string,
  targetDeveloperId: string,
  workContextId: string | null,
  body: string,
): Promise<string | undefined> => {
  const candidates = await db
    .select({
      id: questions.id,
      body: questions.body,
      workContextId: questions.workContextId,
    })
    .from(questions)
    .where(
      and(
        eq(questions.authorDeveloperId, authorDeveloperId),
        eq(questions.targetDeveloperId, targetDeveloperId),
        isLive(now),
      ),
    )
    .limit(MAX_OPEN_QUESTIONS_PER_AUTHOR + 1);
  const normalized = normalizeBody(body);
  return candidates.find(
    (candidate) =>
      candidate.workContextId === workContextId &&
      normalizeBody(candidate.body) === normalized,
  )?.id;
};

export interface AskQuestionInput {
  readonly id: string;
  readonly repo: string;
  readonly authorSessionId: string;
  readonly targetDeveloperId?: string | undefined;
  readonly workContextId?: string | undefined;
  readonly body: string;
  readonly createdAt: Date;
}

/**
 * The ONE write path for a question, shared by `POST /api/questions` (the
 * tool, which resolves a developer NAME first) and by the `question` record
 * kind (spool replay). Two entry points, one set of rules.
 *
 * THE ADDRESSEE IS ALWAYS A PERSON in the end: a question naming only a work
 * context is filed against that context's owner, because only a person can
 * answer one. The context id is kept beside it — it is what the briefing line
 * says the question is ABOUT.
 */
export const askQuestion = async (
  deps: Deps,
  authorDeveloperId: string,
  input: AskQuestionInput,
): Promise<AskOutcome> => {
  const now = deps.now();
  return deps.db.transaction(async (tx) => {
    const contextOwner =
      input.workContextId === undefined
        ? undefined
        : await resolveContextOwner(tx, input.workContextId);
    if (input.workContextId !== undefined && contextOwner === undefined) {
      return {
        outcome: "invalid" as const,
        reason: `work context "${input.workContextId}" not found`,
      };
    }
    const targetDeveloperId = input.targetDeveloperId ?? contextOwner;
    if (targetDeveloperId === undefined) {
      return {
        outcome: "invalid" as const,
        reason:
          "a question needs an addressee: name a teammate, a work context, or both",
      };
    }
    if (targetDeveloperId === authorDeveloperId) {
      return {
        outcome: "invalid" as const,
        reason:
          "that question would be addressed to you — ask a teammate, or publish what you know as a claim",
      };
    }
    const targetRows = await tx
      .select({ id: developers.id })
      .from(developers)
      .where(eq(developers.id, targetDeveloperId))
      .limit(1);
    if (targetRows[0] === undefined) {
      return {
        outcome: "invalid" as const,
        reason: `developer "${targetDeveloperId}" not found`,
      };
    }
    const duplicateId = await findOpenDuplicate(
      tx,
      now,
      authorDeveloperId,
      targetDeveloperId,
      input.workContextId ?? null,
      input.body,
    );
    if (duplicateId !== undefined) {
      return { outcome: "duplicate" as const, questionId: duplicateId };
    }
    const budgetIssue = await checkBudgets(
      tx,
      now,
      authorDeveloperId,
      targetDeveloperId,
    );
    if (budgetIssue !== null) {
      return { outcome: "budget" as const, reason: budgetIssue };
    }
    // status and expires_at are the HUB's, whatever the record carried: a
    // client that could set either could file a question that is born
    // answered or never expires.
    const inserted = await tx
      .insert(questions)
      .values({
        id: input.id,
        repo: input.repo,
        authorDeveloperId,
        authorSessionId: input.authorSessionId,
        targetDeveloperId,
        workContextId: input.workContextId ?? null,
        body: input.body,
        status: "open",
        createdAt: input.createdAt,
        expiresAt: questionExpiry(input.createdAt),
      })
      .onConflictDoNothing()
      .returning();
    const row = inserted[0];
    if (row === undefined) {
      // The id is already stored — a spool replay of a question this hub
      // accepted before. Nothing new, so: duplicate, not a rejection.
      return { outcome: "duplicate" as const, questionId: input.id };
    }
    return { outcome: "asked" as const, question: toRow(row) };
  });
};

/**
 * The record-kind entry point: the wire body, minus what the hub owns.
 *
 * `createdAt` IS ONE OF THOSE, and it is the third hub-owned field rather
 * than the first two plus a trusted timestamp. It decides `expires_at`
 * (createdAt + QUESTION_TTL_DAYS), which the two open budgets and every
 * listing read through `isLive`, AND the rolling window the day-rate probe
 * counts in — so a caller who owned it owned the TTL and all three budgets at
 * once: a question dated 2099 never expires and outranks every honest one
 * (`created_at DESC`), and a question backdated past the TTL is invisible to
 * the open budgets, to the day probe and to the dedup scan, which is 60 of 60
 * accepted. The wire value is therefore dropped, exactly like `status` and
 * `expiresAt`.
 *
 * WHAT IT COSTS: a question spooled offline and flushed later is dated at the
 * flush, not at the ask. That is the honest direction to be wrong in — the
 * TTL then runs from the moment the hub could first show it to anybody — and
 * it costs nothing today, because no connector produces this record kind
 * (the tool posts to /api/questions, which already stamps `deps.now()`).
 */
export const askQuestionFromRecord = (
  deps: Deps,
  authorDeveloperId: string,
  body: Question,
): Promise<AskOutcome> =>
  askQuestion(deps, authorDeveloperId, {
    id: body.id,
    repo: body.repo,
    authorSessionId: body.authorSessionId,
    targetDeveloperId: body.targetDeveloperId,
    workContextId: body.workContextId,
    body: body.body,
    createdAt: deps.now(),
  });

/**
 * ONE SENTENCE FOR "not yours" AND "no such question", and that is the
 * point: a question body is another developer's text, and an answerer who
 * could tell a wrong id from a foreign one could enumerate the hub's
 * questions by probing ids. The sentence therefore says what the caller may
 * do, never what exists.
 */
export const ANSWER_NOT_ADDRESSED =
  "no open question with that id is addressed to you. A question is answerable by " +
  "the teammate it names or the owner of the context it is about — " +
  "list_open_questions shows the ones you can answer.";

/**
 * DERIVED STAYS POINTER-ONLY, and this is the surface where that rule and the
 * §4 solicited exception meet. A Tier-1 draft is `provenance: derived`,
 * confidence capped at 0.5, and DESIGN §3 says such a claim is NEVER
 * proactively injected to a teammate — only surfaced as a pull-able pointer.
 * An answer is proactively injected, as SUBSTANCE, into the asker's next
 * prompt. So an answer must be something a person or their agent DECLARED.
 *
 * It costs nothing today: `answer_question` only ever sends `declared`. The
 * gate exists because the hub is the only place that can hold the line — the
 * declared-only gate on the unsolicited path runs client side (hints/select.ts),
 * and the answer path bypasses that selector entirely.
 */
export const ANSWER_NOT_DECLARED =
  "an answer is delivered to the asker as substance, so it cannot be a derived " +
  "draft — promote it with review_draft first, or answer in your own words.";

export type AnswerOutcome =
  | {
      readonly outcome: "answered";
      readonly questionId: string;
      readonly claimId: string;
    }
  | { readonly outcome: "duplicate"; readonly claimId: string }
  | { readonly outcome: "refused"; readonly reason: string };

/**
 * Who may answer: the named target, or the owner of the work context the
 * question is about. Checked against the LIVE row inside the transaction —
 * an expired or already-withdrawn question is not answerable, and says so
 * (the caller is the target, so the expiry is not a leak to them).
 */
const findAnswerableQuestion = async (
  db: DbExecutor,
  now: Date,
  developerId: string,
  questionId: string,
): Promise<
  | { readonly ok: true; readonly row: typeof questions.$inferSelect }
  | { readonly ok: false; readonly reason: string }
> => {
  const rows = await db
    .select({ question: questions, contextOwnerId: agentSessions.developerId })
    .from(questions)
    .leftJoin(workContexts, eq(questions.workContextId, workContexts.id))
    .leftJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(eq(questions.id, questionId))
    .limit(1);
  const found = rows[0];
  if (found === undefined) {
    return { ok: false, reason: ANSWER_NOT_ADDRESSED };
  }
  const mayAnswer =
    found.question.targetDeveloperId === developerId ||
    found.contextOwnerId === developerId;
  if (!mayAnswer) {
    return { ok: false, reason: ANSWER_NOT_ADDRESSED };
  }
  if (found.question.status === "withdrawn") {
    return { ok: false, reason: "that question was withdrawn by the asker." };
  }
  if (found.question.expiresAt <= now || found.question.status === "expired") {
    return {
      ok: false,
      reason:
        `that question expired after ${String(QUESTION_TTL_DAYS)} days without an answer, so the ` +
        "asker is no longer waiting on it. Publish what you know as a claim instead.",
    };
  }
  return { ok: true, row: found.question };
};

export interface AnswerQuestionDeps extends Deps {
  /** Optional, exactly like the claim path's: absent = keyless install. */
  readonly embedder?: Embedder | null;
}

/**
 * Claim AND edge in ONE transaction (the R2 requirement): a crash between
 * them would leave either a claim the question cannot reach or an edge
 * pointing at a claim that was never accepted.
 *
 * The FIRST answer flips the question to `answered`; later answers still
 * attach. GitHub Discussions does exactly this — marking one reply as the
 * answer does not silence the rest, and the later reply is often the
 * correction.
 */
export const answerQuestion = async (
  deps: AnswerQuestionDeps,
  developerId: string,
  body: QuestionAnswer,
): Promise<AnswerOutcome> => {
  const now = deps.now();
  // Outside the transaction, like every claim write: the embedding is an
  // external HTTP call and must never hold single-connection PGlite open.
  const claimVector = await prepareClaimVector(deps, developerId, body.claim);
  return deps.db.transaction(async (tx) => {
    const found = await findAnswerableQuestion(
      tx,
      now,
      developerId,
      body.questionId,
    );
    if (!found.ok) {
      return { outcome: "refused" as const, reason: found.reason };
    }
    if (body.claim.provenance !== "declared") {
      return { outcome: "refused" as const, reason: ANSWER_NOT_DECLARED };
    }
    // The SAME gate a published claim passes (record-handlers.ts): ownership
    // of the author session, the context must exist, dedup, similarity.
    const claimOutcome = await ingestClaimWithin(
      tx,
      deps,
      developerId,
      body.claim,
      claimVector,
    );
    if (claimOutcome.status === "rejected") {
      // The claim gate's own words, forwarded: "work context not found" and
      // "session belongs to another developer" are different mistakes and a
      // single sentence for both would send the caller to the wrong fix.
      return {
        outcome: "refused" as const,
        reason: `the answer's claim was refused: ${(claimOutcome.issues ?? []).join("; ")}`,
      };
    }
    const claimId = claimOutcome.id ?? body.claim.id;
    const edge = await tx
      .insert(questionAnswers)
      .values({
        questionId: body.questionId,
        claimId,
        answererDeveloperId: developerId,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ claimId: questionAnswers.claimId });
    if (edge[0] === undefined) {
      // This exact claim already answers this exact question: a spool replay.
      return { outcome: "duplicate" as const, claimId };
    }
    if (found.row.status === "open") {
      await tx
        .update(questions)
        .set({ status: "answered" })
        .where(eq(questions.id, body.questionId));
    }
    return {
      outcome: "answered" as const,
      questionId: body.questionId,
      claimId,
    };
  });
};

export interface InboxQuestion {
  readonly id: string;
  readonly authorDeveloperId: string;
  readonly authorDeveloperName: string;
  readonly body: string;
  readonly workContextId: string | null;
  readonly workContextTitle: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface AnsweredQuestion {
  readonly questionId: string;
  readonly questionBody: string;
  readonly claimId: string;
  readonly claimBody: string;
  readonly claimKind: string;
  readonly claimStatus: string;
  readonly confidence: number;
  readonly provenance: string;
  readonly answererDeveloperName: string;
  readonly answeredAt: string;
}

export interface QuestionCounts {
  readonly openToMe: number;
  /** ISO of the OLDEST open question addressed to me; null when there are none. */
  readonly oldestToMeAt: string | null;
  /**
   * WHO asked that oldest one. The doctor's most important sentence is "a
   * teammate has been waiting 9d", and a reader with four teammates cannot
   * act on it without the name — the cheapest action, sending Ada one line,
   * is not available from a sentence that will not say it is Ada. The name is
   * already on the wire beside every inbox row; only the counters dropped it.
   */
  readonly oldestToMeFrom: string | null;
  readonly asked: number;
  readonly askedAnswered: number;
  readonly askedExpired: number;
}

export interface QuestionsView {
  readonly inbox: readonly InboxQuestion[];
  readonly answers: readonly AnsweredQuestion[];
  readonly counts: QuestionCounts;
}

/**
 * The lazy TTL flip, AUTHOR-SCOPED. It runs on the asker's own read and
 * touches only their own rows, so a GET never writes on another developer's
 * behalf, and the write is bounded by the per-author open budget.
 *
 * Reads do not depend on it — every listing carries `expires_at > now()`
 * anyway (`isLive`). What it buys is an honest COUNTER: "2 of your questions
 * expired unanswered" is a fact `doctor` can warn on, and a status column
 * that silently stayed `open` for ever could never produce it.
 */
export const expireOwnQuestions = async (
  deps: Deps,
  authorDeveloperId: string,
): Promise<number> => {
  const now = deps.now();
  const expired = await deps.db
    .update(questions)
    .set({ status: "expired" })
    .where(
      and(
        eq(questions.authorDeveloperId, authorDeveloperId),
        eq(questions.status, "open"),
        lte(questions.expiresAt, now),
      ),
    )
    .returning({ id: questions.id });
  return expired.length;
};

/**
 * MUTE, and the one place this channel has to decide what it means
 * (DESIGN.md §2.1). A mute is reader-side and covers the reader's UNASKED
 * surfaces; it has never been a boundary. The briefing block is unasked, so
 * a muted asker's question is filtered out of it — IN THE WHERE, before the
 * bound, so a muted developer's questions cannot crowd an includable one out
 * of MAX_QUESTIONS_LISTED. `list_open_questions` is a deliberate pull and
 * passes `excludeMuted: false`, exactly as a muted teammate's tree stays
 * readable through `get_diagnosis`.
 *
 * The ASKER is never told. Their question is simply not answered, and
 * `doctor` eventually tells them it expired — without saying why, because a
 * mute a sender can detect is a mute nobody would set.
 */
/**
 * THE inbox predicate, extracted so the rows and the COUNTERS can never
 * describe two different sets. The counters are computed over this same
 * expression in SQL rather than over the returned page (below), which is the
 * defect this extraction exists to make impossible.
 */
const inboxCondition = (
  now: Date,
  developerId: string,
  repo: string,
  excludeMuted: boolean,
) =>
  and(
    eq(questions.targetDeveloperId, developerId),
    eq(questions.repo, repo),
    isLive(now),
    ...(excludeMuted
      ? [notMutedCondition(developerId, questions.authorDeveloperId)]
      : []),
  );

const listInbox = async (
  deps: Deps,
  developerId: string,
  repo: string,
  excludeMuted: boolean,
): Promise<readonly InboxQuestion[]> => {
  const rows = await deps.db
    .select({
      question: questions,
      authorDeveloperName: developers.name,
      workContextTitle: workContexts.title,
    })
    .from(questions)
    .innerJoin(developers, eq(questions.authorDeveloperId, developers.id))
    .leftJoin(workContexts, eq(questions.workContextId, workContexts.id))
    .where(inboxCondition(deps.now(), developerId, repo, excludeMuted))
    .orderBy(desc(questions.createdAt))
    .limit(MAX_QUESTIONS_LISTED);
  return rows.map((row) => ({
    id: row.question.id,
    authorDeveloperId: row.question.authorDeveloperId,
    authorDeveloperName: row.authorDeveloperName,
    body: row.question.body,
    workContextId: row.question.workContextId,
    workContextTitle: row.workContextTitle,
    createdAt: row.question.createdAt.toISOString(),
    expiresAt: row.question.expiresAt.toISOString(),
  }));
};

/**
 * The BACKLOG, in SQL, over the identical predicate `listInbox` pages through.
 *
 * WHY NOT `inbox.length`. The rows are bounded by MAX_QUESTIONS_LISTED and
 * ordered NEWEST FIRST, so deriving the counters from them caps the count at
 * the listing bound and — worse — makes the oldest question the FIRST thing
 * dropped. Seven teammates each holding their per-target allowance is 21 open
 * questions on a ten-person team, at which point the status line under-counts
 * and the doctor's "a teammate has been waiting" WARN can never fire again,
 * however long anybody waits. The one number this channel exists to make
 * visible would be the one that goes stale first.
 *
 * Two bounded reads on `questions_target_status_created_idx`: a count, and
 * the single oldest row (with its author, for the sentence the doctor
 * prints). Both run beside the listing in the same Promise.all.
 */
const summarizeInbox = async (
  deps: Deps,
  developerId: string,
  repo: string,
): Promise<
  Pick<QuestionCounts, "openToMe" | "oldestToMeAt" | "oldestToMeFrom">
> => {
  const where = inboxCondition(deps.now(), developerId, repo, true);
  const [totals, oldest] = await Promise.all([
    deps.db
      .select({ count: sql<number>`count(*)::int` })
      .from(questions)
      .innerJoin(developers, eq(questions.authorDeveloperId, developers.id))
      .where(where),
    deps.db
      .select({
        createdAt: questions.createdAt,
        authorDeveloperName: developers.name,
      })
      .from(questions)
      .innerJoin(developers, eq(questions.authorDeveloperId, developers.id))
      .where(where)
      .orderBy(asc(questions.createdAt))
      .limit(1),
  ]);
  const oldestRow = oldest[0];
  return {
    openToMe: totals[0]?.count ?? 0,
    oldestToMeAt: oldestRow?.createdAt.toISOString() ?? null,
    oldestToMeFrom: oldestRow?.authorDeveloperName ?? null,
  };
};

/**
 * Answers to MY questions that no session of mine has been handed yet.
 *
 * THE EXCLUSION IS THE "exactly once" PROMISE, and it is hub-side on purpose:
 * the connector's seen-set lives in session state and dies with the session,
 * so a second session would re-deliver the same answer for ever.
 * `hint_deliveries` is the durable store — one row per (session, ref) — and
 * the probe asks whether ANY session of this developer already carries this
 * claim id. Indexed by hint_deliveries_ref_session_idx.
 *
 * SCOPED TO THE REPO THE QUESTION WAS ASKED FROM, like the inbox beside it.
 * An answer is the one thing the prompt path may inject as SUBSTANCE (the §4
 * solicited exception), and that exception rests on the reader already
 * holding the frame it lands in — which is false when the frame is a
 * different codebase and a different problem, possibly days later. So a
 * cross-repo answer waits until its asker next works in the repo they asked
 * from, which is also the only place it is legible.
 *
 * AND BOUNDED IN TIME, because a LIMIT is not a bound when the sort runs over
 * everything first. The `.limit(3)` here is applied AFTER the join and the
 * anti-join, so without a window the probe reads every question this
 * developer ever asked on every prompt — 25 ms at a year of use, measured,
 * and growing. QUESTION_ANSWER_WINDOW_DAYS caps the outer set by the asker's
 * OWN day budget instead of by the age of their account.
 */
export const listUndeliveredAnswers = async (
  deps: Deps,
  developerId: string,
  repo: string,
): Promise<readonly AnsweredQuestion[]> => {
  const answerWindowStart = new Date(
    deps.now().getTime() - QUESTION_ANSWER_WINDOW_DAYS * MS_PER_DAY,
  );
  const rows = await deps.db
    .select({
      questionId: questionAnswers.questionId,
      questionBody: questions.body,
      claim: claims,
      answererDeveloperName: developers.name,
      answeredAt: questionAnswers.createdAt,
    })
    .from(questionAnswers)
    .innerJoin(questions, eq(questionAnswers.questionId, questions.id))
    .innerJoin(claims, eq(questionAnswers.claimId, claims.id))
    .innerJoin(
      developers,
      eq(questionAnswers.answererDeveloperId, developers.id),
    )
    .where(
      and(
        eq(questions.authorDeveloperId, developerId),
        eq(questions.repo, repo),
        gt(questions.createdAt, answerWindowStart),
        sql`NOT EXISTS (
          SELECT 1 FROM hint_deliveries delivered
          JOIN agent_sessions reader ON reader.id = delivered.session_id
          WHERE delivered.ref_id = ${questionAnswers.claimId}
            AND reader.developer_id = ${developerId}
        )`,
      ),
    )
    .orderBy(desc(questionAnswers.createdAt))
    .limit(MAX_QUESTION_ANSWERS_LISTED);
  return rows.map((row) => ({
    questionId: row.questionId,
    questionBody: row.questionBody,
    claimId: row.claim.id,
    claimBody: row.claim.body,
    claimKind: row.claim.kind,
    claimStatus: row.claim.status,
    confidence: row.claim.confidence,
    provenance: row.claim.provenance,
    answererDeveloperName: row.answererDeveloperName,
    answeredAt: row.answeredAt.toISOString(),
  }));
};

/**
 * The ASKER's side of the same sentence — and it is one sentence, so these
 * numbers have to describe the same scope the inbox half does.
 *
 * SCOPED TO THE REPO, like the inbox. Without it `crosscheck status` inside
 * one repo answers with hub-wide totals ("3 asked") beside a repo-scoped
 * "none open to you", and the reader goes looking for two questions that were
 * never asked here.
 *
 * THE EXPIRED COUNT IS WINDOWED to one further TTL past the expiry. Nothing
 * can clear an expired row — `withdrawn` is unreachable, there is no reaper —
 * so an unwindowed count makes `doctor` WARN and exit 1 for ever over one
 * question nobody answered last spring, which is precisely the alert fatigue
 * that makes people stop reading doctor. Reported for a fortnight, then
 * silent; the wording says the window out loud.
 */
const countOwnQuestions = async (
  deps: Deps,
  developerId: string,
  repo: string,
): Promise<Pick<QuestionCounts, "asked" | "askedAnswered" | "askedExpired">> => {
  const expiredSince = new Date(
    deps.now().getTime() - QUESTION_TTL_DAYS * MS_PER_DAY,
  );
  const rows = await deps.db
    .select({
      asked: sql<number>`count(*)::int`,
      askedAnswered: sql<number>`(count(*) filter (where ${questions.status} = 'answered'))::int`,
      askedExpired: sql<number>`(count(*) filter (where ${questions.status} = 'expired' and ${questions.expiresAt} > ${expiredSince}))::int`,
    })
    .from(questions)
    .where(
      and(
        eq(questions.authorDeveloperId, developerId),
        eq(questions.repo, repo),
      ),
    );
  const row = rows[0];
  return {
    asked: row?.asked ?? 0,
    askedAnswered: row?.askedAnswered ?? 0,
    askedExpired: row?.askedExpired ?? 0,
  };
};

/**
 * Everything both sides of the channel need, in ONE bounded round trip: what
 * was asked of me (the briefing's "Questions for you"), what came back on my
 * own questions, and the counters `crosscheck status` and `doctor` print.
 */
export const listQuestions = async (
  deps: Deps,
  developerId: string,
  repo: string,
): Promise<QuestionsView> => {
  // The asker's own expired rows are flipped first, so the counters below and
  // the doctor's "expired unanswered" warning read the same table state.
  await expireOwnQuestions(deps, developerId);
  const [inbox, answers, backlog, ownCounts] = await Promise.all([
    // The BRIEFING's read: muted askers filtered, because the briefing is an
    // unasked surface. An ANSWER below is deliberately NOT filtered — it is
    // solicited, and hiding the answer to a question this developer asked
    // would be absurd whatever they think of the answerer.
    listInbox(deps, developerId, repo, true),
    listUndeliveredAnswers(deps, developerId, repo),
    // The counters come from SQL over the same predicate, NEVER from the page
    // above — see summarizeInbox for what deriving them from a bounded,
    // newest-first listing costs.
    summarizeInbox(deps, developerId, repo),
    countOwnQuestions(deps, developerId, repo),
  ]);
  return { inbox, answers, counts: { ...backlog, ...ownCounts } };
};

/**
 * Questions a caller may answer — the `list_open_questions` tool's read, and
 * a deliberate PULL: no mute filter, for the same reason `get_diagnosis` has
 * none. A mute is a preference about what arrives unasked.
 */
export const listAnswerableQuestions = (
  deps: Deps,
  developerId: string,
  repo: string,
): Promise<readonly InboxQuestion[]> =>
  listInbox(deps, developerId, repo, false);
