/**
 * GET /api/hints/candidates — one bounded call for the UserPromptSubmit hook.
 * GET /api/hints/tripwire — one bounded call for the PreToolUse tripwire.
 * GET /api/hints/stats — delivered/pulled per repo over a bounded window plus
 *   the repo's claim count, for `crosscheck doctor`/`status` (trial findings
 *   #20 + M1); read-only.
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
import {
  HINT_STATS_DEFAULT_WINDOW_DAYS,
  HINT_STATS_MAX_WINDOW_DAYS,
  readHintStats,
} from "../services/hint-deliveries.ts";
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

/** `days` above the cap is clamped by the service, never honoured. */
const StatsQuerySchema = z.object({
  repo: z.string().min(1),
  days: z.coerce.number().int().min(1).default(HINT_STATS_DEFAULT_WINDOW_DAYS),
});

export const hintsRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

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

  /**
   * GET /api/hints/stats — delivered/pulled over the window plus the repo's
   * claim count, so a connector can say whether hints are reaching anybody
   * (trial findings #20 + M1).
   *
   * NOT on a hook path: `crosscheck status` and `doctor` call it, both
   * human-run, and both degrade to "not measured" when an older hub 404s it.
   */
  router.get("/stats", async (c) => {
    const parsed = StatsQuerySchema.safeParse({
      repo: c.req.query("repo"),
      days: c.req.query("days"),
    });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const stats = await readHintStats(
      deps,
      parsed.data.repo,
      Math.min(parsed.data.days, HINT_STATS_MAX_WINDOW_DAYS),
    );
    return ok(c, stats);
  });

  return router;
};
