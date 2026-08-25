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
import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { Question, QuestionAnswer } from "@crosscheck/schema";

import {
  MAX_OPEN_QUESTIONS_PER_AUTHOR,
  MAX_OPEN_QUESTIONS_PER_TARGET,
  MAX_QUESTIONS_LISTED,
  MAX_QUESTIONS_PER_AUTHOR_PER_DAY,
  MAX_QUESTION_ANSWERS_LISTED,
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

/** The record-kind entry point: the wire body, minus what the hub owns. */
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
    createdAt: new Date(body.createdAt),
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
    .where(
      and(
        eq(questions.targetDeveloperId, developerId),
        eq(questions.repo, repo),
        isLive(deps.now()),
        ...(excludeMuted
          ? [notMutedCondition(developerId, questions.authorDeveloperId)]
          : []),
      ),
    )
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
 * Answers to MY questions that no session of mine has been handed yet.
 *
 * THE EXCLUSION IS THE "exactly once" PROMISE, and it is hub-side on purpose:
 * the connector's seen-set lives in session state and dies with the session,
 * so a second session would re-deliver the same answer for ever.
 * `hint_deliveries` is the durable store — one row per (session, ref) — and
 * the probe asks whether ANY session of this developer already carries this
 * claim id. Indexed by hint_deliveries_ref_session_idx.
 */
export const listUndeliveredAnswers = async (
  deps: Deps,
  developerId: string,
): Promise<readonly AnsweredQuestion[]> => {
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

const countOwnQuestions = async (
  deps: Deps,
  developerId: string,
): Promise<Pick<QuestionCounts, "asked" | "askedAnswered" | "askedExpired">> => {
  const rows = await deps.db
    .select({ status: questions.status, count: sql<number>`count(*)::int` })
    .from(questions)
    .where(eq(questions.authorDeveloperId, developerId))
    .groupBy(questions.status);
  const of = (status: string): number =>
    rows.find((row) => row.status === status)?.count ?? 0;
  return {
    asked: rows.reduce((total, row) => total + row.count, 0),
    askedAnswered: of("answered"),
    askedExpired: of("expired"),
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
  const [inbox, answers, ownCounts] = await Promise.all([
    // The BRIEFING's read: muted askers filtered, because the briefing is an
    // unasked surface. An ANSWER below is deliberately NOT filtered — it is
    // solicited, and hiding the answer to a question this developer asked
    // would be absurd whatever they think of the answerer.
    listInbox(deps, developerId, repo, true),
    listUndeliveredAnswers(deps, developerId),
    countOwnQuestions(deps, developerId),
  ]);
  const oldest = inbox.reduce<string | null>(
    (oldestAt, question) =>
      oldestAt === null || question.createdAt < oldestAt
        ? question.createdAt
        : oldestAt,
    null,
  );
  return {
    inbox,
    answers,
    counts: { openToMe: inbox.length, oldestToMeAt: oldest, ...ownCounts },
  };
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

/** Raw rows by id — the scale probe and the tests that assert stored state. */
export const readQuestionRows = async (
  deps: Deps,
  ids: readonly string[],
): Promise<readonly QuestionRow[]> => {
  if (ids.length === 0) {
    return [];
  }
  const rows = await deps.db
    .select()
    .from(questions)
    .where(inArray(questions.id, ids))
    .limit(ids.length);
  return rows.map(toRow);
};
