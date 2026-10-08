/**
 * EVERY ROUTE THE HUB REGISTERS, and how the live-location guard walks it
 * (test/live-location-privacy.test.ts). The guard fails on a route the app
 * registers that this table does not name, so a route added tomorrow cannot
 * pass unwalked: whoever adds it writes its variants here, or a reason.
 *
 * Per route:
 *   variants   — the requests that reach its data, read off the handler's
 *                own query and body schemas (routes/*.ts). A variant may be
 *                `refused` (and say why): it is still walked, and whatever
 *                its refusal says is checked too.
 *   whyNoVariants — required exactly when no variant reaches data.
 *   notCalled  — the route is never called (it would end the walk's own
 *                credentials or premise), and why.
 *   colleague  — "withheld": Nick must see Robin's row (in withheld form —
 *                the guard checks no secret of hers anywhere); or the
 *                written reason he sees none of her rows.
 *   self       — "located": Robin's own reads must show her location (a
 *                SECRET); or the written reason this route carries none.
 */
import { EMPTY_LOSS_REPORT } from "@crosscheck/schema";

import { contradictionIdFor } from "../src/services/contradictions.ts";
import { VALID_SESSION_BODY, recordEnvelope, registerTestSession, validClaimBody } from "./helpers.ts";
import {
  CREATED_AT,
  FILE,
  FINGERPRINT,
  LOCAL_REPO,
  NICK_CONTEXT,
  NICK_SESSION,
  REPO,
  ROBIN_CONTEXT,
  ROBIN_DETACHED_CONTEXT,
  ROBIN_LIVE,
  ROBIN_LOCAL_CONTEXT,
  ROBIN_NEW_FILE,
  ROBIN_PIN,
  ROBIN_SOLVED,
  SECRET_BRANCH,
  SECRET_SHA,
} from "./opted-out-world.ts";
import type { OptedOutWorld } from "./opted-out-world.ts";

export interface Variant {
  /** The concrete path — every `:param` of the route filled (`:robin` is her id). */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** Who calls: the walking developer (default) or the hub admin. */
  readonly as?: "viewer" | "admin";
  /** Expected to be refused (4xx), and why it is walked anyway. */
  readonly refused?: string;
  /** For a stream: what happens while it is read. */
  readonly during?: (world: OptedOutWorld) => Promise<void>;
}

export interface RouteSpec {
  readonly variants: readonly Variant[];
  readonly whyNoVariants?: string;
  readonly notCalled?: string;
  readonly colleague: "withheld" | { readonly hidden: string };
  readonly self: "located" | { readonly none: string };
  /** A non-2xx answer every variant gives by design, and why. */
  readonly status?: { readonly code: number; readonly why: string };
  /**
   * A parameter the handler READS that no variant supplies, and why that is
   * safe (`?name` for a query parameter, `name` for a body key). The guard
   * records what each handler reads and fails on any other (review round 4,
   * H5): a location behind an unwalked parameter is a location never checked.
   */
  readonly unexercised?: Readonly<Record<string, string>>;
}

/** A path parameter naming Robin's developer id, resolved per world. */
export const ROBIN_ID_PARAM = ":robin";

const CONTRADICTION = contradictionIdFor("clm_nick", "clm_robin");
/** A default-branch commit the walker's own clone names — his, nothing of hers. */
const WALKER_REF = "abcdef1234567";
/** A waiver's term: two days after the read, inside every bound a request takes. */
const WAIVER_UNTIL = "2026-07-26T10:00:00.000Z";
/** A sequence position on the walker's own session's lane: the first of a fresh epoch. */
const WALK_SEQ = { epoch: "0b0c4d2e-1f2a-4b3c-8d4e-5f6a7b8c9d0e", n: 0 } as const;
const ROBIN_CONTEXTS = [ROBIN_CONTEXT, ROBIN_LOCAL_CONTEXT, ROBIN_DETACHED_CONTEXT, ROBIN_SOLVED];
/** A session Robin starts WHILE a stream is read: its session_started event names her branch. */
const ROBIN_LATE = "cc_77777777-8888-4999-8aaa-bbbbbbbbbbbb";

const byId = (pattern: string): readonly Variant[] =>
  ROBIN_CONTEXTS.map((id) => ({ path: pattern.replace(":id", id) }));

const OWN = "the caller's own settings, counters or records — no colleague's row";
const ADMIN_ONLY = "admin-only: a developer is refused, and the admin's view names no session";
const NONE_SEEDED = "a store the seed puts nothing of hers in";
const PRESENCE = (surface: string): { readonly hidden: string } => ({
  hidden: `a live-presence surface (visibility.ts ${surface}): her rows are dropped whole, not withheld field by field`,
});
const WRITE_ACK = "a write: the answer acknowledges the caller's own request, and her location is read back through the GET routes";

const refusedPost = (path: string, why: string): readonly Variant[] => [{ path, body: {}, refused: why }];

const GET_ROUTES: Readonly<Record<string, RouteSpec>> = {
  "GET /api/absences": {
    variants: [{ path: "/api/absences", query: { repo: REPO } }],
    colleague: PRESENCE("surface 3"),
    self: "located",
  },
  "GET /api/ci-runs": {
    variants: [{ path: "/api/ci-runs", query: { repo: REPO, commit: "a1b2c3d4", defaultRef: "origin/main" } }],
    colleague: { hidden: "CI runs of a commit: no developer's work or session" },
    self: { none: "CI runs of a commit: no developer's work or session" },
  },
  "GET /api/ci-runs/verdict": {
    variants: [{ path: "/api/ci-runs/verdict", query: { repo: REPO, commit: "a1b2c3d4", defaultRef: "origin/main" } }],
    colleague: { hidden: "a CI verdict on a commit: no developer's work or session" },
    self: { none: "a CI verdict on a commit: no developer's work or session" },
  },
  "GET /api/claim-revalidations/summary": {
    variants: [{ path: "/api/claim-revalidations/summary", query: { repo: REPO } }],
    colleague: { hidden: "counts only — no claim, context or developer" },
    self: { none: "counts only — no claim, context or developer" },
  },
  "GET /api/conference": {
    variants: [
      { path: "/api/conference", query: { repo: REPO } },
      { path: "/api/conference", query: { repo: LOCAL_REPO } },
    ],
    colleague: "withheld",
    self: "located",
  },
  "GET /api/contradictions": {
    variants: [
      { path: "/api/contradictions", query: { repo: REPO } },
      { path: "/api/contradictions", query: { repo: REPO, limit: "50" } },
    ],
    colleague: "withheld",
    self: { none: "a pair names its two claims and authors, and no location field" },
  },
  "GET /api/contradictions/:id/brief": {
    variants: [{ path: `/api/contradictions/${CONTRADICTION}/brief` }],
    colleague: "withheld",
    self: "located",
  },
  "GET /api/developers": {
    variants: [
      { path: "/api/developers", as: "admin" },
      { path: "/api/developers", refused: ADMIN_ONLY },
    ],
    colleague: "withheld",
    self: { none: ADMIN_ONLY },
  },
  "GET /api/developers/:id/emails": {
    variants: [{ path: "/api/developers/:robin/emails", as: "admin" }],
    colleague: "withheld",
    self: { none: ADMIN_ONLY },
  },
  "GET /api/developers/:id/passkeys": {
    variants: [{ path: "/api/developers/:robin/passkeys", as: "admin" }],
    colleague: { hidden: "her passkeys: the seed enrols none" },
    self: { none: ADMIN_ONLY },
  },
  "GET /api/drafts": {
    variants: [
      { path: "/api/drafts", query: { repo: REPO } },
      { path: "/api/drafts", query: { repo: REPO, order: "oldest" } },
    ],
    colleague: { hidden: "the caller's own drafts" },
    self: { none: "her own drafts: the seed composes none" },
  },
  "GET /api/events": {
    variants: [
      { path: "/api/events" },
      { path: "/api/events", query: { limit: "200" } },
      { path: "/api/events", query: { after: "0" } },
    ],
    colleague: PRESENCE("surface 4"),
    self: "located",
  },
  "GET /api/fence-waivers": {
    variants: [
      { path: "/api/fence-waivers", query: { repo: REPO } },
      { path: "/api/fence-waivers", query: { repo: REPO, pin: ROBIN_PIN } },
    ],
    colleague: { hidden: NONE_SEEDED },
    self: { none: NONE_SEEDED },
  },
  "GET /api/ghost-checks": {
    variants: [{ path: "/api/ghost-checks", query: { repo: REPO } }],
    colleague: PRESENCE("surface 5"),
    self: { none: "a ghost line is a colleague working where the reader is; her own work is never her ghost" },
  },
  "GET /api/hint-outcomes/mine": {
    // Nick's own history: the teammate whose work a hint pointed at is named
    // (hd_robin_1 pointed at hers), with counts — never her location.
    variants: [
      { path: "/api/hint-outcomes/mine", query: { repo: REPO } },
      { path: "/api/hint-outcomes/mine", query: { repo: REPO, days: "14" } },
    ],
    colleague: "withheld",
    self: { none: "counts of the caller's own hints and of hints on the caller's own work: no location field" },
  },
  "GET /api/hints/candidates": {
    variants: [
      { path: "/api/hints/candidates", query: { repo: REPO, query: "rotation window refresh key id" } },
      { path: "/api/hints/candidates", query: { repo: LOCAL_REPO, query: "rotation window refresh scratch detached" } },
      { path: "/api/hints/candidates", query: { repo: REPO, query: "rotation", days: "30" } },
      // A prompt that carries nothing task-bearing: the session's intent is
      // matched in its place (services/hints.ts, the content floor).
      { path: "/api/hints/candidates", query: { repo: REPO, query: "mache weiter", intent: "rotation window refresh key id" } },
    ],
    colleague: "withheld",
    self: "located",
  },
  "GET /api/hints/stats": {
    variants: [{ path: "/api/hints/stats", query: { repo: REPO, days: "14" } }],
    colleague: { hidden: OWN },
    self: { none: OWN },
  },
  "GET /api/hints/tripwire": {
    variants: [
      { path: "/api/hints/tripwire", query: { repo: REPO, value: FILE } },
      // The repo declared the edited generated file authoritative: the same
      // sessions, so the same projection must hold.
      { path: "/api/hints/tripwire", query: { repo: REPO, value: FILE, authoritative: "1" } },
    ],
    colleague: PRESENCE("surface 2"),
    self: "located",
  },
  "GET /api/hub-status": {
    variants: [{ path: "/api/hub-status" }],
    colleague: { hidden: "a count of the hub's own pending doc rebuilds: no context, no developer" },
    self: { none: "a count of the hub's own pending doc rebuilds: no context, no developer" },
  },
  "GET /api/intent-ledger/positions": {
    variants: [{ path: "/api/intent-ledger/positions", query: { repo: REPO } }],
    colleague: { hidden: OWN },
    self: { none: OWN },
  },
  "GET /api/landed/notices": {
    variants: [{ path: "/api/landed/notices", query: { repo: REPO } }],
    colleague: { hidden: "notices to the caller about the caller's own landed changes; the seed lands none" },
    self: { none: "notices to the caller about the caller's own landed changes; the seed lands none" },
  },
  "GET /api/passkeys/announcements": {
    variants: [{ path: "/api/passkeys/announcements" }],
    colleague: { hidden: OWN },
    self: { none: OWN },
  },
  "GET /api/pilot-marks/candidates": {
    variants: [
      { path: "/api/pilot-marks/candidates", query: { repo: REPO, withinMinutes: "600" } },
      { path: "/api/pilot-marks/candidates", query: { repo: REPO, withinMinutes: "600", session: NICK_SESSION } },
      { path: "/api/pilot-marks/candidates", query: { repo: REPO, withinMinutes: "600", ref: ROBIN_CONTEXT } },
    ],
    colleague: "withheld",
    self: { none: "the caller's own deliveries: Robin was delivered nothing in the seed" },
  },
  "GET /api/pilot-marks/unlabeled": {
    variants: [{ path: "/api/pilot-marks/unlabeled", query: { repo: REPO, withinMinutes: "600" } }],
    colleague: "withheld",
    self: { none: "the caller's own deliveries: Robin was delivered nothing in the seed" },
  },
  "GET /api/pilot/report": {
    variants: [{ path: "/api/pilot/report", query: { repo: REPO, days: "14" } }],
    colleague: "withheld",
    self: "located",
  },
  "GET /api/pins": {
    variants: [{ path: "/api/pins", query: { repo: REPO } }],
    // Her pin, verified after the opt-out (opted-out-world.ts ROBIN_PIN).
    colleague: "withheld",
    self: "located",
  },
  "GET /api/presence": {
    variants: [
      { path: "/api/presence", query: { repo: REPO } },
      { path: "/api/presence", query: { repo: LOCAL_REPO } },
    ],
    colleague: PRESENCE("surface 1"),
    self: "located",
  },
  "GET /api/questions": {
    variants: [
      { path: "/api/questions", query: { repo: REPO } },
      { path: "/api/questions", query: { repo: REPO, answerable: "1" } },
    ],
    colleague: "withheld",
    self: { none: "her inbox: the seed asks her nothing; her own titles reach her through the listing" },
  },
  "GET /api/search": {
    variants: [
      { path: "/api/search", query: { query: "rotation window", repo: REPO } },
      { path: "/api/search", query: { query: "rotation window refresh", repo: LOCAL_REPO } },
      { path: "/api/search", query: { query: "", repo: REPO } },
      { path: "/api/search", query: { query: "rotation", repo: REPO, since: "14d" } },
      { path: "/api/search", query: { query: "rotation", developer: "Robin" } },
      { path: "/api/search", query: { query: "rotation", repo: REPO, limit: "50" } },
    ],
    colleague: "withheld",
    self: "located",
  },
  "GET /api/sessions": {
    variants: [
      { path: "/api/sessions", query: { open: "1" } },
      { path: "/api/sessions", query: { open: "1", mine: "1" } },
      { path: "/api/sessions", refused: "the listing takes open=1; a bare call is a validation refusal" },
    ],
    colleague: PRESENCE("surface 6"),
    self: "located",
  },
  "GET /api/sessions/order": {
    variants: [{ path: "/api/sessions/order" }],
    colleague: { hidden: OWN },
    self: { none: OWN },
  },
  "GET /api/settings": {
    variants: [{ path: "/api/settings" }],
    colleague: { hidden: OWN },
    self: { none: OWN },
  },
  "GET /api/solved-matches": {
    variants: [
      { path: "/api/solved-matches", query: { repo: REPO } },
      { path: "/api/solved-matches", query: { repo: REPO, fingerprint: FINGERPRINT } },
      { path: "/api/solved-matches", query: { repo: REPO, counts: "1" } },
    ],
    colleague: "withheld",
    self: "located",
  },
  "GET /api/suspect": {
    variants: [
      { path: "/api/suspect", query: { repo: REPO, path: FILE } },
      // Her pin, verified after the opt-out: the falsifier gate reads it.
      { path: "/api/suspect", query: { repo: REPO, pin: ROBIN_PIN } },
    ],
    colleague: "withheld",
    self: "located",
  },
  "GET /api/team-settings": {
    variants: [{ path: "/api/team-settings", query: { repo: REPO } }],
    colleague: { hidden: "team settings name no developer" },
    self: { none: "team settings name no developer" },
  },
  "GET /api/waiver-requests": {
    variants: [{ path: "/api/waiver-requests" }, { path: "/api/waiver-requests", query: { repo: REPO } }],
    colleague: { hidden: NONE_SEEDED },
    self: { none: NONE_SEEDED },
  },
  "GET /api/work-contexts": {
    variants: [
      { path: "/api/work-contexts", query: { repo: REPO } },
      { path: "/api/work-contexts", query: { repo: LOCAL_REPO } },
      { path: "/api/work-contexts", query: { repo: REPO, since: "14d" } },
      { path: "/api/work-contexts", query: { repo: REPO, since: CREATED_AT } },
      { path: "/api/work-contexts", query: { repo: REPO, limit: "5" } },
      { path: "/api/work-contexts", query: { repo: REPO, session: ROBIN_LIVE } },
      { path: "/api/work-contexts", query: { repo: REPO, telemetry: "1" } },
    ],
    colleague: "withheld",
    self: "located",
  },
  "GET /api/work-contexts/:id": { variants: byId("/api/work-contexts/:id"), colleague: "withheld", self: "located" },
  "GET /api/work-contexts/:id/diagnosis": {
    variants: [
      ...byId("/api/work-contexts/:id/diagnosis"),
      // The pull a connector makes from a session, which records a delivery,
      // and the one that leaves telemetry out.
      { path: `/api/work-contexts/${ROBIN_CONTEXT}/diagnosis`, query: { session: NICK_SESSION } },
      { path: `/api/work-contexts/${ROBIN_CONTEXT}/diagnosis`, query: { telemetry: "0" } },
    ],
    colleague: "withheld",
    self: "located",
  },
  "GET /ui": {
    variants: [{ path: "/ui" }],
    status: { code: 303, why: "the UI root redirects to the feed, which is walked itself" },
    colleague: { hidden: "a redirect" },
    self: { none: "a redirect" },
  },
  "GET /ui/approvals": {
    variants: [{ path: "/ui/approvals" }],
    colleague: { hidden: "artifacts awaiting the caller's approval; the seed has none" },
    self: { none: "artifacts awaiting the caller's approval; the seed has none" },
  },
  "GET /ui/contradictions/:id": {
    variants: [{ path: `/ui/contradictions/${CONTRADICTION}` }],
    colleague: "withheld",
    self: "located",
  },
  "GET /ui/feed": {
    variants: [{ path: "/ui/feed" }],
    colleague: PRESENCE("surface 4, the feed page"),
    self: "located",
  },
  "GET /ui/login": { variants: [{ path: "/ui/login" }], colleague: { hidden: "a static form" }, self: { none: "a static form" } },
  "GET /ui/members": { variants: [{ path: "/ui/members" }], colleague: "withheld", self: "located" },
  "GET /ui/passkey.js": { variants: [{ path: "/ui/passkey.js" }], colleague: { hidden: "a static script" }, self: { none: "a static script" } },
  "GET /ui/passkeys": { variants: [{ path: "/ui/passkeys" }], colleague: { hidden: OWN }, self: { none: OWN } },
  "GET /ui/styles.css": { variants: [{ path: "/ui/styles.css" }], colleague: { hidden: "a stylesheet" }, self: { none: "a stylesheet" } },
  "GET /ui/waivers": { variants: [{ path: "/ui/waivers" }], colleague: { hidden: NONE_SEEDED }, self: { none: NONE_SEEDED } },
  "GET /ui/work-contexts/:id": { variants: byId("/ui/work-contexts/:id"), colleague: "withheld", self: "located" },
  // LAST of the reads: the session it starts inside its window reaps her
  // stale one, and every read above is checked on the seed as it stands.
  "GET /api/events/stream": {
    // The WHOLE window, with an event of hers inside it: a session she starts
    // while the stream is open names her branch in its session_started row.
    variants: [
      {
        path: "/api/events/stream",
        during: async (world) => {
          await registerTestSession(world.harness, world.robin.apiKey, {
            id: ROBIN_LATE,
            branch: SECRET_BRANCH,
            baseCommit: SECRET_SHA,
          });
        },
      },
    ],
    colleague: PRESENCE("surface 4"),
    self: "located",
  },
};

const answerClaim = (): Record<string, unknown> =>
  validClaimBody({
    id: "clm_nick_answer",
    workContextId: NICK_CONTEXT,
    authorSessionId: NICK_SESSION,
    kind: "observation",
    body: "The rotation trace drops the key id on refresh",
  });

const WRITE_ROUTES: Readonly<Record<string, RouteSpec>> = {
  "POST /api/landed/context": {
    variants: [
      {
        path: "/api/landed/context",
        body: { repo: REPO, path: FILE, commits: [{ sha: "abcdef1234567", authorEmail: "robin@example.com", committedAt: CREATED_AT }] },
      },
    ],
    colleague: "withheld",
    self: { none: "the stop names OTHER developers' work; the caller's own is excluded" },
  },
  "POST /api/landed/authors": {
    variants: [{ path: "/api/landed/authors", body: { emails: ["robin@example.com", "nobody@example.com"] } }],
    colleague: { hidden: "answers which addresses match no account — never a session or a context" },
    self: { none: WRITE_ACK },
  },
  "POST /api/questions": {
    variants: [
      {
        path: "/api/questions",
        body: { id: "q_nick_guard", repo: REPO, sessionId: NICK_SESSION, body: "What did the rotation trace show?", developer: "Robin", workContextId: ROBIN_CONTEXT },
      },
    ],
    // The ack names the person asked — her — and nothing of where she is.
    colleague: "withheld",
    self: { none: WRITE_ACK },
  },
  "POST /api/questions/:id/answers": {
    variants: [{ path: "/api/questions/q_robin_1/answers", body: { claim: answerClaim() } }],
    // The ack names her question; the answer is Nick's own claim.
    colleague: "withheld",
    self: { none: WRITE_ACK },
  },
  "POST /api/pilot-marks": {
    variants: [
      { path: "/api/pilot-marks", body: { repo: REPO, refKind: "hint_delivery", refId: "hd_robin_1", mark: "helpful", presence: "controlling_terminal", reason: "it named the file I was in" } },
    ],
    colleague: { hidden: "an ack of the caller's own label" },
    self: { none: WRITE_ACK },
  },
  // The ack names the delivery the outcome was recorded on (hd_robin_1, the
  // hint on her work); the walk checks it carries nothing of her location.
  // Robin's own walk is refused (unknown_ref): no hint reached her.
  "POST /api/hint-outcomes": {
    variants: [
      {
        path: "/api/hint-outcomes",
        body: { repo: REPO, ref: ROBIN_CONTEXT, outcome: "followed", reason: "it named the file I was in", session: NICK_SESSION },
      },
    ],
    colleague: "withheld",
    self: { none: WRITE_ACK },
  },
  "POST /api/hint-outcomes/person": {
    variants: [
      { path: "/api/hint-outcomes/person", body: { repo: REPO, ref: "hd_robin_1", outcome: "overrode", reason: "my retry was simpler", session: NICK_SESSION } },
    ],
    colleague: "withheld",
    self: { none: WRITE_ACK },
  },
  "POST /api/records": {
    variants: [
      {
        path: "/api/records",
        body: { records: [recordEnvelope("target", { workContextId: NICK_CONTEXT, kind: "file", value: "src/auth/keys.ts" }, { sessionId: NICK_SESSION })] },
      },
    ],
    colleague: { hidden: "per-record outcomes of the caller's own records" },
    self: { none: WRITE_ACK },
  },
  "POST /api/sessions": {
    variants: [{ path: "/api/sessions", body: { ...VALID_SESSION_BODY, id: "cc_99999999-aaaa-4bbb-8ccc-dddddddddddd", baseOnDefault: false, guarantees: [], losses: EMPTY_LOSS_REPORT, seq: WALK_SEQ } }],
    colleague: { hidden: "registers the caller's own session and answers with it" },
    self: { none: WRITE_ACK },
  },
  "POST /api/sessions/:id/heartbeat": {
    variants: [
      { path: `/api/sessions/${NICK_SESSION}/heartbeat`, body: { status: "implementing" } },
      { path: `/api/sessions/${ROBIN_LIVE}/heartbeat`, body: { status: "implementing", losses: EMPTY_LOSS_REPORT, seq: WALK_SEQ }, refused: "not the caller's session: the refusal must not describe hers" },
    ],
    colleague: { hidden: "a heartbeat of the caller's own session" },
    self: { none: WRITE_ACK },
  },
  "POST /api/sessions/:id/end": {
    variants: [{ path: `/api/sessions/${ROBIN_LIVE}/end`, body: { status: "done", losses: EMPTY_LOSS_REPORT, seq: WALK_SEQ }, refused: "not the caller's session: the refusal must not describe hers" }],
    whyNoVariants: "ending the caller's own session would end the walk's; only the refusal about hers is walked",
    colleague: { hidden: "the refusal of somebody else's session" },
    self: { none: WRITE_ACK },
  },
  "POST /api/settings/mutes": {
    variants: [{ path: "/api/settings/mutes", body: { developer: "Ken" } }],
    colleague: { hidden: "an ack of the caller's own mute" },
    self: { none: WRITE_ACK },
  },
  "DELETE /api/settings/mutes/:ref": {
    variants: [{ path: "/api/settings/mutes/Ken" }],
    colleague: { hidden: "an ack of the caller's own unmute" },
    self: { none: WRITE_ACK },
  },
  "POST /api/pins": {
    variants: [
      ...refusedPost("/api/pins", "a pin needs a surface, files and a check; the refusal is walked"),
      {
        path: "/api/pins",
        body: { id: "pin_nick_walk", repo: REPO, surface: "Rotation keeps the key", files: [FILE], check: "rotate, then refresh", presence: "controlling_terminal", verifiedAtCommit: WALKER_REF },
      },
    ],
    colleague: { hidden: "the caller's own pin" },
    self: { none: WRITE_ACK },
  },
  "POST /api/pins/sweep": {
    variants: [
      ...refusedPost("/api/pins/sweep", "a sweep needs a repo and its updates"),
      // His clone's view of HER pin's path: a sweep any reader may report.
      { path: "/api/pins/sweep", body: { repo: REPO, updates: [{ pinId: ROBIN_PIN, path: ROBIN_NEW_FILE, newPath: ROBIN_NEW_FILE }] } },
    ],
    colleague: { hidden: "an ack: how many path updates were applied" },
    self: { none: WRITE_ACK },
  },
  "POST /api/pins/:id/broke": {
    variants: [
      { path: "/api/pins/pin_none/broke", body: { repo: REPO, presence: "controlling_terminal", brokeAtCommit: WALKER_REF }, refused: "no such pin" },
      // He ran HER pin's check and it failed: a retraction any reader may record.
      { path: `/api/pins/${ROBIN_PIN}/broke`, body: { repo: REPO, presence: "controlling_terminal", brokeAtCommit: WALKER_REF } },
    ],
    // The ack echoes her pin's id, the one the caller sent, and nothing else.
    colleague: "withheld",
    self: { none: WRITE_ACK },
  },
  "POST /api/ci-runs": {
    variants: refusedPost("/api/ci-runs", "a CI run report has a shape of its own"),
    whyNoVariants: "a CI run report: its answer acknowledges the run, naming no developer's work",
    colleague: { hidden: "a CI run, no developer's work" },
    self: { none: WRITE_ACK },
  },
  "POST /api/claim-revalidations": {
    variants: [
      ...refusedPost("/api/claim-revalidations", "a revalidation batch has a shape of its own"),
      // His own reading of his own claim: the answer reads back its validity.
      {
        path: "/api/claim-revalidations",
        body: {
          repo: REPO,
          revalidated: 1,
          total: 1,
          entries: [{ claimId: "clm_nick", result: "unchanged", basis: "context_targets", refCommit: WALKER_REF, touchingCommits: [], touchingTotal: 0 }],
        },
      },
    ],
    colleague: { hidden: "an ack of the caller's own readings" },
    self: { none: WRITE_ACK },
  },
  "POST /api/fence-waivers": {
    variants: refusedPost("/api/fence-waivers", "a waiver names a pin"),
    whyNoVariants: "waives a fence on a pin; the seed pins nothing",
    colleague: { hidden: NONE_SEEDED },
    self: { none: WRITE_ACK },
  },
  "POST /api/fence-waivers/:id/revoke": {
    variants: refusedPost("/api/fence-waivers/fw_none/revoke", "no such waiver"),
    whyNoVariants: "revokes the caller's own waiver; none seeded",
    colleague: { hidden: NONE_SEEDED },
    self: { none: WRITE_ACK },
  },
  "POST /api/waiver-requests": {
    variants: [
      ...refusedPost("/api/waiver-requests", "a request names a pin and a term"),
      // A waiver on HER pin: the request names the pin, never its pinner's location.
      { path: "/api/waiver-requests", body: { repo: REPO, pinId: ROBIN_PIN, pinVersion: 1, reason: "the refresh fix lands tomorrow", expiresAt: WAIVER_UNTIL } },
    ],
    colleague: { hidden: "the caller's own request" },
    self: { none: WRITE_ACK },
  },
  "POST /api/waiver-requests/:id/withdraw": {
    variants: refusedPost("/api/waiver-requests/wr_none/withdraw", "no such request"),
    whyNoVariants: "withdraws the caller's own request; none seeded",
    colleague: { hidden: NONE_SEEDED },
    self: { none: WRITE_ACK },
  },
  "POST /api/developers": {
    variants: refusedPost("/api/developers", ADMIN_ONLY),
    whyNoVariants: "admin identity management: creates a developer and answers with that one",
    colleague: { hidden: ADMIN_ONLY },
    self: { none: ADMIN_ONLY },
  },
  "POST /api/developers/:id/emails": {
    variants: refusedPost("/api/developers/:robin/emails", ADMIN_ONLY),
    whyNoVariants: "admin identity management: an address, never a session",
    colleague: { hidden: ADMIN_ONLY },
    self: { none: ADMIN_ONLY },
  },
  "DELETE /api/developers/:id/emails/:email": {
    variants: [{ path: "/api/developers/:robin/emails/robin%40example.com", refused: ADMIN_ONLY }],
    whyNoVariants: "admin identity management: removes an address",
    colleague: { hidden: ADMIN_ONLY },
    self: { none: ADMIN_ONLY },
  },
  "POST /api/developers/:id/key": {
    variants: refusedPost("/api/developers/:robin/key", ADMIN_ONLY),
    whyNoVariants: "admin key management: issues a key, never a session",
    colleague: { hidden: ADMIN_ONLY },
    self: { none: ADMIN_ONLY },
  },
  "POST /api/developers/:id/passkey-enrollments": {
    variants: refusedPost("/api/developers/:robin/passkey-enrollments", ADMIN_ONLY),
    whyNoVariants: "admin passkey enrolment",
    colleague: { hidden: ADMIN_ONLY },
    self: { none: ADMIN_ONLY },
  },
  "POST /api/developers/:id/passkeys/:passkeyId/revoke": {
    variants: refusedPost("/api/developers/:robin/passkeys/pk_none/revoke", ADMIN_ONLY),
    whyNoVariants: "admin passkey revocation",
    colleague: { hidden: ADMIN_ONLY },
    self: { none: ADMIN_ONLY },
  },
  "POST /api/keys/rotate": {
    variants: [],
    notCalled: "rotates the caller's own key: the walk would lose its credential, and the answer is a key",
    colleague: { hidden: "the caller's own key" },
    self: { none: "the caller's own key" },
  },
  "PUT /api/settings/presence": {
    variants: [],
    notCalled: "toggles the caller's own opt-out — Nick opting out would change the premise the walk checks",
    colleague: { hidden: OWN },
    self: { none: OWN },
  },
  "PUT /api/team-settings": {
    variants: [{ path: "/api/team-settings", body: { repo: REPO, pilotEnrolled: true }, refused: "admin team configuration" }],
    whyNoVariants: "admin team configuration names no developer",
    colleague: { hidden: "team configuration names no developer" },
    self: { none: "team configuration names no developer" },
  },
  "POST /ui/login": {
    variants: [{ path: "/ui/login", body: { apiKey: "not-a-key" }, refused: "the login takes a form, not JSON" }],
    whyNoVariants: "exchanges a key for a cookie; answers with a redirect",
    colleague: { hidden: "a login" },
    self: { none: "a login" },
  },
  "POST /ui/logout": {
    variants: [],
    notCalled: "ends the walk's own UI session",
    colleague: { hidden: "a logout" },
    self: { none: "a logout" },
  },
  "POST /ui/artifacts/:id/approve": {
    variants: [{ path: "/ui/artifacts/art_none/approve", body: { _csrf: "not-this-session" }, refused: "a form post; release takes a passkey ceremony" }],
    whyNoVariants: "refuses every post: release is a passkey ceremony on /ui/webauthn",
    colleague: { hidden: NONE_SEEDED },
    self: { none: WRITE_ACK },
  },
  "POST /ui/artifacts/:id/revoke": {
    variants: [{ path: "/ui/artifacts/art_none/revoke", body: { _csrf: "not-this-session" }, refused: "no such artifact; a form post" }],
    whyNoVariants: "withdraws the caller's own release; none seeded",
    colleague: { hidden: NONE_SEEDED },
    self: { none: WRITE_ACK },
  },
  "POST /api/artifacts/:id/withdraw": {
    variants: refusedPost("/api/artifacts/art_none/withdraw", ADMIN_ONLY),
    whyNoVariants: "the operator's re-hide of a release",
    colleague: { hidden: ADMIN_ONLY },
    self: { none: ADMIN_ONLY },
  },
  "POST /ui/passkeys/:id/revoke": {
    variants: [{ path: "/ui/passkeys/pk_none/revoke", body: { _csrf: "not-this-session" }, refused: "no such passkey; a form post" }],
    whyNoVariants: "revokes the caller's own passkey; none seeded",
    colleague: { hidden: NONE_SEEDED },
    self: { none: WRITE_ACK },
  },
  "POST /ui/webauthn/options": {
    variants: refusedPost("/ui/webauthn/options", "a WebAuthn ceremony needs a browser"),
    whyNoVariants: "a WebAuthn challenge for the caller",
    colleague: { hidden: "a WebAuthn challenge" },
    self: { none: "a WebAuthn challenge" },
  },
  "POST /ui/webauthn/verify": {
    variants: refusedPost("/ui/webauthn/verify", "a WebAuthn ceremony needs a browser"),
    whyNoVariants: "verifies the caller's WebAuthn assertion",
    colleague: { hidden: "a WebAuthn verification" },
    self: { none: "a WebAuthn verification" },
  },
};

/**
 * Every route, GET first: the reads run on the seed as it stands, the writes
 * after them, so no write the walk makes changes what a read was checked on.
 */
export const ROUTES: Readonly<Record<string, RouteSpec>> = { ...GET_ROUTES, ...WRITE_ROUTES };
