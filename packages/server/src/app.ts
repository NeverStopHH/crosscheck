import { Hono } from "hono";

import { fail } from "./http/envelope.ts";
import { absencesRoutes } from "./routes/absences.ts";
import { claimRevalidationsRoutes } from "./routes/claim-revalidations.ts";
import { ciRunsRoutes } from "./routes/ci-runs.ts";
import { fenceWaiverRoutes } from "./routes/fence-waivers.ts";
import { conferenceRoutes } from "./routes/conference.ts";
import { contradictionsRoutes } from "./routes/contradictions.ts";
import { developersRoutes } from "./routes/developers.ts";
import { draftsRoutes } from "./routes/drafts.ts";
import { eventsRoutes } from "./routes/events.ts";
import { ghostChecksRoutes } from "./routes/ghost-checks.ts";
import { hintsRoutes } from "./routes/hints.ts";
import { intentLedgerRoutes } from "./routes/intent-ledger.ts";
import { pinsRoutes } from "./routes/pins.ts";
import { presenceRoutes } from "./routes/presence.ts";
import { questionsRoutes } from "./routes/questions.ts";
import { recordsRoutes } from "./routes/records.ts";
import { pilotMarkRoutes } from "./routes/pilot-marks.ts";
import { searchRoutes } from "./routes/search.ts";
import { sessionsRoutes } from "./routes/sessions.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { teamSettingsRoutes } from "./routes/team-settings.ts";
import { solvedMatchesRoutes } from "./routes/solved-matches.ts";
import { suspectRoutes } from "./routes/suspect.ts";
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
  app.route("/api/pilot-marks", pilotMarkRoutes(deps));
  app.route("/api/solved-matches", solvedMatchesRoutes(deps));
  app.route("/api/ghost-checks", ghostChecksRoutes(deps));
  // The conference corpus (VISION.md §2). Never a hook and never automatic:
  // this route only ever answers a `crosscheck conference` a human or their
  // scheduler started, which is why it is a deliberate-pull surface.
  app.route("/api/conference", conferenceRoutes(deps));
  // The asynchronous question channel (roadmap R2). A route of its own, not
  // only a record kind, because asking resolves a developer NAME and a
  // misspelt one must come back naming the closest spellings.
  app.route("/api/questions", questionsRoutes(deps));
  app.route("/api/drafts", draftsRoutes(deps));
  // The pin registry (regression-guard Stage 1). A route rather than a record
  // kind: `crosscheck pin` is a person's command, and its refusals — an agent
  // capture mode, a speaking pin with no check recipe — have to reach that
  // person's terminal instead of a spool nobody reads.
  app.route("/api/pins", pinsRoutes(deps));
  // "Who was in there, and what did they say they were doing" — post-hoc,
  // pulled by a person, and gated hub-side on a check that was run and
  // failed. It needs no hook, so it answers identically for Claude Code,
  // Cursor and ACP sessions alike.
  app.route("/api/suspect", suspectRoutes(deps));
  // Whether this hub can answer AT-4 at all — two integers, read by any
  // member, printed by doctor. A hub whose intents all carry `seq: null`
  // renders every sentence exactly as before and reports healthy; this is
  // the one instrument that makes that visible rather than quiet.
  app.route("/api/intent-ledger", intentLedgerRoutes(deps));
  app.route("/api/settings", settingsRoutes(deps));
  // The regression guard's two TEAM decisions — who may pin, and whether
  // `suspect` names sessions. Read by any member (everybody affected has to
  // be able to see what it is), written with the admin token.
  app.route("/api/team-settings", teamSettingsRoutes(deps));
  // The claim ↔ code binding's recording half (1.0 spec 02). A route rather
  // than a record kind: `crosscheck revalidate` runs from a terminal with no
  // agent session, and minting one would be a phantom teammate in presence.
  app.route("/api/claim-revalidations", claimRevalidationsRoutes(deps));
  // What CI saw, keyed to a commit (spec 05). Its own route rather than a
  // record kind, because an envelope requires a producer — a developer, an
  // agent kind and a session — and CI has none of the three. Write is a
  // dedicated token, read is any member.
  app.route("/api/ci-runs", ciRunsRoutes(deps));
  app.route("/api/fence-waivers", fenceWaiverRoutes(deps));
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