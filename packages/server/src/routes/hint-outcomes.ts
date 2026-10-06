/**
 * /api/hint-outcomes — what a delivered hint led to (1.0 spec 07 §13).
 *
 * A ROUTE OF ITS OWN, for the reason the pilot marks have one: the caller is
 * waiting for the answer — "recorded", "already recorded", "nothing with that
 * id reached you" — and a fire-and-forget spool record would teach an agent
 * that the tool does nothing.
 *
 * NOT THE MARK ROUTE, and the separation is the point. `POST /api/pilot-marks`
 * takes a person's label and is reached by no agent path (PIL-6); this one is
 * reached by `mark_hint_outcome`, the agent's tool, and by `crosscheck
 * followed` / `crosscheck overrode`. No presence claim is asked for, because
 * none is made: every row is attributed to the developer's key, whoever held it.
 */
import { Hono } from "hono";
import { z } from "zod";
import {
  HintOutcomeSchema,
  describeUnstorableText,
  unstorableTextPath,
} from "@crosscheck/schema";

import { PILOT_REPORT_DEFAULT_WINDOW_DAYS, PILOT_RETENTION_DAYS } from "../constants.ts";
import { fail, ok } from "../http/envelope.ts";
import { formatIssues, readJsonBody } from "../http/request.ts";
import { developerAuth } from "../middleware/auth.ts";
import { readMyHintOutcomes } from "../services/hint-outcome-view.ts";
import { writeHintOutcome } from "../services/hint-outcomes.ts";
import type { HintOutcomeRefusal } from "../services/hint-outcomes.ts";
import type { AppDeps, AppEnv } from "../types.ts";

const HTTP_OK = 200;
const HTTP_CREATED = 201;

/**
 * ONE SENTENCE PER REFUSAL, each saying what to do next — the reader is an
 * agent as often as a person, and a refusal it cannot act on is a retry loop.
 */
export const HINT_OUTCOME_REFUSAL_SENTENCE: Record<HintOutcomeRefusal, string> = {
  not_enrolled:
    "this repo is not in the pilot, so no hint outcome is recorded here — whoever runs the hub enrols it, or leave it as it is",
  // ALSO the answer for a delivery that reached somebody else: a separate
  // sentence would tell the asker what a colleague was shown.
  unknown_ref:
    "no hint with that id reached you on this repo — name the work context or claim id the hint printed",
  wrong_repo:
    "that delivery belongs to another repo; outcomes are repo-scoped, so record it from that repo",
  not_unsolicited:
    "that was an answer somebody asked for; an outcome is recorded for what arrived unasked",
  before_outcomes:
    "that hint reached you before this repo began recording outcomes, so no outcome figure could ever count it — nothing was recorded",
  while_paused:
    "that hint reached you while this repo's pilot was paused, so no outcome figure could ever count it — nothing was recorded",
  past_window: `that hint reached you more than ${String(PILOT_RETENTION_DAYS)} days ago, older than any outcome figure reads — nothing was recorded`,
  reason_secret:
    "the reason looks like it holds a secret (a key, a token, a password), so nothing was recorded — say it again without it",
};

/**
 * The pilot report's window, for the same reason: retention is the widest a
 * window can honestly be, and the default is the report's own eight weeks.
 */
const MineQuerySchema = z.object({
  repo: z.string().min(1),
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(PILOT_RETENTION_DAYS)
    .default(PILOT_REPORT_DEFAULT_WINDOW_DAYS),
});

export const hintOutcomeRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();

  /**
   * THE CALLER'S OWN VIEW. No query parameter names a person: whose view it
   * is comes from the key, so somebody else's cannot be asked for (07 §13).
   */
  router.get("/mine", developerAuth(deps), async (c) => {
    const parsed = MineQuerySchema.safeParse({
      repo: c.req.query("repo"),
      days: c.req.query("days"),
    });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const view = await readMyHintOutcomes(deps, {
      repo: parsed.data.repo,
      days: parsed.data.days,
      developerId: c.get("developer").id,
    });
    if ("refusal" in view) {
      return fail(c, 422, view.refusal, HINT_OUTCOME_REFUSAL_SENTENCE[view.refusal]);
    }
    return ok(c, view);
  });

  router.post("/", developerAuth(deps), async (c) => {
    const parsed = HintOutcomeSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    // This route is its OWN boundary, as the mark route is: the row reaches
    // the table straight from here, never through parseRecord.
    const unstorable = unstorableTextPath(parsed.data);
    if (unstorable !== null) {
      return fail(c, 400, "validation_failed", describeUnstorableText(unstorable));
    }
    const result = await writeHintOutcome(deps, {
      repo: parsed.data.repo,
      ref: parsed.data.ref,
      outcome: parsed.data.outcome,
      reason: parsed.data.reason ?? null,
      session: parsed.data.session ?? null,
      recordedBy: c.get("developer").id,
    });
    if ("refusal" in result) {
      return fail(c, 422, result.refusal, HINT_OUTCOME_REFUSAL_SENTENCE[result.refusal]);
    }
    return ok(c, result, result.repeated ? HTTP_OK : HTTP_CREATED);
  });

  return router;
};
