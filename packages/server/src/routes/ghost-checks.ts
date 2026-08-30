/**
 * GET /api/ghost-checks — teammates whose LIVE plan overlaps the caller's own
 * (VISION.md §3, the deterministic half). One more parallel GET inside the
 * connector's SessionStart fetch block, and the same call `set_intent` makes
 * the moment a plan is declared; `repo` is the usual relevance filter, and
 * here it is also a boundary in fact — a colliding plan is a plan on the same
 * checkout, so nothing cross-repo is computed at all.
 *
 * NO PARAMETERS BEYOND THE REPO, deliberately. Everything the answer depends
 * on — which contexts are the caller's, what they target, what they intend —
 * is already on the hub under the caller's own identity, so a client cannot
 * widen the query, lower the floor, or ask about somebody else's overlap by
 * sending different arguments. The connector renders what it is given.
 */
import { Hono } from "hono";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues } from "../http/request.ts";
import { RepoQuerySchema } from "../http/schemas.ts";
import { developerAuth } from "../middleware/auth.ts";
import { listGhostOverlaps } from "../services/ghost-overlap.ts";
import type { AppDeps, AppEnv } from "../types.ts";

export const ghostChecksRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  router.get("/", async (c) => {
    const parsed = RepoQuerySchema.safeParse({ repo: c.req.query("repo") });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const overlaps = await listGhostOverlaps(
      deps,
      c.get("developer").id,
      parsed.data.repo,
    );
    return ok(c, { ghostChecks: overlaps });
  });

  return router;
};
