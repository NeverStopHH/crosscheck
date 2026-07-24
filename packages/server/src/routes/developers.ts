import { Hono } from "hono";

import { fail, ok } from "../http/envelope.ts";
import { readJsonBody, formatIssues } from "../http/request.ts";
import { CreateDeveloperBodySchema } from "../http/schemas.ts";
import { requireAdmin } from "../middleware/auth.ts";
import { createDeveloper } from "../services/developers.ts";
import type { AppDeps, AppEnv } from "../types.ts";

/** Admin-only developer bootstrap — the api key is returned exactly once. */
export const developersRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", requireAdmin(deps.adminToken));

  router.post("/", async (c) => {
    const parsed = CreateDeveloperBodySchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }

    const result = await createDeveloper(deps, parsed.data);
    if (result.outcome === "email_taken") {
      return fail(
        c,
        409,
        "conflict",
        "a developer with this email already exists",
      );
    }
    return ok(c, { developer: result.developer, apiKey: result.apiKey });
  });

  return router;
};