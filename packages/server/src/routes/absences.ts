import { Hono } from "hono";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues } from "../http/request.ts";
import { RepoQuerySchema } from "../http/schemas.ts";
import { developerAuth } from "../middleware/auth.ts";
import { listAbsences } from "../services/absences.ts";
import { readCoverage } from "../services/coverage.ts";
import type { AppDeps, AppEnv } from "../types.ts";

/**
 * Repo-scoped like presence, and like `search_related_work` that scope is a
 * relevance filter, not a boundary (DESIGN.md §2.1) — any authenticated hub
 * member may read the absence findings for any repo.
 */
export const absencesRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  router.get("/", async (c) => {
    const parsed = RepoQuerySchema.safeParse({ repo: c.req.query("repo") });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }

    const absences = await listAbsences(
      deps,
      c.get("developer").id,
      parsed.data.repo,
    );
    // Nick's decision 1: coverage rides INSIDE this response rather than on a
    // GET of its own. PGlite is a single-connection embedded database
    // (services/search.ts:59-67), so a ninth parallel GET at SessionStart
    // would look free in wall clock and serialise on the hub inside the
    // 1000 ms budget. The findings are NOT handed on: this listing is bounded
    // twice and ordered so the rows it drops are the stalest committers, so
    // reading it as coverage would read a cut as a census. The git rung asks
    // the same predicate unbounded instead (services/absences.ts).
    const coverage = await readCoverage(
      deps,
      c.get("developer").id,
      parsed.data.repo,
    );
    return ok(c, { absences, coverage });
  });

  return router;
};
