/**
 * GET /api/suspect — "who was in there, and what did they say they were
 * doing" (regression-guard Stage 1).
 *
 * ONE VERB, TWO SCOPES: `?pin=<id>` reads the pin's file set and its
 * falsifier state; `?path=a&path=b` lets a reader name files with no pin at
 * all, which is how this works on day one, before anybody has pinned
 * anything.
 *
 * THE GATES ARE HUB-SIDE, all of them. The falsifier ("has anybody run this
 * pin's check and watched it fail?") and this team's attribution setting are
 * decided in the service, never by the caller: a client-side check on whether
 * a name may be printed is a client-side promise, and this is the one surface
 * in the product where being wrong costs somebody an accusation.
 */
import { Hono } from "hono";
import { z } from "zod";
import { MAX_PIN_PATH_CHARS, MAX_RECORD_ID_LENGTH, SAFE_ID_PATTERN } from "@crosscheck/schema";

import { SUSPECT_MAX_PATHS } from "../constants.ts";
import { fail, ok } from "../http/envelope.ts";
import { formatIssues } from "../http/request.ts";
import { developerAuth } from "../middleware/auth.ts";
import { resolveSuspectScope, suspectSessions } from "../services/suspect.ts";
import { readTeamSettings } from "../services/team-settings.ts";
import type { AppDeps, AppEnv } from "../types.ts";

const QuerySchema = z.object({
  repo: z.string().min(1),
  pin: z
    .string()
    .min(1)
    .max(MAX_RECORD_ID_LENGTH)
    .regex(SAFE_ID_PATTERN)
    .optional(),
  // Bounded here rather than in the service: an unbounded path list is the
  // one way a caller could make this query's cost their own choice.
  paths: z.array(z.string().min(1).max(MAX_PIN_PATH_CHARS)).max(SUSPECT_MAX_PATHS),
});

export const suspectRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  router.get("/", async (c) => {
    const parsed = QuerySchema.safeParse({
      repo: c.req.query("repo"),
      pin: c.req.query("pin"),
      paths: c.req.queries("path") ?? [],
    });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    if (parsed.data.pin === undefined && parsed.data.paths.length === 0) {
      return fail(
        c,
        400,
        "validation_failed",
        "name a pin (pin=<id>) or at least one file (path=…) — suspect intersects a surface with recorded work, so it needs the surface",
      );
    }
    const scope = await resolveSuspectScope(deps, parsed.data.repo, {
      ...(parsed.data.pin === undefined ? {} : { pinId: parsed.data.pin }),
      paths: parsed.data.paths,
    });
    if (!scope.ok) {
      return scope.reason === "pin_not_found"
        ? fail(c, 404, "not_found", "no pin with that id")
        : fail(
            c,
            400,
            "repo_mismatch",
            "that pin belongs to another repo — pins are repo-scoped, and a cross-repo intersection would rank sessions that could not have touched it",
          );
    }
    const settings = await readTeamSettings(deps, parsed.data.repo);
    return ok(
      c,
      await suspectSessions(deps, c.get("developer").id, {
        repo: parsed.data.repo,
        scope: scope.scope,
        attribution: settings.suspectAttribution,
      }),
    );
  });

  return router;
};
