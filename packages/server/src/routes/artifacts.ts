/**
 * /api/artifacts — the operator's side of artifact release (review of the
 * hub hardening, M3):
 *
 *   POST /api/artifacts/:id/withdraw   re-hide a released artifact (admin token)
 *
 * Releasing stays a person's passkey ceremony on /ui/approvals. Withdrawing a
 * release makes content more private, so its owner does it with a plain
 * session form, and the operator does it here for an incident: a release the
 * owner cannot reach, or one an agent made through the 0.10 form post.
 */
import { Hono } from "hono";

import { fail, ok } from "../http/envelope.ts";
import { requireAdmin } from "../middleware/auth.ts";
import { withdrawArtifactAsOperator } from "../services/artifacts.ts";
import type { AppDeps, AppEnv } from "../types.ts";

export const artifactRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", requireAdmin(deps.adminToken));

  router.post("/:id/withdraw", async (c) => {
    const outcome = await withdrawArtifactAsOperator(deps.db, c.req.param("id"));
    return outcome === "not_found"
      ? fail(c, 404, "not_found", "no artifact awaiting approval has that id")
      : ok(c, { withdrawn: true });
  });

  return router;
};
