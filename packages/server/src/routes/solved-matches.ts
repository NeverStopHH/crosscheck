/**
 * GET /api/solved-matches — solved trees sharing a strong target with work
 * currently active on this repo (VISION.md §1). One more parallel GET inside
 * the connector's SessionStart fetch block; `repo` is the usual relevance
 * filter, never a boundary (DESIGN.md §2.1).
 */
import { Hono } from "hono";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues } from "../http/request.ts";
import { RepoQuerySchema } from "../http/schemas.ts";
import { developerAuth } from "../middleware/auth.ts";
import { listSolvedMatches } from "../services/solved-matches.ts";
import type { AppDeps, AppEnv } from "../types.ts";

export const solvedMatchesRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  router.get("/", async (c) => {
    const parsed = RepoQuerySchema.safeParse({ repo: c.req.query("repo") });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const matches = await listSolvedMatches(
      deps,
      c.get("developer").id,
      parsed.data.repo,
    );
    return ok(c, { matches });
  });

  return router;
};
