/**
 * /api/ci-runs — what CI saw, keyed to a commit (spec 05 §3.7).
 *
 *   POST /api/ci-runs                    a reporter files one run  (CI token)
 *   GET  /api/ci-runs?repo=&commit=      what this hub holds       (any member)
 *
 * A ROUTE OF ITS OWN, NOT A RECORD KIND, and the reason is a refusal rather
 * than a convenience. `/api/records` carries an envelope, and an envelope
 * requires a producer: a developer, an agent kind and a session. CI has none
 * of the three. Minting a synthetic session so a CI report could travel that
 * road would put a teammate in the graph who does not exist — the phantom
 * teammate the absence machinery must never invent, because every "who was
 * working on this" answer would then include a robot nobody can ask.
 *
 * WRITE IS A TOKEN, READ IS A MEMBER — the team-settings asymmetry, and here
 * it carries an extra argument. The write token is NOT the admin token: that
 * one also flips `pin_policy` and `suspect_attribution`, and a CI secret is
 * readable by every workflow in the repository. One token, one capability.
 * Read is open because a coverage qualifier nobody can look behind is a
 * qualifier nobody can check.
 */
import { Hono } from "hono";
import { z } from "zod";
import { CiRunReportSchema } from "@crosscheck/schema";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues, readJsonBody } from "../http/request.ts";
import { developerAuth, requireCiToken } from "../middleware/auth.ts";
import {
  ingestCiRun,
  readCiRuns,
  readCiTestResults,
} from "../services/ci-runs.ts";
import type { AppDeps, AppEnv } from "../types.ts";

const ReadQuerySchema = z.object({
  repo: z.string().min(1),
  commit: z.string().min(1),
});

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_CONFLICT = 409;

export const ciRunsRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();

  router.post("/", requireCiToken(deps.ciToken), async (c) => {
    const parsed = CiRunReportSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const outcome = await ingestCiRun(deps, parsed.data);
    if (outcome.status === "rejected") {
      // 409, not 400: the body is well formed and the refusal is about the
      // hub's own state — the named target run is absent, or belongs to a
      // different lane. A reporter that retried on 400 would retry forever.
      return fail(
        c,
        HTTP_CONFLICT,
        "ci_run_rejected",
        outcome.issues?.join("; ") ?? "rejected",
      );
    }
    return ok(
      c,
      { id: outcome.id, status: outcome.status },
      outcome.status === "accepted" ? HTTP_CREATED : HTTP_OK,
    );
  });

  router.get("/", developerAuth(deps), async (c) => {
    const parsed = ReadQuerySchema.safeParse({
      repo: c.req.query("repo"),
      commit: c.req.query("commit"),
    });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const runs = await readCiRuns(deps.db, parsed.data.repo, parsed.data.commit);
    return ok(c, {
      runs: await Promise.all(
        runs.map(async (run) => ({
          ...run,
          startedAt: run.startedAt.toISOString(),
          collectedAt: run.collectedAt.toISOString(),
          results: await readCiTestResults(deps.db, run.id),
        })),
      ),
    });
  });

  return router;
};
