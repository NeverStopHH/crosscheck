import { Hono } from "hono";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues } from "../http/request.ts";
import { RepoQuerySchema } from "../http/schemas.ts";
import { developerAuth } from "../middleware/auth.ts";
import { getDiagnosis, listWorkContextsByRepo } from "../services/diagnosis.ts";
import type { AppDeps, AppEnv } from "../types.ts";

export const workContextsRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  router.get("/", async (c) => {
    const parsed = RepoQuerySchema.safeParse({ repo: c.req.query("repo") });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }

    const workContexts = await listWorkContextsByRepo(deps.db, parsed.data.repo);
    return ok(c, { workContexts });
  });

  router.get("/:id/diagnosis", async (c) => {
    const diagnosis = await getDiagnosis(deps.db, c.req.param("id"));
    if (diagnosis === undefined) {
      return fail(c, 404, "not_found", "work context not found");
    }
    return ok(c, diagnosis);
  });

  return router;
};
