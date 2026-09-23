/**
 * /api/fence-waivers — who may open a human-verified fence, and on what terms
 * (1.0 spec 04 §3.6):
 *
 *   POST /api/fence-waivers            open one, for a bounded time
 *   POST /api/fence-waivers/:id/revoke close it again
 *   GET  /api/fence-waivers?repo=&pin= what the record says
 *
 * A ROUTE OF ITS OWN rather than a record kind on `POST /api/records`, and the
 * reason pins already established: the spool is fire-and-forget, and a person
 * who typed the command needs the refusal — "that date is beyond the ceiling",
 * "that waiver is already revoked" — in their terminal, synchronously, not
 * silently dropped into a ledger. A waiver can also be typed by somebody with
 * no agent session at all, so there is no session to hang it on.
 *
 * NOT `requireAdmin`, deliberately. The admin token is the TEAM'S decision
 * surface — it flips whether `suspect` names sessions at all. A waiver is one
 * behaviour in one repo, decided by whoever is carrying that work, and routing
 * it through an admin would make the fence useless: nobody would ask.
 *
 * THE HUMAN GATE IS HUB-SIDE ON BOTH WRITES, and it is a gate on EVIDENCE
 * rather than on a verdict — #50's pin rule copied with its stated limit. The
 * body says what the client OBSERVED (`presence: controlling_terminal`); the
 * hub stamps `capture_mode` itself. A body that could say "human" would be a
 * caller asserting the permission into existence.
 *
 * WHAT THE GATE IS WORTH, stated rather than implied: a bearer key that reaches
 * these routes can send the field too, and that key sits in plaintext in
 * `~/.crosscheck/config.json`. This makes the claim explicit, required and
 * refusable AT THE HUB, where every other gate in this product lives. It does
 * not make it unforgeable by an attacker who already holds the key — which is
 * why every row names who granted it, so a forged permission is at least an
 * attributable one.
 */
import { Hono } from "hono";
import { z } from "zod";
import { WaiverGrantSchema, WaiverRevokeSchema } from "@crosscheck/schema";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues, readJsonBody } from "../http/request.ts";
import { developerAuth } from "../middleware/auth.ts";
import { grantWaiver, listWaivers, revokeWaiver } from "../services/waivers.ts";
import type { WaiverRefusal } from "../services/waivers.ts";
import type { AppDeps, AppEnv } from "../types.ts";

const ListQuerySchema = z.object({
  repo: z.string().min(1),
  pin: z.string().min(1).optional(),
});

/**
 * ONE SENTENCE PER REFUSAL, chosen by an enum the service returns.
 *
 * The service never writes prose and this never invents a reason: a refusal a
 * person reads in their terminal is a sentence somebody wrote on purpose, and
 * the mapping is where it lives. Two are deliberately the same shape — a
 * waiver in another repo and a waiver that does not exist both answer
 * "unknown", because telling a caller that something EXISTS somewhere they
 * cannot see is itself a disclosure.
 */
const REFUSAL_SENTENCE: Record<WaiverRefusal, string> = {
  unknown_pin: "no pin with that id exists on this repo",
  wrong_repo: "that pin belongs to another repo",
  expiry_in_the_past:
    "that expiry has already passed — the waiver would be closed on arrival",
  expiry_beyond_ceiling:
    "that expiry is further out than a waiver may reach; grant a shorter one, and grant again if it is still needed",
  unknown_waiver: "no waiver with that id exists on this repo",
  not_a_grant: "that row is a revocation, not a grant",
  already_revoked: "that waiver has already been revoked",
};

export const fenceWaiverRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();

  router.post("/", developerAuth(deps), async (c) => {
    const parsed = WaiverGrantSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      // The presence literal fails HERE, before anything reaches the database:
      // an absent or unknown value is a parse failure, never a default.
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const outcome = await grantWaiver({
      db: deps.db,
      repo: parsed.data.repo,
      pinId: parsed.data.pinId,
      pinVersion: parsed.data.pinVersion,
      grantedBy: c.get("developer").id,
      reason: parsed.data.reason,
      expiresAt: new Date(parsed.data.expiresAt),
      now: deps.now(),
    });
    return "refusal" in outcome
      ? fail(c, 422, outcome.refusal, REFUSAL_SENTENCE[outcome.refusal])
      : ok(c, { id: outcome.id }, 201);
  });

  router.post("/:id/revoke", developerAuth(deps), async (c) => {
    const parsed = WaiverRevokeSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const outcome = await revokeWaiver({
      db: deps.db,
      repo: parsed.data.repo,
      waiverId: c.req.param("id"),
      grantedBy: c.get("developer").id,
      reason: parsed.data.reason,
      now: deps.now(),
    });
    return "refusal" in outcome
      ? fail(c, 422, outcome.refusal, REFUSAL_SENTENCE[outcome.refusal])
      : ok(c, { id: outcome.id }, 201);
  });

  router.get("/", developerAuth(deps), async (c) => {
    const parsed = ListQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    // READ IS OPEN TO ANY MEMBER — the asymmetry team-settings already uses.
    // Everybody affected by an open fence has to be able to see that it is
    // open, and by whom.
    return ok(c, {
      waivers: await listWaivers({
        db: deps.db,
        repo: parsed.data.repo,
        pinId: parsed.data.pin ?? null,
        now: deps.now(),
      }),
    });
  });

  return router;
};
