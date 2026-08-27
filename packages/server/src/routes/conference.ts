/**
 * GET /api/conference — everything one `crosscheck conference` run may read
 * (VISION.md §2): the repo's recent unmerged work contexts with their DECLARED
 * claims, the pairs of them standing on the same ground, the open questions
 * nobody has answered, and the contradiction candidates worth refereeing.
 *
 * NO PARAMETERS BEYOND THE REPO, like /api/ghost-checks and for the same
 * reason: every bound is the hub's, so a client cannot widen the slice, raise
 * a limit, or ask for somebody else's view by sending different arguments.
 *
 * ONE ANSWER RATHER THAN FOUR CALLS on purpose. A conference has a wall-clock
 * cap and prints a cost estimate before it spends anything; assembling its
 * corpus out of four round trips would make both of those depend on how many
 * of the four came back.
 */
import { Hono } from "hono";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues } from "../http/request.ts";
import { RepoQuerySchema } from "../http/schemas.ts";
import { developerAuth } from "../middleware/auth.ts";
import { readConference } from "../services/conference.ts";
import type { AppDeps, AppEnv } from "../types.ts";

export const conferenceRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  router.get("/", async (c) => {
    const parsed = RepoQuerySchema.safeParse({ repo: c.req.query("repo") });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const conference = await readConference(
      deps,
      c.get("developer").id,
      parsed.data.repo,
    );
    return ok(c, { conference });
  });

  return router;
};
