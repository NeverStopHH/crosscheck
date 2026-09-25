/**
 * `POST /api/keys/rotate` — a developer replaces their OWN api key.
 *
 * Authorised by the current key and nothing else — the one remedy a leaked
 * key needs that its owner can apply without waiting for an admin. That is
 * not free: whoever holds a leaked key can already act as this developer,
 * and by rotating FIRST they also lock the owner out (the owner's stored key,
 * web sessions and own `key rotate` all die with it). The hub has no second
 * factor to tell the two apart, so every rotation is in the ledger and the
 * team feed (`developer_key_rotated`, by self or admin), and the admin route
 * (`POST /api/developers/:id/key`) is the way back. The new key is in the
 * response exactly once; the hub keeps only its hash.
 *
 * A rotation that lost a race on the same old key is a 409, not a second
 * key: the conditional write in services/developers.ts lets exactly one of
 * them land, and the loser must never walk away holding a key that the
 * winner's write overwrote a moment later.
 */
import { Hono } from "hono";

import { fail, ok } from "../http/envelope.ts";
import { bearerToken, developerAuth } from "../middleware/auth.ts";
import { rotateDeveloperKey } from "../services/developers.ts";
import type { AppDeps, AppEnv } from "../types.ts";

export const keysRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  router.post("/rotate", async (c) => {
    const presented = bearerToken(c.req.header("Authorization"));
    if (presented === null) {
      return fail(c, 401, "unauthorized", "missing bearer api key");
    }
    const result = await rotateDeveloperKey(deps, {
      developerId: c.get("developer").id,
      by: "self",
      presentedKey: presented,
    });
    switch (result.outcome) {
      case "rotated":
        return ok(c, { apiKey: result.apiKey });
      case "already_rotated":
        return fail(
          c,
          409,
          "key_already_rotated",
          "this key was rotated by another request a moment ago — use the key that request returned, or ask an admin to rotate it",
        );
      case "not_found":
        return fail(c, 401, "unauthorized", "unknown api key");
    }
  });

  return router;
};
