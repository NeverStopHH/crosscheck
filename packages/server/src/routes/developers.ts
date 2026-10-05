import { Hono } from "hono";
import { z } from "zod";

import { fail, ok } from "../http/envelope.ts";
import { readJsonBody, formatIssues } from "../http/request.ts";
import { CreateDeveloperBodySchema } from "../http/schemas.ts";
import { requireAdmin } from "../middleware/auth.ts";
import {
  addDeveloperEmail,
  cloudAgentRefusal,
  createDeveloper,
  listDeveloperEmails,
  listDevelopers,
  removeDeveloperEmail,
  rotateDeveloperKey,
} from "../services/developers.ts";
import { listPasskeys, mintEnrolmentCode, revokePasskey } from "../services/passkeys.ts";
import type { AppDeps, AppEnv } from "../types.ts";

const AddEmailBodySchema = z.object({ email: z.email() });

/**
 * Admin-only developer bootstrap — the api key is returned exactly once —
 * plus the alias-email surface (trial finding #7): the same admin token
 * links and unlinks the additional git author emails a developer commits
 * under, so absence matching can recognise every one of them.
 */
export const developersRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", requireAdmin(deps.adminToken));

  router.get("/", async (c) => {
    return ok(c, await listDevelopers(deps.db));
  });

  router.post("/", async (c) => {
    const parsed = CreateDeveloperBodySchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }

    const result = await createDeveloper(deps, parsed.data);
    if (result.outcome === "cloud_agent_identity") {
      return fail(c, 400, result.outcome, cloudAgentRefusal(result.identity));
    }
    if (result.outcome === "email_taken") {
      return fail(
        c,
        409,
        "conflict",
        "a developer with this email already exists",
      );
    }
    return ok(c, { developer: result.developer, apiKey: result.apiKey });
  });

  // A LOST OR LEAKED KEY whose owner cannot rotate it themselves
  // (routes/keys.ts is the owner's path). The new key is returned once, to
  // the admin, who hands it over out of band; the old one is dead now.
  router.post("/:id/key", async (c) => {
    const result = await rotateDeveloperKey(deps, {
      developerId: c.req.param("id"),
      by: "admin",
    });
    if (result.outcome !== "rotated") {
      return fail(c, 404, "not_found", "no developer with this id");
    }
    return ok(c, { apiKey: result.apiKey });
  });

  router.get("/:id/emails", async (c) => {
    const emails = await listDeveloperEmails(deps.db, c.req.param("id"));
    if (emails.length === 0) {
      // Every developer has at least a primary row, so an empty list can
      // only mean the id itself is unknown.
      return fail(c, 404, "not_found", "no developer with this id");
    }
    return ok(c, { emails });
  });

  router.post("/:id/emails", async (c) => {
    const parsed = AddEmailBodySchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const result = await addDeveloperEmail(
      deps,
      c.req.param("id"),
      parsed.data.email,
    );
    switch (result.outcome) {
      case "cloud_agent_identity":
        return fail(c, 400, result.outcome, cloudAgentRefusal(result.identity));
      case "developer_not_found":
        return fail(c, 404, "not_found", "no developer with this id");
      case "taken_by_other":
        // Pinned: an email belongs to AT MOST one developer.
        return fail(
          c,
          409,
          "conflict",
          "this email already belongs to another developer",
        );
      case "limit_reached":
        return fail(
          c,
          409,
          "email_limit_reached",
          "this developer's email list is full — remove one first",
        );
      case "added":
        return ok(c, {
          alreadyLinked: result.alreadyLinked,
          emails: result.emails,
        });
    }
  });

  // 04a §4.1 — THE CODE A PERSON ENROLS THEIR FIRST PASSKEY WITH. The admin
  // token, not the developer's key: a code the api key could mint would let
  // any agent holding that key enrol a passkey of its own, the one thing the
  // code exists to prevent. Shown once; the hub keeps only its hash.
  router.post("/:id/passkey-enrollments", async (c) => {
    const developerId = c.req.param("id");
    if ((await listDeveloperEmails(deps.db, developerId)).length === 0) {
      return fail(c, 404, "not_found", "no developer with this id");
    }
    const minted = await mintEnrolmentCode({
      db: deps.db,
      developerId,
      source: "admin",
      now: deps.now(),
    });
    return ok(c, { code: minted.code, expiresAt: minted.expiresAt.toISOString() }, 201);
  });

  router.get("/:id/passkeys", async (c) => {
    return ok(c, {
      passkeys: await listPasskeys({ db: deps.db, developerId: c.req.param("id"), now: deps.now() }),
    });
  });

  // 04a §4.5 — recovery: a lost device, or a passkey nobody expected. The
  // admin may revoke at any time; the path names the developer so a typo in
  // the passkey id cannot close somebody else's device.
  router.post("/:id/passkeys/:passkeyId/revoke", async (c) => {
    const passkeyId = c.req.param("passkeyId");
    const owned = await listPasskeys({ db: deps.db, developerId: c.req.param("id"), now: deps.now() });
    if (!owned.some((passkey) => passkey.id === passkeyId)) {
      return fail(c, 404, "not_found", "this developer has no passkey with this id");
    }
    const outcome = await revokePasskey({
      db: deps.db,
      passkeyId,
      by: { kind: "admin" },
      now: deps.now(),
    });
    // How many open fences closed with it (04a D-PK-1), so the admin who
    // revoked a lost device learns what that undid.
    return "refusal" in outcome
      ? fail(c, 409, outcome.refusal, "that passkey has already been revoked")
      : ok(c, { revoked: true, terminatedWaivers: outcome.terminated });
  });

  router.delete("/:id/emails/:email", async (c) => {
    const result = await removeDeveloperEmail(
      deps.db,
      c.req.param("id"),
      c.req.param("email"),
    );
    switch (result.outcome) {
      case "developer_not_found":
        return fail(c, 404, "not_found", "no developer with this id");
      case "not_linked":
        return fail(c, 404, "not_found", "this email is not linked here");
      case "is_primary":
        return fail(
          c,
          400,
          "validation_failed",
          "the primary email is the account identity and cannot be removed",
        );
      case "removed":
        return ok(c, { emails: result.emails });
    }
  });

  return router;
};
