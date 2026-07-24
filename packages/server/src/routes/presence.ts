import { Hono } from "hono";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues } from "../http/request.ts";
import { PresenceQuerySchema } from "../http/schemas.ts";
import { developerAuth } from "../middleware/auth.ts";
import { listPresence } from "../services/presence.ts";
import type { AppDeps, AppEnv } from "../types.ts";

export const presenceRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  router.get("/", async (c) => {
    const parsed = PresenceQuerySchema.safeParse({ repo: c.req.query("repo") });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }

    const developer = c.get("developer");
    const sessions = await listPresence(deps, developer.id, parsed.data.repo);
    return ok(c, { sessions });
  });

  return router;
};