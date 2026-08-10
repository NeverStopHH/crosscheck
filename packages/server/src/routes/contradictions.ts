/**
 * GET /api/contradictions — open diagnostic conflicts, for briefings
 * (DESIGN.md §4: "open contradictions in this area").
 *
 * `repo` filters to candidates TOUCHING the repo (either side), and is a
 * relevance filter like the search route's — never a boundary (§2.1).
 */
import { Hono } from "hono";
import { z } from "zod";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues } from "../http/request.ts";
import { developerAuth } from "../middleware/auth.ts";
import {
  CONTRADICTIONS_DEFAULT_LIMIT,
  listContradictions,
} from "../services/contradictions.ts";
import type { AppDeps, AppEnv } from "../types.ts";

/** Oversized limits are capped in the service, not rejected here. */
const ContradictionsQuerySchema = z.object({
  repo: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).default(CONTRADICTIONS_DEFAULT_LIMIT),
});

export const contradictionsRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  router.get("/", async (c) => {
    const parsed = ContradictionsQuerySchema.safeParse({
      repo: c.req.query("repo"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const candidates = await listContradictions(deps.db, parsed.data);
    return ok(c, { candidates });
  });

  return router;
};
