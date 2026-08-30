/**
 * /api/team-settings — the regression guard's two TEAM decisions
 * (regression-guard Stage 1):
 *
 *   GET /api/team-settings?repo=…   what this repo is set to (any member)
 *   PUT /api/team-settings          change it (admin token)
 *
 * READ IS OPEN, WRITE IS ADMIN, and the asymmetry is the point. Everybody
 * affected by "suspect names sessions" has to be able to see that it does —
 * `crosscheck status` prints the effective value — while flipping it is a
 * decision about the team, not a preference of whoever typed the command.
 * Personal preferences live on /api/settings (presence opt-out, mutes) and
 * are self-service; these two are not personal.
 *
 * The admin token is the only "who decides" crosscheck has today. It is held
 * by whoever runs the hub, which in a works-council context is the same
 * person who would be answering for the tool — the right hands, even if a
 * richer role model arrives later.
 */
import { Hono } from "hono";
import { z } from "zod";
import { TEAM_PIN_POLICIES, TEAM_SUSPECT_ATTRIBUTIONS } from "@crosscheck/schema";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues, readJsonBody } from "../http/request.ts";
import { developerAuth, requireAdmin } from "../middleware/auth.ts";
import { readTeamSettings, writeTeamSettings } from "../services/team-settings.ts";
import type { AppDeps, AppEnv } from "../types.ts";

const RepoQuerySchema = z.object({ repo: z.string().min(1) });

const WriteBodySchema = z
  .object({
    repo: z.string().min(1),
    pinPolicy: z.enum(TEAM_PIN_POLICIES).optional(),
    suspectAttribution: z.enum(TEAM_SUSPECT_ATTRIBUTIONS).optional(),
  })
  .refine(
    (body) =>
      body.pinPolicy !== undefined || body.suspectAttribution !== undefined,
    { message: "name at least one setting to change" },
  );

export const teamSettingsRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();

  router.get("/", developerAuth(deps), async (c) => {
    const parsed = RepoQuerySchema.safeParse({ repo: c.req.query("repo") });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    return ok(c, await readTeamSettings(deps, parsed.data.repo));
  });

  router.put("/", requireAdmin(deps.adminToken), async (c) => {
    const parsed = WriteBodySchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    return ok(
      c,
      await writeTeamSettings(deps, {
        repo: parsed.data.repo,
        ...(parsed.data.pinPolicy === undefined
          ? {}
          : { pinPolicy: parsed.data.pinPolicy }),
        ...(parsed.data.suspectAttribution === undefined
          ? {}
          : { suspectAttribution: parsed.data.suspectAttribution }),
      }),
    );
  });

  return router;
};
