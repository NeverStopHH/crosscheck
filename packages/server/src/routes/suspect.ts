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

import { SUSPECT_MAX_PATHS, SUSPECT_WINDOW_DAYS } from "../constants.ts";
import { fail, ok } from "../http/envelope.ts";
import { formatIssues } from "../http/request.ts";
import { developerAuth } from "../middleware/auth.ts";
import { readCoverage } from "../services/coverage.ts";
import { resolveSuspectScope, suspectSessions } from "../services/suspect.ts";
import { readTeamSettings } from "../services/team-settings.ts";
import { computeVerdict } from "../services/verdict.ts";
import { readLiveWaiver } from "../services/waivers.ts";
import type { AppDeps, AppEnv } from "../types.ts";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
    // 03 §3.5 and §3.2a. The verdict layer reads this record, and it is
    // SCOPED TO THE FILES THE QUESTION IS ABOUT: "were we watching this
    // surface" is the question principle 1 actually asks, and a repo-wide
    // gap would make every answer here INDETERMINATE for ever.
    const [view, coverage] = await Promise.all([
      suspectSessions(deps, c.get("developer").id, {
        repo: parsed.data.repo,
        scope: scope.scope,
        attribution: settings.suspectAttribution,
      }),
      readCoverage(deps, c.get("developer").id, parsed.data.repo, {
        scope: {
          sinceIso: new Date(
            deps.now().getTime() - SUSPECT_WINDOW_DAYS * MS_PER_DAY,
          ).toISOString(),
          paths: scope.scope.files,
        },
      }),
    ]);
    // THE VERDICT RIDES AS A SIBLING FIELD (04 §5), the shape 03 §3.5 uses for
    // coverage — never folded into the suspect view, because the five
    // dimensions are separate on purpose and a nested one invites a renderer
    // to read the outer answer and skip the rest.
    const invariant =
      scope.scope.pinId === null || scope.scope.pinVersion === null
        ? null
        : { pinId: scope.scope.pinId, version: scope.scope.pinVersion };
    const liveWaiver =
      invariant === null
        ? null
        : await readLiveWaiver({
            db: deps.db,
            repo: parsed.data.repo,
            pinId: invariant.pinId,
            pinVersion: invariant.version,
            now: deps.now(),
          });
    const verdict = computeVerdict({
      repo: parsed.data.repo,
      suspect: view,
      coverage,
      // THE PIN LANE. This route asks about a SURFACE, not a commit, and 05's
      // deltas are about a commit's tests — so there is nothing here to read
      // one from. `deltaLane: "ci"` is reachable from the CI verdict surface,
      // not from this one.
      delta: null,
      deltaLane: "pin",
      // 06's answer needs a work context, and a surface is not one. The spec
      // says this degrades to `absent` / `no_intent` rather than guessing, and
      // timing is carried never weighed, so a missing one changes no other
      // dimension.
      timing: "absent",
      timingReason: "no_intent",
      // 08's axes resolve a CLAIM's verification ref, and a surface has no
      // claim. So `unsupported` / `no_verification_ref` is the honest reading,
      // and it is the one 04 §9 names for a hub without 08.
      //
      // REFUSED, deliberately: mapping the pin's own check recipe onto
      // `tool_observed` would invent a third ref kind, which 08 §8.5 declines
      // in the same words for profiler traces and benchmarks. A recipe is an
      // instruction to a human, not a machine-produced observation.
      evidence: {
        who: "agent_derived",
        support: "unsupported",
        supportReason: "no_verification_ref",
        observedAt: null,
        verifiedAtCommit: null,
      },
      invariant,
      liveWaiver,
      now: deps.now(),
    });
    return ok(c, { ...view, coverage, verdict });
  });

  return router;
};
