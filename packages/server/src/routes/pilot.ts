/**
 * GET /api/pilot/report?repo=…&days=… — the five proofs (1.0 spec 07 §5).
 *
 * ONE READ, NO DASHBOARD. `crosscheck pilot` prints it; nothing else consumes
 * it, and nothing uploads it anywhere (§8.5). `--json` writes the same object
 * to the reader's stdout and stops there.
 *
 * READ IS OPEN TO ANY MEMBER, the asymmetry team settings already use:
 * everybody who is being measured has to be able to see what is measured and
 * what it says. The report carries no person — no developer id, no name, no
 * per-developer grouping (§8.4) — so an open read discloses nothing about
 * anyone that the team's own shared record does not already hold.
 *
 * THE WINDOW IS BOUNDED BY RETENTION. A window reaching past
 * `PILOT_RETENTION_DAYS` would be computed over rows retention has already
 * removed, and the figures would fall for a reason nobody changed — which a
 * reader would take as a product effect.
 */
import { Hono } from "hono";
import { z } from "zod";

import {
  PILOT_REPORT_DEFAULT_WINDOW_DAYS,
  PILOT_RETENTION_DAYS,
} from "../constants.ts";
import { fail, ok } from "../http/envelope.ts";
import { formatIssues } from "../http/request.ts";
import { developerAuth } from "../middleware/auth.ts";
import { readPilotReport } from "../services/pilot-report.ts";
import type { AppDeps, AppEnv } from "../types.ts";

const ReportQuerySchema = z.object({
  repo: z.string().min(1),
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(PILOT_RETENTION_DAYS)
    .default(PILOT_REPORT_DEFAULT_WINDOW_DAYS),
});

export const pilotRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();

  router.get("/report", developerAuth(deps), async (c) => {
    const parsed = ReportQuerySchema.safeParse({
      repo: c.req.query("repo"),
      days: c.req.query("days"),
    });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    return ok(
      c,
      await readPilotReport(deps, {
        repo: parsed.data.repo,
        days: parsed.data.days,
      }),
    );
  });

  return router;
};
