import { Hono } from "hono";

import { fail, ok } from "../http/envelope.ts";
import { readJsonBody, formatIssues } from "../http/request.ts";
import {
  RegisterSessionBodySchema,
  SessionStatusBodySchema,
} from "../http/schemas.ts";
import { developerAuth } from "../middleware/auth.ts";
import {
  endSession,
  heartbeatSession,
  registerSession,
} from "../services/sessions.ts";
import type { AppDeps, AppEnv } from "../types.ts";

export const sessionsRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  router.post("/", async (c) => {
    const parsed = RegisterSessionBodySchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }

    const developer = c.get("developer");
    const result = await registerSession(deps, developer.id, parsed.data);
    if (result.outcome === "foreign_session") {
      return fail(c, 409, "conflict", "session id belongs to another developer");
    }
    if (result.outcome === "already_ended") {
      return fail(c, 409, "conflict", "session has already ended");
    }
    if (result.outcome === "repo_mismatch") {
      // DISTINCT code on purpose: the register flow's ~r1 retry must stop
      // here (a live session must not spawn a sibling bound to another
      // repo), while "already ended" keeps minting the reopened-session id.
      return fail(
        c,
        409,
        "repo_mismatch",
        "session is registered to a different repo",
      );
    }
    return ok(c, { session: result.session });
  });

  router.post("/:id/heartbeat", async (c) => {
    const body = (await readJsonBody(c)) ?? {};
    const parsed = SessionStatusBodySchema.safeParse(body);
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }

    const developer = c.get("developer");
    const result = await heartbeatSession(
      deps,
      developer.id,
      c.req.param("id"),
      parsed.data.status,
    );
    switch (result.outcome) {
      case "not_found":
        return fail(c, 404, "not_found", "session not found");
      case "forbidden":
        return fail(c, 403, "forbidden", "session belongs to another developer");
      case "already_ended":
        return fail(c, 409, "conflict", "session has already ended");
      case "ok":
        return ok(c, { session: result.session });
    }
  });

  router.post("/:id/end", async (c) => {
    const body = (await readJsonBody(c)) ?? {};
    const parsed = SessionStatusBodySchema.safeParse(body);
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }

    const developer = c.get("developer");
    const result = await endSession(
      deps,
      developer.id,
      c.req.param("id"),
      parsed.data.status,
    );
    switch (result.outcome) {
      case "not_found":
        return fail(c, 404, "not_found", "session not found");
      case "forbidden":
        return fail(c, 403, "forbidden", "session belongs to another developer");
      case "ended":
        return ok(c, { session: result.session });
    }
  });

  return router;
};