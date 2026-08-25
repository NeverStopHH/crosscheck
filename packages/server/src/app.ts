import { Hono } from "hono";

import { fail } from "./http/envelope.ts";
import { absencesRoutes } from "./routes/absences.ts";
import { contradictionsRoutes } from "./routes/contradictions.ts";
import { developersRoutes } from "./routes/developers.ts";
import { draftsRoutes } from "./routes/drafts.ts";
import { eventsRoutes } from "./routes/events.ts";
import { hintsRoutes } from "./routes/hints.ts";
import { presenceRoutes } from "./routes/presence.ts";
import { questionsRoutes } from "./routes/questions.ts";
import { recordsRoutes } from "./routes/records.ts";
import { searchRoutes } from "./routes/search.ts";
import { sessionsRoutes } from "./routes/sessions.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { solvedMatchesRoutes } from "./routes/solved-matches.ts";
import { uiRoutes } from "./routes/ui.tsx";
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
  app.route("/api/search", searchRoutes(deps));
  app.route("/api/hints", hintsRoutes(deps));
  app.route("/api/contradictions", contradictionsRoutes(deps));
  app.route("/api/absences", absencesRoutes(deps));
  app.route("/api/solved-matches", solvedMatchesRoutes(deps));
  // The asynchronous question channel (roadmap R2). A route of its own, not
  // only a record kind, because asking resolves a developer NAME and a
  // misspelt one must come back naming the closest spellings.
  app.route("/api/questions", questionsRoutes(deps));
  app.route("/api/drafts", draftsRoutes(deps));
  app.route("/api/settings", settingsRoutes(deps));
  // The human-facing web surface (DESIGN.md §2.1 v0.5) — same hub, same
  // visibility rules, session-cookie auth instead of bearer keys.
  app.route("/ui", uiRoutes(deps));

  app.notFound((c) => fail(c, 404, "not_found", "route not found"));
  app.onError((error, c) => {
    console.error("[crosscheck] unhandled error", error);
    return fail(c, 500, "internal_error", "internal server error");
  });

  return app;
};