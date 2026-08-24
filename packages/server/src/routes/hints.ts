/**
 * GET /api/hints/candidates — one bounded call for the UserPromptSubmit hook.
 * GET /api/hints/tripwire — one bounded call for the PreToolUse tripwire.
 *
 * Both serve hook paths with hard sync budgets (DESIGN.md §4), so both are a
 * single service call over bounded queries; ranking beyond the search service
 * and all delivery policy live in the connector.
 */
import { Hono } from "hono";
import { z } from "zod";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues } from "../http/request.ts";
import { developerAuth } from "../middleware/auth.ts";
import { hintStatsForRepo } from "../services/hint-deliveries.ts";
import { listHintCandidates, listTargetSessions } from "../services/hints.ts";
import { SEARCH_MAX_QUERY_CHARS } from "../services/search.ts";
import type { AppDeps, AppEnv } from "../types.ts";

/**
 * `repo` is required on both routes: hints and tripwires are relevance-scoped
 * to where the session reports (a filter, not a boundary — DESIGN.md §2.1).
 * The query cap mirrors the search route's, for the same embedded-database
 * reason (SEARCH_MAX_QUERY_CHARS in the search service).
 */
const CandidatesQuerySchema = z.object({
  query: z.string().max(SEARCH_MAX_QUERY_CHARS).default(""),
  repo: z.string().min(1),
});

const TripwireQuerySchema = z.object({
  repo: z.string().min(1),
  value: z.string().min(1).max(SEARCH_MAX_QUERY_CHARS),
});

const StatsQuerySchema = z.object({ repo: z.string().min(1) });

export const hintsRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  /**
   * GET /api/hints/stats — three counts, so a connector can say whether hints
   * are reaching anybody (trial finding M1).
   *
   * NOT on a hook path: `crosscheck status` and `doctor` call it, both
   * human-run, and both render nothing at all when an older hub 404s it.
   */
  router.get("/stats", async (c) => {
    const parsed = StatsQuerySchema.safeParse({ repo: c.req.query("repo") });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    return ok(c, await hintStatsForRepo(deps, parsed.data.repo));
  });

  router.get("/candidates", async (c) => {
    const parsed = CandidatesQuerySchema.safeParse({
      query: c.req.query("query"),
      repo: c.req.query("repo"),
    });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const candidates = await listHintCandidates(
      deps,
      c.get("developer").id,
      parsed.data,
    );
    return ok(c, { candidates });
  });

  router.get("/tripwire", async (c) => {
    const parsed = TripwireQuerySchema.safeParse({
      repo: c.req.query("repo"),
      value: c.req.query("value"),
    });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const sessions = await listTargetSessions(
      deps,
      c.get("developer").id,
      parsed.data.repo,
      parsed.data.value,
    );
    return ok(c, { sessions });
  });

  return router;
};
