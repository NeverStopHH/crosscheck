import { Hono } from "hono";
import { z } from "zod";

import { fail, ok } from "../http/envelope.ts";
import { readJsonBody, formatIssues } from "../http/request.ts";
import { CreateDeveloperBodySchema } from "../http/schemas.ts";
import { requireAdmin } from "../middleware/auth.ts";
import {
  addDeveloperEmail,
  createDeveloper,
  listDeveloperEmails,
  removeDeveloperEmail,
} from "../services/developers.ts";
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

  router.post("/", async (c) => {
    const parsed = CreateDeveloperBodySchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }

    const result = await createDeveloper(deps, parsed.data);
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
