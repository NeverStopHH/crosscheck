/**
 * /api/landed — the why behind a landed change (docs/1.0/landed-changes.md,
 * step 3). Two reads, both POST because their input is author addresses,
 * which do not belong in URLs:
 *
 * - POST /api/landed/context: for the commits a pre-edit stop names, the
 *   teammate work on the file behind each (services/landed-context.ts says
 *   how, and why it is a probable match).
 * - POST /api/landed/authors: which of these addresses belong to nobody on
 *   this hub — `doctor`'s half of decision 7.
 */
import { Hono } from "hono";

import { LandedAuthorsRequestSchema, LandedContextRequestSchema } from "@crosscheck/schema";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues, readJsonBody } from "../http/request.ts";
import { developerAuth } from "../middleware/auth.ts";
import { findLandedContexts, unknownAuthorEmails } from "../services/landed-context.ts";
import type { AppDeps, AppEnv } from "../types.ts";

export const landedRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  router.post("/context", async (c) => {
    const parsed = LandedContextRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const matches = await findLandedContexts(deps, c.get("developer").id, parsed.data);
    return ok(c, { matches });
  });

  router.post("/authors", async (c) => {
    const parsed = LandedAuthorsRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    return ok(c, { unknown: await unknownAuthorEmails(deps, parsed.data.emails) });
  });

  return router;
};
