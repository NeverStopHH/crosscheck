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
 * THE HUMAN GATE IS HUB-SIDE, on BOTH writing routes, and it is a gate on
 * EVIDENCE rather than on a verdict. `PinSchema` demands `presence:
 * "controlling_terminal"` — what the client observed — and the hub stamps the
 * stored capture mode itself; the retraction demands the same field plus the
 * repo it speaks for. A body that omits either fails validation here, before
 * anything reaches the database.
 *
 * WHY BOTH, and why the retraction most of all: `/:id/broke` is the falsifier
 * `crosscheck suspect` reads before it names a single session, and it used to
 * take an EMPTY body from any key with no hub-side check whatsoever — so an
 * agent could unlock attribution on its own word while the only gate sat in
 * a CLI it never had to run.
 *
 * WHAT THE GATE IS WORTH, stated rather than implied. A bearer key that can
 * reach these routes can also send the field, and that key sits in plaintext
 * in ~/.crosscheck/config.json. This makes the claim explicit, required and
 * refusable AT THE HUB — where every other gate in this product lives — and
 * it does not make it unforgeable by an attacker who already holds the key.
 * `pin list` therefore prints WHO vouched, and `suspect` prints who recorded
 * the retraction, so a forged claim is at least an attributable one.
 */
import { Hono } from "hono";
import { z } from "zod";
import {
  COMMIT_SHA_PATTERN,
  MAX_PIN_PATH_CHARS,
  MAX_PIN_SWEEP_UPDATES,
  NO_COMMIT_SHA,
  MAX_RECORD_ID_LENGTH,
  PIN_PRESENCE_TERMINAL,
  PinSchema,
  SAFE_ID_PATTERN,
  describeUnstorableText,
  repoRelativePath,
  unstorableTextPath,
} from "@crosscheck/schema";

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
        // The NEW path is stored, so it takes the one spelling (01a §3.3d).
        // The old one is a lookup key for a row already stored, possibly in a
        // pre-canonical spelling, so it is matched as sent.
        newPath: repoRelativePath.nullable(),
      }),
    )
    .max(MAX_PIN_SWEEP_UPDATES),
});

const PinIdSchema = z
  .string()
  .min(1)
  .max(MAX_RECORD_ID_LENGTH)
  .regex(SAFE_ID_PATTERN);

/**
 * The retraction body. The repo scopes the UPDATE, and `presence` is the same
 * evidence field a pin's creation carries — this route unlocks naming
 * people, so it takes the STRONGER of the two gates, never none.
 */
const BreakBodySchema = z.object({
  repo: z.string().min(1),
  presence: z.literal(PIN_PRESENCE_TERMINAL),
  /**
   * The reader's HEAD when the check failed (07 §3.4). Optional so an older
   * CLI still retracts; its break is then counted by proof 3, never scored.
   * The commit alphabet only — this value reaches `git diff` on every reader's
   * machine that runs `crosscheck pilot`.
   */
  brokeAtCommit: z.string().regex(COMMIT_SHA_PATTERN).optional(),
});

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
      await applyPinSweep(
        deps,
        c.get("developer").id,
        parsed.data.repo,
        parsed.data.updates,
      ),
    );
  });

  router.post("/:id/broke", async (c) => {
    const id = PinIdSchema.safeParse(c.req.param("id"));
    if (!id.success) {
      return fail(c, 400, "validation_failed", formatIssues(id.error));
    }
    const parsed = BreakBodySchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return fail(
        c,
        400,
        "validation_failed",
        `${formatIssues(parsed.error)} — retracting a pin is what lets crosscheck suspect name sessions, so it needs the repo and evidence a person ran the check at a terminal`,
      );
    }
    const outcome = await markPinBroke(
      deps,
      c.get("developer").id,
      parsed.data.repo,
      id.data,
      parsed.data.brokeAtCommit === undefined ||
        parsed.data.brokeAtCommit === NO_COMMIT_SHA
        ? null
        : parsed.data.brokeAtCommit,
    );
    if (outcome === "not_found") {
      return fail(c, 404, "not_found", "no pin with that id in this repo");
    }
    return ok(c, { id: id.data });
  });

  return router;
};
