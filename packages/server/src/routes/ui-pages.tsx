/** @jsxImportSource hono/jsx */
/**
 * The authed /ui pages and actions — mounted by routes/ui.tsx BEHIND its
 * session middleware, so every handler here can rely on `developer` and
 * `uiSessionToken` being set and on the security headers being applied.
 *
 * Reads reuse the API's services untouched: the feed rides the opt-out-
 * filtered events reader (services/events.ts), the tree page rides
 * getDiagnosis + listSolvedInfo, the case file rides getRefereeBrief.
 * Releasing an artifact is a passkey ceremony on /ui/approvals
 * (routes/ui-ceremony-artifacts.ts), owner-scoped hub-side
 * (services/artifacts.ts); the old form posts only refuse.
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
import { usableCredentials } from "../services/passkeys.ts";
import { getRefereeBrief } from "../services/referee.ts";
import { listSolvedInfo } from "../services/solved.ts";
import { UI_FEED_LIMIT, UI_MAX_ARTIFACTS, UI_PASSKEY_CSP } from "../ui/constants.ts";
import { forbidden, isPostedCsrfValid, notFoundPage, viewerChrome } from "../ui/route-helpers.tsx";
import { ApprovalsPage } from "../ui/pages/approvals.tsx";
import { FeedPage } from "../ui/pages/feed.tsx";
import type { FeedEntry, PresenceReenableBanner, WaitingDrafts } from "../ui/pages/feed.tsx";
import { countPendingByKind } from "../services/human-drafts.ts";
import { getDeveloperSettings, presenceReenableNotice } from "../services/developer-settings.ts";
import { MembersPage } from "../ui/pages/members.tsx";
import { RefereePage } from "../ui/pages/referee.tsx";
import { WorkContextPage } from "../ui/pages/work-context.tsx";
import type { AppDeps, AppEnv } from "../types.ts";

const FEED_PATH = "/ui/feed";
const APPROVALS_PATH = "/ui/approvals";

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

/**
 * A work_context_updated event names WHICH fields changed (ids and metadata
 * only — the outbox carries no bodies); the feed phrases the one a human
 * cares about as a renderer-owned literal, never the field's text.
 */
const INTENT_FIELD = "intent";

const changedLabel = (payload: Record<string, unknown>): string | null => {
  const changed = payload["changed"];
  return Array.isArray(changed) && changed.includes(INTENT_FIELD) ? INTENT_FIELD : null;
};

/**
 * Only a DERIVED claim is labelled: a vouched claim is the default reading of
 * "added a claim", and the label is a renderer-owned literal, never the
 * payload's text.
 *
 * EVENTS APPENDED BEFORE claim_added CARRIED PROVENANCE STAY UNLABELLED —
 * accepted (review round 3, LOW-9). The outbox is append-only history, and
 * filling `provenance` into old payloads would rewrite what the hub said at
 * the time; a reader who needs to know opens the tree, whose claim cards
 * label every draft. The gap closes on its own as the feed's window moves.
 */
const DERIVED_PROVENANCE = "derived";

const provenanceLabel = (payload: Record<string, unknown>): string | null =>
  payloadString(payload, "provenance") === DERIVED_PROVENANCE ? DERIVED_PROVENANCE : null;

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
    kindLabel: payloadString(event.payload, "kind") ?? changedLabel(event.payload),
    statusLabel: payloadString(event.payload, "status"),
    provenanceLabel: provenanceLabel(event.payload),
    by: payloadString(event.payload, "by"),
    ageMs: Math.max(0, nowMs - Date.parse(event.createdAt)),
  };
};

/** The viewer's own presence re-enable, for the feed's banner: self only, never a teammate's. */
const presenceReenableBannerFor = async (
  deps: AppDeps,
  developerId: string,
): Promise<PresenceReenableBanner | null> => {
  const at = await presenceReenableNotice(deps.db, developerId, deps.now());
  if (at === null) {
    return null;
  }
  const settings = await getDeveloperSettings(deps.db, developerId, deps.now());
  return { at, isOptedOutNow: settings.presenceOptOut };
};

/** The viewer's own drafts waiting for their passkey, for the feed (review M7, spec §8). */
const waitingDraftsFor = async (deps: AppDeps, developerId: string): Promise<WaitingDrafts> => {
  const counts = await countPendingByKind(deps, developerId);
  return {
    total: Object.values(counts).reduce((sum, n) => sum + n, 0),
    presenceOn: (counts.presence_on ?? 0) > 0,
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

/**
 * WHAT A FORM POST TO RELEASE AN ARTIFACT HEARS NOW (review M2). A session
 * opened with an API key, which any agent holding the key can open, used to
 * release a needs_approval artifact with one form post. Releasing takes a
 * passkey ceremony on /ui/approvals (routes/ui-ceremony-artifacts.ts). The
 * route stays, refusing, for the reason fence-waivers.ts keeps its own: a 404
 * would send an old recipe looking for another way in.
 */
const FORM_RELEASE_REFUSED =
  "Releasing an artifact takes your passkey now: use the button on the Approvals page. " +
  "A session opened with an API key cannot do it alone.";

const refuseFormRelease = (c: Context<AppEnv>): Response | Promise<Response> =>
  forbidden(c, FORM_RELEASE_REFUSED);

/**
 * WITHDRAWING A RELEASE STAYS A PLAIN FORM (review of the hub hardening, M3).
 * It makes content more private, like switching presence off, so the owner
 * withdraws from the session with its CSRF token, no passkey and no cool-off.
 * An agent that withdraws its person's release harms availability, never
 * disclosure. Ownership is checked inside the UPDATE (services/artifacts.ts),
 * and a non-owner hears the same 404 as a missing id.
 */
const withdrawFromForm = async (c: Context<AppEnv>, deps: AppDeps): Promise<Response> => {
  if (!(await isPostedCsrfValid(c, deps))) {
    return forbidden(c, "Invalid or missing CSRF token.");
  }
  const artifactId = c.req.param("id") ?? "";
  const outcome = await setArtifactApproval(deps.db, c.get("developer").id, artifactId, false);
  return outcome === "not_found" ? notFoundPage(c) : c.redirect(APPROVALS_PATH, 303);
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
    return c.html(
      <FeedPage
        viewer={viewerChrome(c, deps)}
        entries={entries}
        presenceReenable={await presenceReenableBannerFor(deps, c.get("developer").id)}
        waiting={await waitingDraftsFor(deps, c.get("developer").id)}
      />,
    );
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
    // A ceremony page now (review M2): the passkey CSP and its one script.
    c.header("Content-Security-Policy", UI_PASSKEY_CSP);
    const developerId = c.get("developer").id;
    const [owned, usable] = await Promise.all([
      listOwnedNeedsApproval(deps.db, developerId, UI_MAX_ARTIFACTS),
      usableCredentials({ db: deps.db, developerId, now: deps.now() }),
    ]);
    return c.html(
      <ApprovalsPage
        viewer={viewerChrome(c, deps)}
        artifacts={owned}
        nowMs={deps.now().getTime()}
        hasOrigin={deps.webauthnOrigins.length > 0}
        hasUsablePasskey={usable.length > 0}
      />,
    );
  });

  router.get("/work-contexts/:id", async (c) => {
    const workContextId = c.req.param("id");
    const diagnosis = await getDiagnosis(
      deps.db,
      deps.now(),
      workContextId,
      c.get("developer").id,
    );
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
    const brief = await getRefereeBrief(
      deps.db,
      deps.now(),
      c.req.param("id"),
      c.get("developer").id,
    );
    if (brief === undefined) {
      return notFoundPage(c);
    }
    return c.html(<RefereePage viewer={viewerChrome(c, deps)} brief={brief} />);
  });

  router.post("/artifacts/:id/approve", (c) => refuseFormRelease(c));
  router.post("/artifacts/:id/revoke", (c) => withdrawFromForm(c, deps));

  return router;
};
