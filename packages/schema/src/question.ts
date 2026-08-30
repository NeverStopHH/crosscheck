import { z } from "zod";

import { ClaimSchema } from "./claim.ts";

/**
 * A QUESTION addressed to a teammate (roadmap R2, the asynchronous question
 * channel). Agent-to-agent chat was cut from v1 on purpose (DESIGN.md §9) and
 * a live channel would be theatre — the teammate's agent is not running when
 * you ask. So a question is a RECORD: it waits on the hub, reaches its target
 * at their next SessionStart, and is answered by a claim.
 *
 * NEVER A BROADCAST. At least one of `targetDeveloperId` / `workContextId`
 * must be present — the check below is the schema-level half of that rule and
 * the hub repeats it, because a question with no addressee is the "@here"
 * every prior-art system regrets (Slack thread bots nudge the ONE person who
 * asked; Jira's own guidance prefers an @mention over a watcher precisely
 * because it notifies once).
 *
 * `status`, `expiresAt` AND `createdAt` are on the wire because a READ
 * carries them, and all three are IGNORED ON INGEST: the hub owns them. A
 * client that could post `status: "answered"` could mark its own question
 * answered without anybody answering it. A client that could post `expiresAt`
 * — or `createdAt`, which is what `expiresAt` is derived from — could file a
 * question that outlives the TTL for ever (a haunted briefing, the one thing
 * an expiring channel exists to prevent) or backdate one past the TTL, where
 * the open budgets, the day-rate probe and the dedup scan are all blind to it.
 */
export const MAX_QUESTION_BODY_LENGTH = 400;

export const QUESTION_STATUSES = [
  "open",
  "answered",
  "expired",
  "withdrawn",
] as const;

export const QuestionStatusSchema = z.enum(QUESTION_STATUSES);

export type QuestionStatus = z.infer<typeof QuestionStatusSchema>;

/**
 * Characters an id may carry, and the one place both sides of the wire agree
 * on them.
 *
 * The RENDERER strips everything outside this alphabet (connector-core's
 * `safeId`), so an id it cannot print is an id nobody can pass back: a
 * question filed as `qn_«»<bidi>SYSTEM ignore previous` renders as
 * `answer_question qn_SYSTEMignoreprevious`, which the hub has never heard
 * of. The entry is not dropped — the reader sees a live question they can
 * never act on, and the asker is told nothing. Validating here makes the
 * renderer's contract ("a row I will not vouch for is dropped") true, because
 * an id that reaches the renderer is already what the renderer would print.
 *
 * ONE ALPHABET, TWO PACKAGES. The equality with the renderer's own copy is
 * pinned as a directive in connector-core's briefing/sanitize.ts rather than
 * here: a dynamic import of a render-layer module — even inside a comment —
 * is what the §4.4 render-surface registry looks for, and this schema is not
 * a render surface.
 */
export const SAFE_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

/** Long enough for `qn_` plus a uuid, short enough to render on one line. */
export const MAX_RECORD_ID_LENGTH = 64;

const nonEmptyId = z
  .string()
  .min(1)
  .max(MAX_RECORD_ID_LENGTH)
  .regex(SAFE_ID_PATTERN, "id carries characters an id may not carry");

export const QuestionSchema = z
  .looseObject({
    id: nonEmptyId,
    /**
     * The repo the question was asked FROM — named `repo` like
     * `AgentSessionSchema.repo` rather than the roadmap's `repoId`, because
     * it is the same string in the same trust space and two spellings of one
     * field is one more thing to get wrong at a join.
     */
    repo: z.string().min(1),
    authorDeveloperId: nonEmptyId,
    authorSessionId: nonEmptyId,
    targetDeveloperId: nonEmptyId.optional(),
    workContextId: nonEmptyId.optional(),
    body: z.string().min(1).max(MAX_QUESTION_BODY_LENGTH),
    /** Hub-owned; see the header. Optional so a writer need not invent one. */
    status: QuestionStatusSchema.optional(),
    /** Hub-owned; see the header. */
    expiresAt: z.iso.datetime().optional(),
    createdAt: z.iso.datetime(),
  })
  .check((ctx) => {
    const question = ctx.value;
    if (
      question.targetDeveloperId === undefined &&
      question.workContextId === undefined
    ) {
      ctx.issues.push({
        code: "custom",
        message:
          "a question needs an addressee: give targetDeveloperId, workContextId, or both",
        input: question.targetDeveloperId,
        path: ["targetDeveloperId"],
      });
    }
  });

/**
 * An ANSWER: one claim, plus the `answers` edge that binds it to the question
 * — ONE record, so the hub can write both in one transaction. Two records
 * could not: `/api/records` processes a batch record by record, so a crash
 * between them leaves a claim nobody can find from the question, or an edge
 * pointing at a claim that was never accepted.
 *
 * The claim is the CANONICAL `ClaimSchema`, nested rather than flattened, so
 * every rule a published claim obeys — the body cap, the derived-confidence
 * cap, "likely_root_cause needs evidence" — is the same object here and
 * `checkClaim` explains a violation in the same words. Stack Overflow's
 * comments-vs-answers rule is the same instinct: an answer is a first-class,
 * attributable, citable artifact, not a note in the margin.
 */
export const QuestionAnswerSchema = z.looseObject({
  questionId: nonEmptyId,
  claim: ClaimSchema,
});

export type Question = z.infer<typeof QuestionSchema>;
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;
