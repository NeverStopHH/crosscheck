import { Hono } from "hono";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues } from "../http/request.ts";
import { RepoQuerySchema } from "../http/schemas.ts";
import { developerAuth } from "../middleware/auth.ts";
import { getDiagnosis, listWorkContextsByRepo } from "../services/diagnosis.ts";
import { markHintsPulled } from "../services/hint-deliveries.ts";
import type { AppDeps, AppEnv } from "../types.ts";

export const workContextsRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  router.get("/", async (c) => {
    const parsed = RepoQuerySchema.safeParse({ repo: c.req.query("repo") });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }

    const workContexts = await listWorkContextsByRepo(
      deps.db,
      c.get("developer").id,
      parsed.data.repo,
    );
    return ok(c, { workContexts });
  });

  router.get("/:id/diagnosis", async (c) => {
    const diagnosis = await getDiagnosis(deps.db, c.req.param("id"));
    if (diagnosis === undefined) {
      return fail(c, 404, "not_found", "work context not found");
    }
    // The precision loop (DESIGN.md §4): a read of a hinted tree is the
    // "hint was useful" signal. Telemetry rides on the read and must never
    // fail it — hence the catch around what is otherwise two bounded queries.
    try {
      await markHintsPulled(deps, c.get("developer").id, c.req.param("id"));
    } catch (error) {
      console.error("[crosscheck] marking hint deliveries pulled failed", error);
    }
    return ok(c, diagnosis);
  });

  return router;
};
