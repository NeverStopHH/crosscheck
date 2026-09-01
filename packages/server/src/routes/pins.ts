/**
 * /api/pins — the pin registry's HTTP surface (regression-guard Stage 1):
 *
 *   POST /api/pins             register a surface as working (humans only)
 *   GET  /api/pins?repo=…      the repo's registry + its coverage denominator
 *   POST /api/pins/:id/broke   retract a pin: the check was run and failed
 *
 * A ROUTE OF ITS OWN rather than a record kind on `POST /api/records`, and
 * the reason is the same one questions have: the spool is fire-and-forget, and
 * a person who typed `crosscheck pin` needs the refusal — "an agent may not
 * vouch for a human", "this pin needs a check recipe" — in their terminal,
 * synchronously, not silently dropped into a ledger.
 *
 * THE HUMAN GATE IS THE SCHEMA. `PinSchema` demands the literal capture mode
 * "human"; a body that omits it or sends "agent" fails validation here, before
 * anything reaches the database. That is the whole of the fail-closed rule on
 * this side of the wire — the CLI's side is that it only sends "human" when a
 * person is demonstrably at a terminal (packages/cli/src/cli/pin.ts).
 */
import { Hono } from "hono";
import { z } from "zod";
import {
  MAX_PIN_PATH_CHARS,
  MAX_RECORD_ID_LENGTH,
  PinSchema,
  SAFE_ID_PATTERN,
  describeUnstorableText,
  unstorableTextPath,
} from "@crosscheck/schema";

import { MAX_PIN_SWEEP_UPDATES } from "../constants.ts";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues, readJsonBody } from "../http/request.ts";
import { developerAuth } from "../middleware/auth.ts";
import {
  applyPinSweep,
  createPin,
  listPins,
  markPinBroke,
  untouchedByDeveloper,
} from "../services/pins.ts";
import { readTeamSettings } from "../services/team-settings.ts";
import type { AppDeps, AppEnv } from "../types.ts";

const RepoQuerySchema = z.object({ repo: z.string().min(1) });

/** The one path shape a target can have — mirrored from PinSchema's rule. */
const PinPathSchema = z
  .string()
  .min(1)
  .max(MAX_PIN_PATH_CHARS)
  .refine(
    (path) => !path.startsWith("/") && !path.includes("..") && !path.includes("\\"),
    { message: "path is not repo-relative POSIX" },
  );

/**
 * The sweep body. Every path is validated with the SAME repo-relative rule
 * `PinSchema` applies, because a sweep that could write an absolute path
 * would let one bad checkout store a pin nothing can ever match again.
 */
const SweepBodySchema = z.object({
  repo: z.string().min(1),
  updates: z
    .array(
      z.object({
        pinId: z.string().min(1).max(MAX_RECORD_ID_LENGTH).regex(SAFE_ID_PATTERN),
        path: PinPathSchema,
        newPath: PinPathSchema.nullable(),
      }),
    )
    .max(MAX_PIN_SWEEP_UPDATES),
});

const PinIdSchema = z
  .string()
  .min(1)
  .max(MAX_RECORD_ID_LENGTH)
  .regex(SAFE_ID_PATTERN);

export const pinsRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  router.post("/", async (c) => {
    const parsed = PinSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    // This route is its OWN boundary: a pin reaches the table straight from
    // here and never through parseRecord, so the storability check that path
    // applies has to be repeated on this one — or the same body is a 500 or a
    // 400 depending only on how it arrived (schema/storable-text.ts).
    const unstorable = unstorableTextPath(parsed.data);
    if (unstorable !== null) {
      return fail(c, 400, "validation_failed", describeUnstorableText(unstorable));
    }
    // WHO MAY PIN is a team setting with an open default (Nick's decision for
    // the trial: anyone pins anything, with the author's name on every row in
    // `status` as the abuse control). A team that has switched to
    // `touched_files` gets the narrower rule, and the refusal names the files
    // so it can be acted on rather than argued with.
    const settings = await readTeamSettings(deps, parsed.data.repo);
    if (settings.pinPolicy === "touched_files") {
      const unseen = await untouchedByDeveloper(
        deps,
        c.get("developer").id,
        parsed.data.repo,
        parsed.data.files,
      );
      if (unseen.length > 0) {
        return fail(
          c,
          403,
          "pin_policy",
          `this team pins only files you have worked in, and this hub has no recorded touch of yours on: ${unseen.join(", ")}`,
        );
      }
    }
    const outcome = await createPin(deps, c.get("developer").id, parsed.data);
    if (outcome.outcome === "duplicate") {
      return fail(
        c,
        409,
        "pin_exists",
        `a pin already exists under id ${parsed.data.id} — pin ids are minted by the caller, so this is a replay or a collision, never an overwrite`,
      );
    }
    return ok(c, { id: outcome.id });
  });

  router.get("/", async (c) => {
    const parsed = RepoQuerySchema.safeParse({ repo: c.req.query("repo") });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    // The registry AND its denominator in one response: a caller that had to
    // ask twice would eventually print one without the other, and "4 pins"
    // with no "nothing else is watched" beside it is the exact sentence this
    // feature exists to stop.
    return ok(c, await listPins(deps, parsed.data.repo));
  });

  // The sweep's RECORDING half. The computing half runs on a developer's
  // machine (connector-core git/pin-sweep.ts), because the hub has no
  // checkout and cannot ask git anything at all. Only path NAMES cross the
  // wire — no file content, ever.
  router.post("/sweep", async (c) => {
    const parsed = SweepBodySchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    return ok(
      c,
      await applyPinSweep(deps, parsed.data.repo, parsed.data.updates),
    );
  });

  router.post("/:id/broke", async (c) => {
    const parsed = PinIdSchema.safeParse(c.req.param("id"));
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const outcome = await markPinBroke(deps, c.get("developer").id, parsed.data);
    if (outcome === "not_found") {
      return fail(c, 404, "not_found", "no pin with that id");
    }
    return ok(c, { id: parsed.data });
  });

  return router;
};
