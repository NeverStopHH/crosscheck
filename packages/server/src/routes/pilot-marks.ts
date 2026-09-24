/**
 * POST /api/pilot-marks — the one human input the pilot takes (07 §3.2).
 *
 * A ROUTE OF ITS OWN rather than a record kind on `POST /api/records`, and
 * for the reason pins and fence waivers already established: the spool is
 * fire-and-forget, and a person who typed `crosscheck noise` needs the answer
 * — "recorded", "you already said that", "no delivery with that id" — in
 * their terminal, synchronously. A mark dropped silently into a ledger is a
 * gesture that appears to do nothing, which is the fastest way to teach a
 * team to stop making it.
 *
 * NOT `requireAdmin`. A mark is one person's word about one intervention they
 * received; routing it through whoever runs the hub would make the pilot's
 * only human signal the opinion of one person.
 *
 * THE HUMAN GATE IS HUB-SIDE, and it is a gate on EVIDENCE rather than on a
 * verdict — #50's pin rule, inherited. The body states what the client
 * observed (`presence: controlling_terminal`); the hub stamps `capture_mode`
 * itself. What that is worth is stated rather than implied: a bearer key that
 * reaches this route can send the field too, and that key sits in plaintext
 * in `~/.crosscheck/config.json`. The gate makes the claim explicit, required
 * and refusable AT THE HUB; it does not make it unforgeable. Every row names
 * who marked it, so a forged mark is at least an attributable one.
 */
import { Hono } from "hono";
import { z } from "zod";
import { PilotMarkSchema } from "@crosscheck/schema";

import { NOISE_MARK_MAX_SESSIONS, PILOT_RETENTION_DAYS } from "../constants.ts";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues, readJsonBody } from "../http/request.ts";
import { developerAuth } from "../middleware/auth.ts";
import { writePilotMark } from "../services/pilot.ts";
import { readMarkCandidates } from "../services/pilot-candidates.ts";
import type { MarkRefusal } from "../services/pilot.ts";
import type { AppDeps, AppEnv } from "../types.ts";

const HTTP_OK = 200;
const HTTP_CREATED = 201;

const MINUTES_PER_DAY = 1440;

/**
 * THE WIDEST WINDOW IS RETENTION. A delivery older than that is gone, and a
 * window reaching past it would promise candidates the table cannot hold.
 * Omitted means that widest window: a person who names the ref they saw is
 * looking for THAT delivery, however long ago it arrived.
 */
const MAX_WINDOW_MINUTES = PILOT_RETENTION_DAYS * MINUTES_PER_DAY;

const CandidatesQuerySchema = z.object({
  repo: z.string().min(1),
  sessions: z.array(z.string().min(1)).max(NOISE_MARK_MAX_SESSIONS),
  ref: z.string().min(1).optional(),
  withinMinutes: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_WINDOW_MINUTES)
    .default(MAX_WINDOW_MINUTES),
});

/**
 * ONE SENTENCE PER REFUSAL, chosen by an enum the service returns.
 *
 * The service never writes prose and this never invents a reason. Each says
 * what to do next, because a person typed the command that produced it and a
 * refusal nobody can act on is the same as silence.
 */
const REFUSAL_SENTENCE: Record<MarkRefusal, string> = {
  not_enrolled:
    "this repo is not in the pilot, so nothing is being measured — ask whoever runs the hub to enrol it, or leave it as it is",
  // ALSO the answer for a delivery that exists but reached somebody else:
  // a separate sentence would tell the asker what a colleague was shown.
  unknown_ref:
    "nothing with that id reached you on this repo — `crosscheck noise` with no argument finds the most recent one for you",
  wrong_repo:
    "that id belongs to another repo; marks are repo-scoped, because one team's noise is not another's",
  not_unsolicited:
    "that was an answer somebody asked for; a noise mark is for what arrived without being asked",
  pin_broken:
    "that pin is recorded broken; if you fixed it, pin that surface again — a new pin on the same surface records the fix and links it to the break",
};

export const pilotMarkRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();

  /**
   * WHICH DELIVERY `crosscheck noise` MEANS — the caller's own, unasked,
   * recent (services/pilot-candidates.ts). A read, but refused on a repo
   * that never enrolled, for the reason the mark itself is: the next step
   * would be refused, and a list of things nobody may mark is a dead end.
   */
  router.get("/candidates", developerAuth(deps), async (c) => {
    const parsed = CandidatesQuerySchema.safeParse({
      repo: c.req.query("repo"),
      sessions: c.req.queries("session") ?? [],
      ref: c.req.query("ref"),
      withinMinutes: c.req.query("withinMinutes"),
    });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const outcome = await readMarkCandidates(deps, {
      repo: parsed.data.repo,
      developerId: c.get("developer").id,
      sessions: parsed.data.sessions,
      ref: parsed.data.ref ?? null,
      withinMinutes: parsed.data.withinMinutes,
    });
    if ("refusal" in outcome) {
      return fail(c, 422, outcome.refusal, REFUSAL_SENTENCE[outcome.refusal]);
    }
    return ok(c, outcome);
  });

  router.post("/", developerAuth(deps), async (c) => {
    const parsed = PilotMarkSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      // The presence literal fails HERE, before anything reaches the
      // database: an absent or unknown value is a parse failure, never a
      // default.
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const outcome = await writePilotMark(deps, {
      repo: parsed.data.repo,
      refKind: parsed.data.refKind,
      refId: parsed.data.refId,
      mark: parsed.data.mark,
      markedBy: c.get("developer").id,
    });
    if ("refusal" in outcome) {
      return fail(c, 422, outcome.refusal, REFUSAL_SENTENCE[outcome.refusal]);
    }
    // 200 AND NOT 201 ON A REPEAT, because nothing was created — and the
    // caller is told WHICH it was rather than having to infer it from a
    // status code that would otherwise be identical either way.
    return ok(
      c,
      { id: outcome.id, repeated: outcome.repeated },
      outcome.repeated ? HTTP_OK : HTTP_CREATED,
    );
  });

  return router;
};
