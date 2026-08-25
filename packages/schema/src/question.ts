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
 * `status` and `expiresAt` are on the wire because a READ carries them, and
 * they are IGNORED ON INGEST: the hub owns both. A client that could post
 * `status: "answered"` could mark its own question answered without anybody
 * answering it, and a client that could post `expiresAt` could file a
 * question that outlives the TTL for ever — a haunted briefing, which is the
 * one thing an expiring channel exists to prevent.
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

const nonEmptyId = z.string().min(1);

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
