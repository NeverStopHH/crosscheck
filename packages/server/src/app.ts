import { Hono } from "hono";

import { fail } from "./http/envelope.ts";
import { developersRoutes } from "./routes/developers.ts";
import { eventsRoutes } from "./routes/events.ts";
import { presenceRoutes } from "./routes/presence.ts";
import { recordsRoutes } from "./routes/records.ts";
import { sessionsRoutes } from "./routes/sessions.ts";
import { workContextsRoutes } from "./routes/work-contexts.ts";
import type { AppDeps, AppEnv } from "./types.ts";

export const createApp = (deps: AppDeps): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();

  app.route("/api/developers", developersRoutes(deps));
  app.route("/api/sessions", sessionsRoutes(deps));
  app.route("/api/presence", presenceRoutes(deps));
  app.route("/api/events", eventsRoutes(deps));
  app.route("/api/records", recordsRoutes(deps));
  app.route("/api/work-contexts", workContextsRoutes(deps));

  app.notFound((c) => fail(c, 404, "not_found", "route not found"));
  app.onError((error, c) => {
    console.error("[crosscheck] unhandled error", error);
    return fail(c, 500, "internal_error", "internal server error");
  });

  return app;
};