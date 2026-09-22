/**
 * `POST /api/claim-revalidations` — the RECORDING half of a check that runs on
 * a developer's machine, the shape `POST /api/pins/sweep` already has.
 *
 * A ROUTE RATHER THAN A RECORD KIND, because a revalidation can originate
 * outside any agent session: `crosscheck revalidate` runs from a terminal, and
 * minting a session for it would put a phantom teammate into presence, into
 * every briefing and into the tripwire.
 *
 * `developerAuth`, not a CI token: any member may report, because the check is
 * reproducible from any clone and only commit hashes travel. What a forged
 * report can do is bounded by the downgrade-only rule in the service — it can
 * mark a claim stale, never restore one.
 */
import { Hono } from "hono";
import { ClaimRevalidationReportSchema } from "@crosscheck/schema";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues, readJsonBody } from "../http/request.ts";
import { developerAuth } from "../middleware/auth.ts";
import {
  ingestClaimRevalidations,
  unknownClaimIds,
} from "../services/claim-revalidations.ts";
import { summariseClaimValidity } from "../services/claim-validity.ts";
import type { AppDeps, AppEnv } from "../types.ts";

export const claimRevalidationsRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  /**
   * `GET /api/claim-revalidations/summary?repo=…` — COUNTS ONLY, for the two
   * refusals doctor owes (spec 02 §8.5, §8.9).
   *
   * It sits on this router rather than becoming a fourth mount because it is
   * the same subject read the other way: what the reporting half has and has
   * not been told. Same `developerAuth`, same repo scope — and no claim
   * identity crosses it at all. An id, a body or a developer name here would
   * turn a health check into a listing endpoint nobody asked for, and the
   * question doctor asks ("how much of what this team knows can be judged at
   * all") is answered by a number.
   */
  router.get("/summary", async (c) => {
    const repo = c.req.query("repo");
    if (repo === undefined || repo.length === 0) {
      return fail(c, 400, "validation_failed", "repo is required");
    }
    return ok(c, await summariseClaimValidity(deps.db, deps.now(), repo));
  });

  router.post("/", async (c) => {
    const parsed = ClaimRevalidationReportSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    // Named rather than dropped: a report about claims this hub has never
    // heard of is a caller reading a different hub, and silently storing
    // nothing would look identical to success.
    // SCOPED BY THE REPO THE REPORT NAMES. The body has always carried one
    // and this handler never read it, so a reading about repo A was accepted
    // as authority over a claim in repo B — and the downgrade-only rule made
    // that one-way, since no honest `unchanged` can undo a forged `changed`.
    const unknown = await unknownClaimIds(
      deps.db,
      parsed.data.repo,
      parsed.data.entries.map((entry) => entry.claimId),
    );
    if (unknown.length > 0) {
      return fail(
        c,
        400,
        "unknown_claims",
        `this hub has no claim ${unknown.join(", ")} in ${parsed.data.repo} — a revalidation names claims read from this hub, in the repo it was measured against`,
      );
    }
    const outcome = await ingestClaimRevalidations(
      deps,
      c.get("developer").id,
      parsed.data,
    );
    // The map is the service's shape; the wire gets a plain object keyed by
    // claim id, so a caller reads back the verdict for exactly the claims it
    // named — including the ones whose report was refused.
    return ok(c, {
      recorded: outcome.recorded,
      refusedDowngrades: outcome.refusedDowngrades,
      refusedUnbound: outcome.refusedUnbound,
      pruned: outcome.pruned,
      validities: Object.fromEntries(outcome.validities),
    });
  });

  return router;
};
