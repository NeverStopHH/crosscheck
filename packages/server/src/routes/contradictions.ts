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
import { getRefereeBrief } from "../services/referee.ts";
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
    const candidates = await listContradictions(deps.db, {
      ...parsed.data,
      excludeMutedForDeveloperId: c.get("developer").id,
    });
    return ok(c, { candidates });
  });

  // Referee mode (VISION.md §4): the structured case file for one pair. The
  // ID scopes this call, not a repo — same rule as the diagnosis route — and
  // a retired pair still answers, with its retirement stated, because "the
  // deadlock is already over" is the single most useful fact a brief can hold.
  router.get("/:id/brief", async (c) => {
    const brief = await getRefereeBrief(deps.db, c.req.param("id"));
    if (brief === undefined) {
      return fail(c, 404, "not_found", "contradiction not found");
    }
    return ok(c, { brief });
  });

  return router;
};
