import { Hono } from "hono";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues } from "../http/request.ts";
import { WorkContextsQuerySchema } from "../http/schemas.ts";
import { developerAuth } from "../middleware/auth.ts";
import { getDiagnosis, listWorkContextsByRepo } from "../services/diagnosis.ts";
import { markHintsPulled } from "../services/hint-deliveries.ts";
import { parseSinceWindow } from "../services/time-window.ts";
import type { AppDeps, AppEnv } from "../types.ts";

/**
 * `?telemetry=0` — the escape hatch for a reader that is not a developer
 * following a hint (V1-X1). Anything other than the literal "0" leaves the
 * precision loop exactly as it was, so a typo cannot silently disable it.
 */
const wantsTelemetry = (raw: string | undefined): boolean => raw !== "0";

export const workContextsRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  router.get("/", async (c) => {
    const parsed = WorkContextsQuerySchema.safeParse({
      repo: c.req.query("repo"),
      since: c.req.query("since"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    // `since` is OPTIONAL here, unlike on /api/search where it is a filter the
    // caller chose and a bad one has to be refused loudly. Here it is the
    // reader's own render window (CONTEXT_MAX_AGE_DAYS), sent so the hub can
    // bound its answer — so an unparseable one is IGNORED rather than
    // rejected: this endpoint is on the SessionStart path, and a connector
    // sending a malformed window should get the (capped) list rather than a
    // 400 that costs the briefing.
    //
    // ONE parser, the search route's, so the two spellings cannot drift — and
    // it is the parser that reads BOTH spellings this repo sends: a relative
    // `14d` and the ISO instant the briefing derives from CONTEXT_MAX_AGE_DAYS.
    const sinceTerm = c.req.query("since");
    const window =
      sinceTerm === undefined || sinceTerm.trim().length === 0
        ? null
        : parseSinceWindow(sinceTerm, deps.now());

    const workContexts = await listWorkContextsByRepo(
      deps.db,
      c.get("developer").id,
      parsed.data.repo,
      {
        ...(window !== null && window.ok ? { since: window.since } : {}),
        limit: parsed.data.limit,
      },
    );
    return ok(c, { workContexts });
  });

  /**
   * The PURE read (trial finding V1-X1).
   *
   * `GET /:id/diagnosis` below marks hint deliveries pulled, because a
   * developer opening a hinted tree IS the "the hint was useful" signal. That
   * makes every read of it a WRITE to the precision ledger — and the trial's
   * own auditor read 113 contexts through it, each one capable of laundering
   * an undelivered hint into a pulled one. Tooling, dashboards and audits need
   * a door that only reads, so here it is; the diagnosis route keeps its
   * telemetry and its URL.
   */
  router.get("/:id", async (c) => {
    const diagnosis = await getDiagnosis(deps.db, c.req.param("id"));
    if (diagnosis === undefined) {
      return fail(c, 404, "not_found", "work context not found");
    }
    return ok(c, diagnosis);
  });

  router.get("/:id/diagnosis", async (c) => {
    const diagnosis = await getDiagnosis(deps.db, c.req.param("id"));
    if (diagnosis === undefined) {
      return fail(c, 404, "not_found", "work context not found");
    }
    // The precision loop (DESIGN.md §4): a read of a hinted tree is the
    // "hint was useful" signal. Telemetry rides on the read and must never
    // fail it — hence the catch around what is otherwise two bounded queries.
    // `?telemetry=0` opts out for anyone who already scripted this URL and
    // does not want to be counted as a reader (V1-X1).
    if (wantsTelemetry(c.req.query("telemetry"))) {
      try {
        await markHintsPulled(deps, c.get("developer").id, c.req.param("id"));
      } catch (error) {
        console.error("[crosscheck] marking hint deliveries pulled failed", error);
      }
    }
    return ok(c, diagnosis);
  });

  return router;
};
