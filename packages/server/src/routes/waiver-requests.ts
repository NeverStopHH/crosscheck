/**
 * /api/waiver-requests — what an api key may still do about a fence
 * (1.0 spec 04a §6):
 *
 *   POST /api/waiver-requests              ask for one; opens nothing
 *   POST /api/waiver-requests/:id/withdraw take your own question back
 *   GET  /api/waiver-requests?repo=        what is asked, and how it was answered
 *
 * The key behind `developerAuth` is held by the developer and by every agent
 * on their machine, so it can ASK and nothing more. The answer names the page
 * where a person approves with a passkey; `crosscheck pin waive` prints it.
 */
import { Hono } from "hono";
import { z } from "zod";
import { WaiverRequestSchema } from "@crosscheck/schema";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues, readJsonBody } from "../http/request.ts";
import { developerAuth } from "../middleware/auth.ts";
import { listRequests, requestWaiver, withdrawRequest } from "../services/waiver-requests.ts";
import type { AppDeps, AppEnv } from "../types.ts";
import { WAIVER_REQUEST_SENTENCE } from "./waiver-sentences.ts";

/** Where a person approves; relative, because only the client knows the hub's origin. */
export const WAIVER_APPROVAL_PATH = "/ui/waivers";

const ListQuerySchema = z.object({ repo: z.string().min(1).optional() });

export const waiverRequestRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  router.post("/", async (c) => {
    const parsed = WaiverRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const outcome = await requestWaiver({
      db: deps.db,
      repo: parsed.data.repo,
      pinId: parsed.data.pinId,
      pinVersion: parsed.data.pinVersion,
      requestedBy: c.get("developer").id,
      reason: parsed.data.reason,
      expiresAt: new Date(parsed.data.expiresAt),
      now: deps.now(),
    });
    return "refusal" in outcome
      ? fail(c, 422, outcome.refusal, WAIVER_REQUEST_SENTENCE[outcome.refusal])
      : ok(c, { id: outcome.id, approvePath: WAIVER_APPROVAL_PATH }, 201);
  });

  router.post("/:id/withdraw", async (c) => {
    const outcome = await withdrawRequest({
      db: deps.db,
      requestId: c.req.param("id"),
      developerId: c.get("developer").id,
      now: deps.now(),
    });
    return "refusal" in outcome
      ? fail(c, 422, outcome.refusal, WAIVER_REQUEST_SENTENCE[outcome.refusal])
      : ok(c, { withdrawn: true });
  });

  router.get("/", async (c) => {
    const parsed = ListQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    // READ IS OPEN TO ANY MEMBER, the fence-waivers asymmetry: everybody a
    // fence affects may see that somebody asked to open it.
    return ok(c, {
      requests: await listRequests({ db: deps.db, repo: parsed.data.repo ?? null, now: deps.now() }),
    });
  });

  return router;
};
