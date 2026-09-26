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
 *
 * And the author's notice (step 4): the context answer also names who the
 * stop tells (`told`), and GET /api/landed/notices lists the notices waiting
 * for the caller in a repo (services/landed-notices.ts).
 */
import { Hono } from "hono";
import { z } from "zod";

import { LandedAuthorsRequestSchema, LandedContextRequestSchema, LandedRepoSchema } from "@crosscheck/schema";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues, readJsonBody } from "../http/request.ts";
import { developerAuth } from "../middleware/auth.ts";
import { findLandedContexts, toldAuthors, unknownAuthorEmails } from "../services/landed-context.ts";
import { listLandedNotices } from "../services/landed-notices.ts";
import type { AppDeps, AppEnv } from "../types.ts";

const NoticesQuerySchema = z.object({ repo: LandedRepoSchema });

export const landedRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  router.post("/context", async (c) => {
    const parsed = LandedContextRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const [matches, told] = await Promise.all([
      findLandedContexts(deps, c.get("developer").id, parsed.data),
      toldAuthors(deps, c.get("developer").id, parsed.data),
    ]);
    return ok(c, { matches, told });
  });

  router.post("/authors", async (c) => {
    const parsed = LandedAuthorsRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    return ok(c, { unknown: await unknownAuthorEmails(deps, parsed.data.emails) });
  });

  router.get("/notices", async (c) => {
    const parsed = NoticesQuerySchema.safeParse({ repo: c.req.query("repo") });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    return ok(c, { notices: await listLandedNotices(deps, c.get("developer").id, parsed.data.repo) });
  });

  return router;
};
