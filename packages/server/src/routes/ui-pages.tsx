/** @jsxImportSource hono/jsx */
/**
 * The authed /ui pages and actions — mounted by routes/ui.tsx BEHIND its
 * session middleware, so every handler here can rely on `developer` and
 * `uiSessionToken` being set and on the security headers being applied.
 *
 * Reads reuse the API's services untouched: the feed rides the opt-out-
 * filtered events reader (services/events.ts), the tree page rides
 * getDiagnosis + listSolvedInfo, the case file rides getRefereeBrief.
 * Approve/revoke is the one write surface, CSRF-checked and owner-scoped
 * hub-side (services/artifacts.ts).
 */
import { Hono } from "hono";
import { eq, inArray } from "drizzle-orm";
import type { Context } from "hono";

import { CONTRADICTIONS_MAX_LIMIT, listContradictions } from "../services/contradictions.ts";
import { agentSessions, developers, workContexts } from "../db/schema.ts";
import { listRecentEvents } from "../services/events.ts";
import type { EventView } from "../services/events.ts";
import {
  listArtifactsForWorkContext,
  listOwnedNeedsApproval,
  setArtifactApproval,
} from "../services/artifacts.ts";
import { getDiagnosis } from "../services/diagnosis.ts";
import { listMembers } from "../services/members.ts";
import { getRefereeBrief } from "../services/referee.ts";
import { listSolvedInfo } from "../services/solved.ts";
import { UI_FEED_LIMIT, UI_MAX_ARTIFACTS } from "../ui/constants.ts";
import {
  forbidden,
  isPostedCsrfValid,
  notFoundPage,
  viewerChrome,
} from "../ui/route-helpers.tsx";
import { ApprovalsPage } from "../ui/pages/approvals.tsx";
import { FeedPage } from "../ui/pages/feed.tsx";
import type { FeedEntry } from "../ui/pages/feed.tsx";
import { MembersPage } from "../ui/pages/members.tsx";
import { RefereePage } from "../ui/pages/referee.tsx";
import { WorkContextPage } from "../ui/pages/work-context.tsx";
import type { AppDeps, AppEnv } from "../types.ts";

const APPROVALS_PATH = "/ui/approvals";
const FEED_PATH = "/ui/feed";

// ── Feed assembly ───────────────────────────────────────────────────────────

/** Boundary read of an untrusted outbox payload field. */
const payloadString = (
  payload: Record<string, unknown>,
  key: string,
): string | null => {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/** One bounded name lookup for the page's actors. The events reader already
 * removed opt-out-hidden subjects' rows, so every id here is showable. */
const actorNamesFor = async (
  deps: AppDeps,
  eventPage: readonly EventView[],
): Promise<ReadonlyMap<string, string>> => {
  const ids = [
    ...new Set(
      eventPage
        .map((event) => payloadString(event.payload, "developerId"))
        .filter((id): id is string => id !== null),
    ),
  ];
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await deps.db
    .select({ id: developers.id, name: developers.name })
    .from(developers)
    .where(inArray(developers.id, ids))
    .limit(UI_FEED_LIMIT);
  return new Map(rows.map((row) => [row.id, row.name]));
};

const toFeedEntry = (
  event: EventView,
  names: ReadonlyMap<string, string>,
  nowMs: number,
): FeedEntry => {
  const actorId = payloadString(event.payload, "developerId");
  return {
    id: event.id,
    kind: event.kind,
    actorName: actorId === null ? null : (names.get(actorId) ?? null),
    workContextId: payloadString(event.payload, "workContextId"),
    repo: payloadString(event.payload, "repo"),
    branch: payloadString(event.payload, "branch"),
    kindLabel: payloadString(event.payload, "kind"),
    statusLabel: payloadString(event.payload, "status"),
    ageMs: Math.max(0, nowMs - Date.parse(event.createdAt)),
  };
};

// ── Work-context assembly ───────────────────────────────────────────────────

/** The context owner's display name — who OPENED the tree, one bounded row. */
const contextOwnerName = async (
  deps: AppDeps,
  workContextId: string,
): Promise<string | null> => {
  const rows = await deps.db
    .select({ name: developers.name })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .innerJoin(developers, eq(agentSessions.developerId, developers.id))
    .where(eq(workContexts.id, workContextId))
    .limit(1);
  return rows[0]?.name ?? null;
};

/**
 * Live contradiction pair ids touching this tree. The pool is the same
 * bounded listing the briefing reads; a pair beyond that bound is invisible
 * there too, so the page cannot promise more than the id can resolve.
 */
const contradictionIdsFor = async (
  deps: AppDeps,
  workContextId: string,
): Promise<readonly string[]> => {
  const pairs = await listContradictions(deps.db, {
    limit: CONTRADICTIONS_MAX_LIMIT,
  });
  return [
    ...new Set(
      pairs
        .filter(
          (pair) =>
            pair.claimA.workContextId === workContextId ||
            pair.claimB.workContextId === workContextId,
        )
        .map((pair) => pair.id),
    ),
  ];
};

// ── Approve / revoke ────────────────────────────────────────────────────────

const handleApprovalAction = async (
  c: Context<AppEnv>,
  deps: AppDeps,
  isApproving: boolean,
): Promise<Response> => {
  if (!(await isPostedCsrfValid(c, deps))) {
    return forbidden(c, "Invalid or missing CSRF token.");
  }
  // Plain Context here does not carry the route's param typing.
  const artifactId = c.req.param("id");
  if (artifactId === undefined || artifactId.length === 0) {
    return notFoundPage(c);
  }
  const outcome = await setArtifactApproval(
    deps.db,
    c.get("developer").id,
    artifactId,
    isApproving,
  );
  if (outcome === "not_found") {
    return notFoundPage(c);
  }
  return c.redirect(APPROVALS_PATH, 303);
};

// ── Router ──────────────────────────────────────────────────────────────────

export const uiPagesRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();

  router.get("/", (c) => c.redirect(FEED_PATH, 303));

  router.get("/feed", async (c) => {
    const eventPage = await listRecentEvents(
      deps.db,
      c.get("developer").id,
      UI_FEED_LIMIT,
    );
    const names = await actorNamesFor(deps, eventPage);
    const nowMs = deps.now().getTime();
    const entries = eventPage.map((event) => toFeedEntry(event, names, nowMs));
    return c.html(<FeedPage viewer={viewerChrome(c, deps)} entries={entries} />);
  });

  router.get("/members", async (c) => {
    const members = await listMembers(deps, c.get("developer").id);
    return c.html(
      <MembersPage
        viewer={viewerChrome(c, deps)}
        members={members}
        nowMs={deps.now().getTime()}
      />,
    );
  });

  router.get("/approvals", async (c) => {
    const owned = await listOwnedNeedsApproval(
      deps.db,
      c.get("developer").id,
      UI_MAX_ARTIFACTS,
    );
    return c.html(
      <ApprovalsPage
        viewer={viewerChrome(c, deps)}
        artifacts={owned}
        nowMs={deps.now().getTime()}
      />,
    );
  });

  router.get("/work-contexts/:id", async (c) => {
    const workContextId = c.req.param("id");
    const diagnosis = await getDiagnosis(deps.db, workContextId);
    if (diagnosis === undefined) {
      return notFoundPage(c);
    }
    const [solvedInfo, ownerName, artifactRows, contradictionIds] =
      await Promise.all([
        listSolvedInfo(deps.db, [workContextId]),
        contextOwnerName(deps, workContextId),
        listArtifactsForWorkContext(
          deps.db,
          c.get("developer").id,
          workContextId,
          UI_MAX_ARTIFACTS,
        ),
        contradictionIdsFor(deps, workContextId),
      ]);
    return c.html(
      <WorkContextPage
        viewer={viewerChrome(c, deps)}
        diagnosis={diagnosis}
        ownerName={ownerName}
        solvedAtMs={solvedInfo.get(workContextId)?.getTime() ?? null}
        artifacts={artifactRows}
        contradictionIds={contradictionIds}
        nowMs={deps.now().getTime()}
      />,
    );
  });

  router.get("/contradictions/:id", async (c) => {
    const brief = await getRefereeBrief(deps.db, c.req.param("id"));
    if (brief === undefined) {
      return notFoundPage(c);
    }
    return c.html(<RefereePage viewer={viewerChrome(c, deps)} brief={brief} />);
  });

  router.post("/artifacts/:id/approve", (c) =>
    handleApprovalAction(c, deps, true),
  );
  router.post("/artifacts/:id/revoke", (c) =>
    handleApprovalAction(c, deps, false),
  );

  return router;
};
