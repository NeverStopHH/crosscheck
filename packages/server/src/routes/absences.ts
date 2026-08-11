import { Hono } from "hono";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues } from "../http/request.ts";
import { RepoQuerySchema } from "../http/schemas.ts";
import { developerAuth } from "../middleware/auth.ts";
import { listAbsences } from "../services/absences.ts";
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
    return ok(c, { absences });
  });

  return router;
};
