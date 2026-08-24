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
  listOpenSessions,
  registerSession,
  reapStaleSessions,
} from "../services/sessions.ts";
import type { AppDeps, AppEnv } from "../types.ts";

export const sessionsRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  /**
   * GET /api/sessions?open=1&mine=1 — what the hub still believes is running
   * (trial finding M6). `doctor`'s `unclosed sessions` line prefers this
   * count and falls back to its local markers when a hub does not have it.
   */
  router.get("/", async (c) => {
    if (c.req.query("open") !== "1") {
      return fail(
        c,
        400,
        "validation_failed",
        "GET /api/sessions currently serves open=1 only",
      );
    }
    const sessions = await listOpenSessions(deps, c.get("developer").id, {
      mine: c.req.query("mine") === "1",
    });
    return ok(c, { sessions });
  });

  router.post("/", async (c) => {
    const parsed = RegisterSessionBodySchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }

    const developer = c.get("developer");
    // The developer's OWN stale sessions, closed on the way in (M6). Bounded
    // by developerId so one person's backlog can never cost another's
    // SessionStart, and non-fatal: a reap that fails must not refuse a
    // registration, which is the one thing this route exists to do.
    try {
      await reapStaleSessions(deps, { developerId: developer.id });
    } catch (error) {
      console.error("[crosscheck] reaping stale sessions failed", error);
    }
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