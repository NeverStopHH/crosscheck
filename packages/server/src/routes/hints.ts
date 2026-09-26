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
import { COVERAGE_SESSION_WINDOW_DAYS } from "../constants.ts";
import { readCoverage } from "../services/coverage.ts";
import { countCoverageAnswer } from "../services/pilot.ts";
import { listHintCandidates, listTargetSessions } from "../services/hints.ts";
import { listLandedNotices } from "../services/landed-notices.ts";
import { listUndeliveredAnswers } from "../services/questions.ts";
import { SEARCH_MAX_QUERY_CHARS } from "../services/search.ts";
import type { AppDeps, AppEnv } from "../types.ts";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
    // TWO reads, ONE round trip. The UserPromptSubmit hook has an 800 ms
    // budget for the whole call (DESIGN.md §4), so the answers to the
    // caller's own questions ride this response rather than costing a second
    // request: they are the one thing the prompt path may deliver as
    // SUBSTANCE (DESIGN.md §4, solicited exception), and a hint path that had
    // to choose between them and a teammate pointer needs both in hand.
    // Both queries are bounded and indexed; they run in parallel.
    // THREE reads, ONE round trip, for the reason above plus one more: the
    // coverage record (03 §3.5) is bytes on a response the hook already
    // waits for, never a second request inside the 800 ms budget.
    // FOUR, with the author's notices (docs/1.0/landed-changes.md, step 4):
    // told on the author's next prompt, so they ride the one call the prompt
    // already makes — the same list the briefing reads, the same repo scope.
    const [candidates, answers, coverage, notices] = await Promise.all([
      listHintCandidates(deps, c.get("developer").id, parsed.data),
      // `repo` on BOTH: the answers are scoped exactly like the candidates
      // beside them, so solicited substance from another codebase cannot land
      // in a session that never asked it (services/questions.ts says why).
      listUndeliveredAnswers(deps, c.get("developer").id, parsed.data.repo),
      readCoverage(deps, c.get("developer").id, parsed.data.repo),
      listLandedNotices(deps, c.get("developer").id, parsed.data.repo),
    ]);
    // 07 §3.5, proof 5: this answer carried a coverage record, and
    // whether it did is what 03 made mandatory and nobody counted.
    await countCoverageAnswer(deps, {
      repo: parsed.data.repo,
      surface: "api-hints-candidates",
      coverage,
    });
    return ok(c, { candidates, answers, coverage, notices });
  });

  router.get("/tripwire", async (c) => {
    const parsed = TripwireQuerySchema.safeParse({
      repo: c.req.query("repo"),
      value: c.req.query("value"),
    });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const [sessions, coverage] = await Promise.all([
      listTargetSessions(
        deps,
        c.get("developer").id,
        parsed.data.repo,
        parsed.data.value,
      ),
      // SCOPED TO THE FILE the tripwire is about (§3.2a): the question is
      // "was anybody watching THIS path", not "was anybody watching this
      // repo for a fortnight".
      readCoverage(deps, c.get("developer").id, parsed.data.repo, {
        scope: {
          sinceIso: new Date(
            deps.now().getTime() - COVERAGE_SESSION_WINDOW_DAYS * MS_PER_DAY,
          ).toISOString(),
          paths: [parsed.data.value],
        },
      }),
    ]);
    // 07 §3.5, proof 5: this answer carried a coverage record, and
    // whether it did is what 03 made mandatory and nobody counted.
    await countCoverageAnswer(deps, {
      repo: parsed.data.repo,
      surface: "api-hints-tripwire",
      coverage,
    });
    return ok(c, { sessions, coverage });
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
