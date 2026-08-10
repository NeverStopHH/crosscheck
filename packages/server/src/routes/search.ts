/**
 * GET /api/search — the hub side of `search_related_work` (DESIGN.md §6).
 *
 * `repo` is a RELEVANCE filter, not a boundary (DESIGN.md §2.1): its value
 * comes from the caller's own checkout, the hub cannot re-derive it from the
 * api key, and any work context this endpoint omits is still readable by id
 * through the diagnosis route. Omitting `repo` searches the whole hub.
 */
import { Hono } from "hono";
import { z } from "zod";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues } from "../http/request.ts";
import { developerAuth } from "../middleware/auth.ts";
import {
  SEARCH_DEFAULT_LIMIT,
  searchWorkContexts,
} from "../services/search.ts";
import type { AppDeps, AppEnv } from "../types.ts";

/** Oversized limits are capped in the search service, not rejected here. */
const SearchQuerySchema = z.object({
  query: z.string().default(""),
  repo: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).default(SEARCH_DEFAULT_LIMIT),
});

export const searchRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  router.get("/", async (c) => {
    const parsed = SearchQuerySchema.safeParse({
      query: c.req.query("query"),
      repo: c.req.query("repo"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const response = await searchWorkContexts(deps, parsed.data);
    return ok(c, response);
  });

  return router;
};
