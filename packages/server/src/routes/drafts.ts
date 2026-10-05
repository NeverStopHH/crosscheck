/**
 * GET /api/drafts — the caller's OWN unreviewed Tier-1 drafts (DESIGN.md §3
 * Tier 1 promotion loop). One more repo-scoped GET in the connector's
 * SessionStart parallel fetch block; `repo` is the usual relevance filter,
 * never a boundary (DESIGN.md §2.1). Own-only is enforced in the service's
 * WHERE — there is no parameter that widens it.
 */
import { Hono } from "hono";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues } from "../http/request.ts";
import { RepoQuerySchema } from "../http/schemas.ts";
import { developerAuth } from "../middleware/auth.ts";
import { listOwnDrafts, summarizeOwnDrafts } from "../services/drafts.ts";
import type { AppDeps, AppEnv } from "../types.ts";

export const draftsRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  router.get("/", async (c) => {
    const parsed = RepoQuerySchema.safeParse({ repo: c.req.query("repo") });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const developerId = c.get("developer").id;
    const [drafts, backlog] = await Promise.all([
      listOwnDrafts(deps.db, developerId, parsed.data.repo),
      summarizeOwnDrafts(deps.db, developerId, parsed.data.repo),
    ]);
    // Additive: `total` and `oldestCreatedAt` describe the whole backlog the
    // capped, newest-first rows are cut from; an older client ignores them.
    return ok(c, { drafts, ...backlog });
  });

  return router;
};
