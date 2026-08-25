/**
 * /api/questions — the asynchronous question channel's HTTP surface
 * (roadmap R2). Three verbs, one service (services/questions.ts):
 *
 *   POST /api/questions               ask one teammate one question
 *   GET  /api/questions?repo=…        my inbox, my answers, my counters
 *   POST /api/questions/:id/answers   answer one question I was asked
 *
 * THE DEVELOPER TERM IS RESOLVED HERE, through the same `lookUpDeveloper` +
 * `describeAmbiguousDeveloper` / `describeUnknownDeveloper` pair
 * `GET /api/search` uses. That is why asking is a route of its own rather
 * than only a record kind: `POST /api/records` can reject a body, but it
 * cannot say "Kim is the name of three developers here: …", and an empty
 * answer to a misspelt name is the same expensive lie in this channel as in
 * search — "Ken has done nothing" becomes "Ken cannot be asked".
 *
 * The `question` and `question_answer` RECORD KINDS still exist and reach the
 * same service through `/api/records` (services/records.ts): that is the
 * spool-replay path, where the term was already resolved when the tool ran.
 */
import { Hono } from "hono";
import { z } from "zod";
import { ClaimSchema, MAX_QUESTION_BODY_LENGTH } from "@crosscheck/schema";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues, readJsonBody } from "../http/request.ts";
import { developerAuth } from "../middleware/auth.ts";
import {
  describeAmbiguousDeveloper,
  describeUnknownDeveloper,
  lookUpDeveloper,
  MAX_DEVELOPER_REF_CHARS,
} from "../services/developer-lookup.ts";
import {
  answerQuestion,
  askQuestion,
  listAnswerableQuestions,
  listQuestions,
} from "../services/questions.ts";
import type { AppDeps, AppEnv } from "../types.ts";

/** Ids are minted by the caller so a spool replay is idempotent. */
const MAX_QUESTION_ID_CHARS = 64;

const AskBodySchema = z.object({
  id: z.string().min(1).max(MAX_QUESTION_ID_CHARS),
  repo: z.string().min(1),
  sessionId: z.string().min(1),
  body: z.string().min(1).max(MAX_QUESTION_BODY_LENGTH),
  developer: z.string().min(1).max(MAX_DEVELOPER_REF_CHARS).optional(),
  workContextId: z.string().min(1).optional(),
});

/**
 * The claim is parsed by the CANONICAL schema here, before anything touches
 * the database: an answer is a claim, so it obeys the claim rules, and the
 * caller gets the same zod issues `publish_claim` would have produced.
 */
const AnswerBodySchema = z.object({ claim: ClaimSchema });

const QUESTION_BUDGET_CODE = "question_budget_reached";
const QUESTION_INVALID_CODE = "invalid_question";
const QUESTION_NOT_ANSWERABLE_CODE = "question_not_answerable";

export const questionsRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  router.post("/", async (c) => {
    const parsed = AskBodySchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const input = parsed.data;
    let targetDeveloperId: string | undefined;
    if (input.developer !== undefined) {
      // Blank is its own mistake with its own sentence, exactly as in search:
      // a whitespace term trims to nothing and would be echoed back as an
      // empty pair of quotes beside "name a teammate".
      if (input.developer.trim().length === 0) {
        return fail(
          c,
          400,
          "invalid_developer",
          "developer cannot be blank — name the teammate you are asking, or " +
            "name a work context and crosscheck asks whoever owns it.",
        );
      }
      const lookup = await lookUpDeveloper(deps.db, input.developer);
      if (lookup.outcome === "ambiguous") {
        return fail(
          c,
          400,
          "ambiguous_developer",
          describeAmbiguousDeveloper(
            input.developer,
            lookup.candidates,
            lookup.totalCount,
          ),
        );
      }
      if (lookup.outcome === "unknown") {
        return fail(
          c,
          400,
          "unknown_developer",
          describeUnknownDeveloper(input.developer, lookup.suggestions),
        );
      }
      targetDeveloperId = lookup.developer.id;
    }

    const outcome = await askQuestion(deps, c.get("developer").id, {
      id: input.id,
      repo: input.repo,
      authorSessionId: input.sessionId,
      ...(targetDeveloperId === undefined ? {} : { targetDeveloperId }),
      ...(input.workContextId === undefined
        ? {}
        : { workContextId: input.workContextId }),
      body: input.body,
      createdAt: deps.now(),
    });
    switch (outcome.outcome) {
      case "invalid":
        return fail(c, 400, QUESTION_INVALID_CODE, outcome.reason);
      case "budget":
        // 429, not 400: the request was well formed and the caller may retry
        // it later — which is exactly what a rate limit means.
        return fail(c, 429, QUESTION_BUDGET_CODE, outcome.reason);
      case "duplicate":
        return ok(c, { questionId: outcome.questionId, duplicate: true });
      case "asked":
        // The NAME travels beside the row: on the workContextId-only path the
        // caller never named a person, and "it appears in their briefing" is
        // unreadable when "their" resolves to nobody.
        return ok(c, {
          question: outcome.question,
          targetDeveloperName: outcome.targetDeveloperName,
          duplicate: false,
        });
    }
  });

  router.get("/", async (c) => {
    const repo = c.req.query("repo");
    if (repo === undefined || repo.length === 0) {
      return fail(c, 400, "validation_failed", "repo is required");
    }
    // `?answerable=1` is the PULL shape (`list_open_questions`): the same
    // inbox without the reader's mute filter, because a mute covers unasked
    // surfaces and a pull is not one (DESIGN.md §2.1). Everything else — the
    // answers and the counters — is identical, so the tool still makes one
    // call.
    if (c.req.query("answerable") !== undefined) {
      const inbox = await listAnswerableQuestions(
        deps,
        c.get("developer").id,
        repo,
      );
      return ok(c, { inbox, answers: [], counts: null });
    }
    const view = await listQuestions(deps, c.get("developer").id, repo);
    return ok(c, view);
  });

  router.post("/:id/answers", async (c) => {
    const parsed = AnswerBodySchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const questionId = c.req.param("id");
    if (questionId.length === 0 || questionId.length > MAX_QUESTION_ID_CHARS) {
      return fail(c, 400, "validation_failed", "invalid question id");
    }
    const outcome = await answerQuestion(deps, c.get("developer").id, {
      questionId,
      claim: parsed.data.claim,
    });
    switch (outcome.outcome) {
      case "refused":
        return fail(c, 400, QUESTION_NOT_ANSWERABLE_CODE, outcome.reason);
      case "duplicate":
        return ok(c, { claimId: outcome.claimId, duplicate: true });
      case "answered":
        return ok(c, {
          questionId: outcome.questionId,
          claimId: outcome.claimId,
          duplicate: false,
        });
    }
  });

  return router;
};
