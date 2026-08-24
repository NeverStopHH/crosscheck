/**
 * /api/settings — a developer's OWN privacy settings (DESIGN.md §2.1):
 * presence opt-out and the mute list. Self-service only: every handler
 * operates on the authenticated developer, and no admin surface can toggle
 * another person's visibility. Enforcement of what these settings hide lives
 * in services/visibility.ts.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Context } from "hono";

import { fail, ok } from "../http/envelope.ts";
import { readJsonBody, formatIssues } from "../http/request.ts";
import { developerAuth } from "../middleware/auth.ts";
import {
  addMute,
  getDeveloperSettings,
  removeMute,
  setPresenceOptOut,
} from "../services/developer-settings.ts";
// One bound for one concept: a reference too long to mute must not be short
// enough to filter a search by (services/developer-lookup.ts).
import { MAX_DEVELOPER_REF_CHARS } from "../services/developer-lookup.ts";
import type { AppDeps, AppEnv } from "../types.ts";

const PresenceBodySchema = z.object({ optOut: z.boolean() });

const MuteBodySchema = z.object({
  developer: z.string().min(1).max(MAX_DEVELOPER_REF_CHARS),
});

/** The resolution failures shared by mute and unmute, mapped once. */
const failForResolution = (
  c: Context<AppEnv>,
  outcome: "not_found" | "ambiguous",
) =>
  outcome === "not_found"
    ? fail(c, 404, "not_found", "no developer matches that reference")
    : fail(
        c,
        409,
        "ambiguous_developer",
        "several developers share that name — use their email or id",
      );

export const settingsRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  router.get("/", async (c) => {
    const settings = await getDeveloperSettings(deps.db, c.get("developer").id);
    return ok(c, settings);
  });

  router.put("/presence", async (c) => {
    const parsed = PresenceBodySchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    await setPresenceOptOut(
      deps.db,
      c.get("developer").id,
      parsed.data.optOut,
    );
    return ok(c, { presenceOptOut: parsed.data.optOut });
  });

  router.post("/mutes", async (c) => {
    const parsed = MuteBodySchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const result = await addMute(
      deps,
      c.get("developer").id,
      parsed.data.developer,
    );
    switch (result.outcome) {
      case "not_found":
      case "ambiguous":
        return failForResolution(c, result.outcome);
      case "self":
        return fail(c, 400, "validation_failed", "you cannot mute yourself");
      case "limit_reached":
        return fail(
          c,
          409,
          "mute_limit_reached",
          "your mute list is full — unmute someone first",
        );
      case "muted":
        return ok(c, {
          muted: result.developer,
          alreadyMuted: result.alreadyMuted,
        });
    }
  });

  router.delete("/mutes/:ref", async (c) => {
    const ref = c.req.param("ref");
    if (ref.length === 0 || ref.length > MAX_DEVELOPER_REF_CHARS) {
      return fail(c, 400, "validation_failed", "invalid developer reference");
    }
    const result = await removeMute(deps.db, c.get("developer").id, ref);
    switch (result.outcome) {
      case "not_found":
      case "ambiguous":
        return failForResolution(c, result.outcome);
      case "unmuted":
        return ok(c, {
          unmuted: result.developer,
          wasMuted: result.wasMuted,
        });
    }
  });

  return router;
};
