/**
 * ONE SEED FOR EVERY LIVE-LOCATION TEST: an opted-out Robin whose location
 * is spelled in strings that occur nowhere else, so a response either names
 * one of them or it does not (services/live-location.ts, visibility.ts).
 *
 * Her branch, both HEADs and every instant that says WHEN she was there —
 * session start, live heartbeat, stale heartbeat, last context update — are
 * distinct from every published value in the seed: createdAt of her contexts
 * and claims, the questions' instants, the deliveries. A test can therefore
 * grep a response for SECRETS without a published field ever matching.
 *
 * What she has, so every surface has something of hers to say:
 *   - a LIVE session and a STALE open one on SECRET_BRANCH at SECRET_SHA, and
 *     a session on a `local:` repo (no remote, so no repo label) at SECRET_SHA2
 *   - contexts under the connector's honest fallback titles — `<branch> @ api`,
 *     the bare branch on the local repo, a detached `detached@<sha> · subject`
 *     on the local repo — and one host-written title that merely ENDS in
 *     ` @ api` (titleSource "host", which must stay)
 *   - a claim contradicting Nick's, a solved tree on the failure Nick is live
 *     on, two questions to Nick about her contexts (one hers, one Ken's)
 *   - a pilot-enrolled repo with a prompt hint about her context delivered to
 *     Nick, and opened
 */
import { sql } from "drizzle-orm";

import { hintDeliveries } from "../src/db/schema.ts";
import { draftOutcome } from "../src/services/draft-doors.ts";
import {
  TEST_ADMIN_TOKEN,
  TEST_START_ISO,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validClaimBody,
  validWorkContextBody,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";
import { loginUi, setPresenceOptOutViaApi } from "./ui-helpers.ts";

export const REPO = "github.com/acme/api";
export const LOCAL_REPO = "local:0123456789abcdef";
export const SECRET_BRANCH = "feat/robin-relocates-to-zurich";
export const SECRET_LOCAL_BRANCH = "feat/robin-hideout-geneva";
export const SECRET_SHA = "f00dfacecafe0123456789abcdef0123456789ab";
export const SECRET_SHA2 = "beefbeefbeef0123456789abcdef0123456789ab";
export const FILE = "src/auth/refresh.ts";
export const FINGERPRINT = "TypeError: key id expired at refresh";

export const NICK_SESSION = "cc_11111111-2222-4333-8444-555555555555";
export const KEN_SESSION = "cc_22222222-3333-4444-8555-666666666666";
export const ROBIN_LIVE = "cc_44444444-5555-4666-8777-888888888888";
export const ROBIN_STALE = "cc_55555555-6666-4777-8888-999999999999";
export const ROBIN_LOCAL = "cc_66666666-7777-4888-8999-aaaaaaaaaaaa";

export const NICK_CONTEXT = "wc_nick_live";
export const ROBIN_CONTEXT = "wc_robin_live";
export const ROBIN_SOLVED = "wc_robin_solved";
export const ROBIN_LOCAL_CONTEXT = "wc_robin_local";
export const ROBIN_DETACHED_CONTEXT = "wc_robin_detached";
export const ROBIN_HOST_CONTEXT = "wc_robin_host";
/**
 * Created long before every window a surface applies (conference, suspect,
 * a since=) and touched again at UPDATED_AT: inside a window only by her
 * last touch — so to a colleague it must be outside.
 */
export const ROBIN_OLD_CONTEXT = "wc_robin_old";
export const OLD_TITLE = "Rotation drill from last quarter";

/** A host-written title that merely ends like a fallback one. */
export const HOST_TITLE = "Fix the 500 on POST /login @ api";
export const DETACHED_TITLE = `detached@${SECRET_SHA2.slice(0, 9)} · Try the other key order`;

const at = (offsetSeconds: number): string =>
  new Date(Date.parse(TEST_START_ISO) + offsetSeconds * 1000).toISOString();

/*
 * THE TIMELINE IS SPACED FOR A TOLERANT GUARD (review round 4, H5). The
 * guard counts any time within SECRET_TOLERANCE_MS of a secret instant as a
 * leak, in whatever spelling — so every PUBLISHED instant (creation, the
 * questions, the read itself, the read's minute) sits more than that from
 * every secret, and the read falls on a whole minute. Her live session still
 * counts as live at the read: its last record lands inside PRESENCE_TTL.
 */
const STARTED_OFFSET_S = 1100;
const CREATED_OFFSET_S = 1300;
const HOST_CREATED_OFFSET_S = 1360;
const ASKED_OFFSET_S = 1400;
const HEARTBEAT_OFFSET_S = 4140;
const UPDATED_OFFSET_S = 4170;
const DEDUP_OFFSET_S = 4176;
const TARGET_OFFSET_S = 4182;
const LANDED_OFFSET_S = 4188;
const PIN_OFFSET_S = 4194;
const REVALIDATED_OFFSET_S = 4200;
const LATE_SESSION_OFFSET_S = 4206;
const LATE_SESSION_ENDED_OFFSET_S = 4212;
const COMMIT_EVIDENCE_OFFSET_S = 4245;
const READ_OFFSET_S = 4320;
const STALE_HOURS = 30;
const SECONDS_PER_HOUR = 3600;
const OLD_DAYS = 90;
const SECONDS_PER_DAY = 86_400;

/** When Robin's sessions started — `workStartedAt` on a landed stop. */
export const STARTED_AT = at(STARTED_OFFSET_S);
/** When her contexts and claims were created: PUBLISHED, so never a secret. */
export const CREATED_AT = at(CREATED_OFFSET_S);
/**
 * Her host-titled context is created a minute LATER and never touched again:
 * ranked by creation it is her freshest, ranked by her last touch it is not —
 * which is how a test sees which of the two a colleague's order follows.
 */
export const HOST_CREATED_AT = at(HOST_CREATED_OFFSET_S);
/** Her live session's last heartbeat. */
export const HEARTBEAT_AT = at(HEARTBEAT_OFFSET_S);
/** Her live context's last update — `updatedAt`, `lastActiveAt`. */
export const UPDATED_AT = at(UPDATED_OFFSET_S);
/** Her stale open session's last heartbeat. */
export const STALE_HEARTBEAT_AT = at(-STALE_HOURS * SECONDS_PER_HOUR);
/**
 * Her activity AFTER the opt-out (review round 4): each instant is when her
 * agent did something, and none may reach a colleague in any form.
 */
/** Her agent re-observed clm_robin (dedup): its lastSeenAt. */
export const DEDUP_AT = at(DEDUP_OFFSET_S);
/** Her agent touched a new file on her host context: the target's createdAt. */
export const TARGET_AT = at(TARGET_OFFSET_S);
/** Her own session reported landed evidence: when the hub stamped landedAt. */
export const LANDED_AT = at(LANDED_OFFSET_S);
/** She pinned a surface: verifiedAt (and verifiedAtCommit is her HEAD). */
export const PIN_AT = at(PIN_OFFSET_S);
export const ROBIN_PIN = "pin_robin_refresh";
/** Her pull re-checked Nick's claim against HER clone: refCommit is SECRET_SHA. */
export const REVALIDATED_AT = at(REVALIDATED_OFFSET_S);
/** A session she started after the opt-out, and ended six seconds later. */
export const ROBIN_AFTER = "cc_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const LATE_SESSION_AT = at(LATE_SESSION_OFFSET_S);
export const LATE_SESSION_ENDED_AT = at(LATE_SESSION_ENDED_OFFSET_S);
/** When every walk reads: a whole minute, more than the tolerance after her last act. */
export const READ_AT = at(READ_OFFSET_S);
/** Her SessionStart reported who committed lately: its collectedAt is when she was there. */
export const COMMIT_EVIDENCE_AT = at(COMMIT_EVIDENCE_OFFSET_S);
/** When Nick's SessionStart reported the same — his, so a colleague may read it. */
export const NICK_EVIDENCE_AT = at(0);
export const ROBIN_NEW_FILE = "src/auth/cache.ts";
/** A failure her agent observed after the opt-out: its target's createdAt is TARGET_AT. */
export const ROBIN_FINGERPRINT = "sha256:0badc0de0badc0de";
/** When ROBIN_OLD_CONTEXT was created: published, and outside every window. */
export const OLD_CREATED_AT = at(-OLD_DAYS * SECONDS_PER_DAY);

const MS_PER_SECOND = 1000;

const instantForms = (iso: string): readonly string[] => {
  const ms = Date.parse(iso);
  return [iso, iso.slice(0, 19), String(ms), String(Math.floor(ms / MS_PER_SECOND))];
};

const SHA_PREFIX_MIN = 7;
const SHA_PREFIX_MAX = 12;

const shaForms = (sha: string): readonly string[] => [
  ...Array.from({ length: SHA_PREFIX_MAX - SHA_PREFIX_MIN + 1 }, (_unused, index) =>
    sha.slice(0, SHA_PREFIX_MIN + index),
  ),
  sha,
];

/**
 * Every spelling of Robin's live location a response could carry: both
 * branches, both HEADs whole and by every prefix git prints (7–12), and each
 * secret instant in ISO, ISO-to-the-second, epoch-ms and epoch-s form.
 */
export const SECRETS: readonly (readonly [label: string, value: string])[] = [
  ["branch", SECRET_BRANCH],
  ["local branch", SECRET_LOCAL_BRANCH],
  ...shaForms(SECRET_SHA).map((value) => [`sha ${String(value.length)}`, value] as const),
  ...shaForms(SECRET_SHA2).map((value) => [`local sha ${String(value.length)}`, value] as const),
  ...instantForms(STARTED_AT).map((value) => ["session start", value] as const),
  ...instantForms(HEARTBEAT_AT).map((value) => ["heartbeat", value] as const),
  ...instantForms(UPDATED_AT).map((value) => ["context update", value] as const),
  ...instantForms(STALE_HEARTBEAT_AT).map((value) => ["stale heartbeat", value] as const),
  ...instantForms(DEDUP_AT).map((value) => ["re-observation", value] as const),
  ...instantForms(TARGET_AT).map((value) => ["file touched", value] as const),
  ...instantForms(LANDED_AT).map((value) => ["landed report", value] as const),
  ...instantForms(PIN_AT).map((value) => ["pin verified", value] as const),
  ...instantForms(REVALIDATED_AT).map((value) => ["revalidation", value] as const),
  ...instantForms(COMMIT_EVIDENCE_AT).map((value) => ["commit evidence", value] as const),
  ...instantForms(LATE_SESSION_AT).map((value) => ["late session start", value] as const),
  ...instantForms(LATE_SESSION_ENDED_AT).map((value) => ["session end", value] as const),
];

/** The labels of every secret `body` carries — empty when it carries none. */
export const secretsIn = (body: string): readonly string[] => [
  ...new Set(SECRETS.filter(([, value]) => body.includes(value)).map(([label]) => label)),
];

/** Every instant that says when she was there, by label. */
export const SECRET_INSTANTS: readonly (readonly [label: string, iso: string])[] = [
  ["session start", STARTED_AT],
  ["heartbeat", HEARTBEAT_AT],
  ["context update", UPDATED_AT],
  ["stale heartbeat", STALE_HEARTBEAT_AT],
  ["re-observation", DEDUP_AT],
  ["file touched", TARGET_AT],
  ["landed report", LANDED_AT],
  ["pin verified", PIN_AT],
  ["revalidation", REVALIDATED_AT],
  ["commit evidence", COMMIT_EVIDENCE_AT],
  ["late session start", LATE_SESSION_AT],
  ["session end", LATE_SESSION_ENDED_AT],
];

/**
 * HOW NEAR COUNTS AS THE SAME INSTANT (review round 4, H5): a minute either
 * way — a time rounded to the minute, an age in whole seconds or minutes, a
 * clock a little off all still say when she was there.
 */
export const SECRET_TOLERANCE_MS = 60_000;

const MS_PER_MINUTE = 60_000;

/** Calendar times in any spelling a response could use: ISO, Postgres text, minute precision. */
const CALENDAR_TIME = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?/g;
/** Epoch seconds or milliseconds, standing alone. */
const EPOCH = /(?<![\d.])\d{10}(?:\d{3})?(?![\d.])/g;
/** An age a renderer wrote: "4m ago", "75 seconds ago", "1 min ago". */
const RELATIVE_AGE = /(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?)\s+ago/gi;
/** A JSON number whose key says it is an age in seconds or ms: idleSeconds, ageMs, sinceSecondsAgo… */
const AGE_FIELD = /"([A-Za-z_]*?(?:[Ss]econds|[Ss]ecs|Ms)(?:Ago)?)"\s*:\s*(\d+(?:\.\d+)?)/g;

const calendarMs = (text: string): number => {
  const iso = text.replace(" ", "T");
  const zoned = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(iso)
    ? iso.replace(/([+-]\d{2})$/, "$1:00")
    : `${iso}Z`;
  return Date.parse(zoned);
};

const ageMs = (value: number, unit: string): number =>
  /^m/i.test(unit) ? value * MS_PER_MINUTE : value * MS_PER_SECOND;

/** Every time `text` states, absolute or as an age at `now`, in milliseconds. */
const timesIn = (text: string, now: Date): readonly number[] => [
  ...[...text.matchAll(CALENDAR_TIME)].map((match) => calendarMs(match[0])),
  ...[...text.matchAll(EPOCH)].map((match) =>
    match[0].length === 13 ? Number(match[0]) : Number(match[0]) * MS_PER_SECOND,
  ),
  ...[...text.matchAll(RELATIVE_AGE)].map((match) => now.getTime() - ageMs(Number(match[1]), match[2] ?? "s")),
  ...[...text.matchAll(AGE_FIELD)].map((match) =>
    now.getTime() - (/Ms$/.test(match[1] ?? "") ? Number(match[2]) : Number(match[2]) * MS_PER_SECOND),
  ),
].filter((ms) => !Number.isNaN(ms));

/**
 * THE TOLERANT SCAN: the label of every secret instant some time in `text`
 * falls within SECRET_TOLERANCE_MS of — whatever its spelling, its
 * precision, or whether it is an age.
 */
export const instantsNear = (
  text: string,
  instants: readonly (readonly [label: string, iso: string])[],
  now: Date,
): readonly string[] => {
  const times = timesIn(text, now);
  return instants
    .filter(([, iso]) => times.some((ms) => Math.abs(ms - Date.parse(iso)) <= SECRET_TOLERANCE_MS))
    .map(([label]) => `${label} (±${String(SECRET_TOLERANCE_MS / MS_PER_SECOND)} s)`);
};

export const instantLeaksIn = (text: string, now: Date): readonly string[] =>
  instantsNear(text, SECRET_INSTANTS, now);

/** Every leak `text` carries: the exact spellings, then the tolerant instants. */
export const leaksIn = (text: string, now: Date): readonly string[] => [
  ...new Set([...secretsIn(text), ...instantLeaksIn(text, now)]),
];

export interface OptedOutWorld {
  readonly harness: TestHarness;
  readonly nick: TestDeveloper;
  readonly ken: TestDeveloper;
  readonly robin: TestDeveloper;
  readonly nickCookie: string;
  readonly kenCookie: string;
  readonly robinCookie: string;
}

const assertAccepted = (
  posted: Awaited<ReturnType<typeof postRecords>>,
  who: string,
): void => {
  if (posted.status !== 200 || (posted.data?.rejected ?? 1) > 0) {
    throw new Error(`${who}'s seed was not accepted: ${JSON.stringify(posted.data?.results)}`);
  }
};

const assertOk = async (response: Response, what: string): Promise<void> => {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${what} answered ${String(response.status)}: ${await response.text()}`);
  }
};

const oldContext = (status: string): Record<string, unknown> =>
  recordEnvelope(
    "work_context",
    validWorkContextBody({ id: ROBIN_OLD_CONTEXT, sessionId: ROBIN_LIVE, title: OLD_TITLE, titleSource: "host", status, createdAt: OLD_CREATED_AT }),
    { sessionId: ROBIN_LIVE },
  );

const robinContexts = (): readonly Record<string, unknown>[] => [
  oldContext("analyzing"),
  recordEnvelope(
    "work_context",
    validWorkContextBody({ id: ROBIN_CONTEXT, sessionId: ROBIN_LIVE, title: `${SECRET_BRANCH} @ api`, titleSource: "fallback", createdAt: CREATED_AT }),
    { sessionId: ROBIN_LIVE },
  ),
  recordEnvelope(
    "work_context",
    validWorkContextBody({ id: ROBIN_HOST_CONTEXT, sessionId: ROBIN_LIVE, title: HOST_TITLE, titleSource: "host", createdAt: HOST_CREATED_AT }),
    { sessionId: ROBIN_LIVE },
  ),
  // The stale session's context is the SOLVED tree, and carries no marker:
  // an older connector's row, judged by its shape.
  recordEnvelope(
    "work_context",
    validWorkContextBody({ id: ROBIN_SOLVED, sessionId: ROBIN_STALE, title: `${SECRET_BRANCH} @ api`, createdAt: CREATED_AT }),
    { sessionId: ROBIN_STALE },
  ),
  // A no-remote repo: the fallback title is the BARE branch, and a detached
  // worktree's is `detached@<sha> · subject`, with no ` @ <label>` to spot.
  // Unmarked too, so the shape rule is what must catch them.
  recordEnvelope(
    "work_context",
    validWorkContextBody({ id: ROBIN_LOCAL_CONTEXT, sessionId: ROBIN_LOCAL, title: SECRET_LOCAL_BRANCH, description: "rotation window refresh scratch", createdAt: CREATED_AT }),
    { sessionId: ROBIN_LOCAL },
  ),
  recordEnvelope(
    "work_context",
    validWorkContextBody({ id: ROBIN_DETACHED_CONTEXT, sessionId: ROBIN_LOCAL, title: DETACHED_TITLE, description: "rotation window refresh detached", createdAt: CREATED_AT }),
    { sessionId: ROBIN_LOCAL },
  ),
];

const targetsOf = (workContextId: string, sessionId: string): readonly Record<string, unknown>[] => [
  recordEnvelope("target", { workContextId, kind: "file", value: FILE }, { sessionId }),
  recordEnvelope("target", { workContextId, kind: "error_fingerprint", value: FINGERPRINT }, { sessionId }),
];

const robinClaims = (): readonly Record<string, unknown>[] => [
  recordEnvelope(
    "claim",
    validClaimBody({ id: "clm_robin", workContextId: ROBIN_CONTEXT, authorSessionId: ROBIN_LIVE, kind: "hypothesis", status: "rejected", body: "Rotation finished inside its window on every sampled failure", createdAt: CREATED_AT }),
    { sessionId: ROBIN_LIVE },
  ),
  recordEnvelope(
    "claim",
    validClaimBody({ id: "clm_robin_evidence", workContextId: ROBIN_SOLVED, authorSessionId: ROBIN_STALE, kind: "evidence", body: "The trace shows the rotated key id being dropped", createdAt: CREATED_AT }),
    { sessionId: ROBIN_STALE },
  ),
  recordEnvelope(
    "claim",
    validClaimBody({ id: "clm_robin_root", workContextId: ROBIN_SOLVED, authorSessionId: ROBIN_STALE, kind: "root_cause", status: "likely_root_cause", confidence: 0.9, evidenceRefs: ["clm_robin_evidence"], body: "The ingestion mapping drops the key id on rotation", createdAt: CREATED_AT }),
    { sessionId: ROBIN_STALE },
  ),
  recordEnvelope(
    "claim",
    validClaimBody({ id: "clm_robin_local", workContextId: ROBIN_LOCAL_CONTEXT, authorSessionId: ROBIN_LOCAL, kind: "hypothesis", body: "Rotation window refresh fails in the scratch repo", createdAt: CREATED_AT }),
    { sessionId: ROBIN_LOCAL },
  ),
];

const robinWork = (): readonly Record<string, unknown>[] => [
  ...robinContexts(),
  ...targetsOf(ROBIN_CONTEXT, ROBIN_LIVE),
  ...targetsOf(ROBIN_HOST_CONTEXT, ROBIN_LIVE),
  ...targetsOf(ROBIN_SOLVED, ROBIN_STALE),
  ...targetsOf(ROBIN_OLD_CONTEXT, ROBIN_LIVE),
  ...robinClaims(),
];

const nickWork = (): readonly Record<string, unknown>[] => [
  recordEnvelope("work_context", validWorkContextBody({ id: NICK_CONTEXT, sessionId: NICK_SESSION, title: "Key rotation" }), { sessionId: NICK_SESSION }),
  ...targetsOf(NICK_CONTEXT, NICK_SESSION),
  recordEnvelope(
    "claim",
    validClaimBody({ id: "clm_nick", workContextId: NICK_CONTEXT, authorSessionId: NICK_SESSION, kind: "hypothesis", status: "proposed", body: "The rotation job overruns its window and drops the key" }),
    { sessionId: NICK_SESSION },
  ),
  // Nick's SessionStart reported Ken's commits first; hers repeats it later.
  recordEnvelope(
    "commit_evidence",
    { repo: REPO, collectedAt: NICK_EVIDENCE_AT, windowDays: 14, authors: [KEN_AUTHOR] },
    { sessionId: NICK_SESSION },
  ),
];

const askNick = async (
  world: Pick<OptedOutWorld, "harness" | "ken" | "robin">,
): Promise<void> => {
  await assertOk(
    await world.harness.app.request("/api/questions", jsonRequest("POST", world.robin.apiKey, {
      id: "q_robin_1", repo: REPO, sessionId: ROBIN_LIVE, body: "Can you look at my rotation fix?", developer: "Nick", workContextId: ROBIN_CONTEXT,
    })),
    "Robin's question",
  );
  await assertOk(
    await world.harness.app.request("/api/questions", jsonRequest("POST", world.ken.apiKey, {
      id: "q_ken_1", repo: REPO, sessionId: KEN_SESSION, body: "Do you know what this is about?", developer: "Nick", workContextId: ROBIN_SOLVED,
    })),
    "Ken's question",
  );
};

const seedTeam = async (harness: TestHarness): Promise<Pick<OptedOutWorld, "nick" | "ken" | "robin">> => {
  // Enrolled FIRST: a delivery counts for the pilot only to a session that
  // started after labels became available.
  await assertOk(
    await harness.app.request("/api/team-settings", jsonRequest("PUT", TEST_ADMIN_TOKEN, { repo: REPO, pilotEnrolled: true })),
    "pilot enrolment",
  );
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  const ken = await createTestDeveloper(harness, "Ken", "ken@example.com");
  const robin = await createTestDeveloper(harness, "Robin", "robin@example.com");
  // One second apart, so every listing ordered by creation orders them the
  // same in every world — their ids, the tie-break, are random per seed.
  for (const [index, developer] of [nick, ken, robin].entries()) {
    await harness.db.execute(
      sql`UPDATE developers SET created_at = ${new Date(Date.parse(TEST_START_ISO) - (3 - index) * MS_PER_SECOND).toISOString()} WHERE id = ${developer.developerId}`,
    );
  }
  await assertOk(await registerTestSession(harness, nick.apiKey, { id: NICK_SESSION }), "Nick's session");
  await assertOk(await registerTestSession(harness, ken.apiKey, { id: KEN_SESSION }), "Ken's session");
  assertAccepted(await postRecords(harness, nick, { records: nickWork() }), "Nick");
  assertAccepted(
    await postRecords(harness, ken, {
      records: [recordEnvelope("work_context", validWorkContextBody({ id: "wc_ken", sessionId: KEN_SESSION, title: "Ken's own work" }), { sessionId: KEN_SESSION })],
    }),
    "Ken",
  );
  return { nick, ken, robin };
};

const seedRobin = async (harness: TestHarness, robin: TestDeveloper): Promise<void> => {
  harness.clock.advanceSeconds(STARTED_OFFSET_S);
  // `baseOnDefault: false` — a current connector whose base was not yet on
  // main — so that a report of her base is a real landing and the landed
  // oracle and residual below measure the presence rule, not the age rule.
  for (const id of [ROBIN_LIVE, ROBIN_STALE]) {
    await assertOk(
      await registerTestSession(harness, robin.apiKey, { id, branch: SECRET_BRANCH, baseCommit: SECRET_SHA, baseOnDefault: false }),
      `Robin's session ${id}`,
    );
  }
  await assertOk(
    await registerTestSession(harness, robin.apiKey, { id: ROBIN_LOCAL, repo: LOCAL_REPO, branch: SECRET_LOCAL_BRANCH, baseCommit: SECRET_SHA2, baseOnDefault: false }),
    "Robin's local session",
  );
  harness.clock.advanceSeconds(CREATED_OFFSET_S - STARTED_OFFSET_S);
  assertAccepted(await postRecords(harness, robin, { records: robinWork() }), "Robin");
};

/** Her live heartbeat, then her live context's update — the two newest instants. */
const robinGoesOnWorking = async (harness: TestHarness, robin: TestDeveloper): Promise<void> => {
  harness.clock.advanceSeconds(HEARTBEAT_OFFSET_S - ASKED_OFFSET_S);
  await assertOk(
    await harness.app.request(`/api/sessions/${ROBIN_LIVE}/heartbeat`, jsonRequest("POST", robin.apiKey, { status: "implementing" })),
    "Robin's heartbeat",
  );
  harness.clock.advanceSeconds(UPDATED_OFFSET_S - HEARTBEAT_OFFSET_S);
  assertAccepted(
    await postRecords(harness, robin, {
      records: [
        recordEnvelope(
          "work_context",
          validWorkContextBody({ id: ROBIN_CONTEXT, sessionId: ROBIN_LIVE, title: `${SECRET_BRANCH} @ api`, titleSource: "fallback", status: "implementing", createdAt: CREATED_AT }),
          { sessionId: ROBIN_LIVE },
        ),
        oldContext("implementing"),
      ],
    }),
    "Robin's update",
  );
};

/**
 * What her agent does AFTER she opted out, each at its own instant: the
 * work goes on, and only its time is hers to keep (review round 4, H3, M3).
 */
const robinActsAfterOptOut = async (harness: TestHarness, robin: TestDeveloper): Promise<void> => {
  harness.clock.advanceSeconds(DEDUP_OFFSET_S - UPDATED_OFFSET_S);
  assertAccepted(
    await postRecords(harness, robin, {
      records: [
        recordEnvelope(
          "claim",
          validClaimBody({ id: "clm_robin_again", workContextId: ROBIN_CONTEXT, authorSessionId: ROBIN_LIVE, kind: "hypothesis", status: "rejected", body: "Rotation finished inside its window on every sampled failure", createdAt: DEDUP_AT }),
          { sessionId: ROBIN_LIVE },
        ),
      ],
    }),
    "Robin's re-observation",
  );
  harness.clock.advanceSeconds(TARGET_OFFSET_S - DEDUP_OFFSET_S);
  assertAccepted(
    await postRecords(harness, robin, {
      records: [
        recordEnvelope("target", { workContextId: ROBIN_HOST_CONTEXT, kind: "file", value: ROBIN_NEW_FILE }, { sessionId: ROBIN_LIVE }),
        // A failure her agent observed, and two findings that cite it: the
        // evidence rung's age is the target's time, so it travels with her
        // ruled-out approach (the referee brief) and her newest root cause
        // (the solved pointer). Created at a PUBLISHED instant, so only the
        // rung can carry the secret.
        recordEnvelope("target", { workContextId: ROBIN_CONTEXT, kind: "error_fingerprint", value: ROBIN_FINGERPRINT }, { sessionId: ROBIN_LIVE }),
        // Sent from her LIVE session: a record is a heartbeat (services/
        // records.ts), and the stale session must stay silent.
        recordEnvelope("target", { workContextId: ROBIN_SOLVED, kind: "error_fingerprint", value: ROBIN_FINGERPRINT }, { sessionId: ROBIN_LIVE }),
        recordEnvelope(
          "claim",
          validClaimBody({ id: "clm_robin_ruled_out", workContextId: ROBIN_CONTEXT, authorSessionId: ROBIN_LIVE, kind: "rejected_approach", status: "rejected", body: "Retrying the refresh call does not bring the key back", verificationRef: `error_fingerprint:${ROBIN_FINGERPRINT}`, createdAt: HOST_CREATED_AT }),
          { sessionId: ROBIN_LIVE },
        ),
        recordEnvelope(
          "claim",
          validClaimBody({ id: "clm_robin_root_checked", workContextId: ROBIN_SOLVED, authorSessionId: ROBIN_LIVE, kind: "root_cause", status: "likely_root_cause", confidence: 0.9, evidenceRefs: ["clm_robin_evidence"], body: "The key id is dropped before the refresh call reaches the cache", verificationRef: `error_fingerprint:${ROBIN_FINGERPRINT}`, createdAt: HOST_CREATED_AT }),
          { sessionId: ROBIN_LIVE },
        ),
      ],
    }),
    "Robin's new file and observed failure",
  );
  harness.clock.advanceSeconds(LANDED_OFFSET_S - TARGET_OFFSET_S);
  assertAccepted(
    await postRecords(harness, robin, {
      records: [
        recordEnvelope(
          "landed_evidence",
          { repo: LOCAL_REPO, defaultBranch: "main", checkedAt: LANDED_AT, commits: [SECRET_SHA2] },
          { sessionId: ROBIN_LOCAL },
        ),
      ],
    }),
    "Robin's landed report",
  );
  harness.clock.advanceSeconds(PIN_OFFSET_S - LANDED_OFFSET_S);
  await assertOk(
    await harness.app.request("/api/pins", jsonRequest("POST", robin.apiKey, {
      id: ROBIN_PIN,
      repo: REPO,
      surface: "Refresh keeps the session alive",
      files: [ROBIN_NEW_FILE],
      check: "log in, rotate the key, refresh",
      presence: "controlling_terminal",
      verifiedAtCommit: SECRET_SHA,
    })),
    "Robin's pin",
  );
  harness.clock.advanceSeconds(REVALIDATED_OFFSET_S - PIN_OFFSET_S);
  await assertOk(
    await harness.app.request("/api/claim-revalidations", jsonRequest("POST", robin.apiKey, {
      repo: REPO,
      revalidated: 1,
      total: 1,
      entries: [{ claimId: "clm_nick", result: "unchanged", basis: "context_targets", refCommit: SECRET_SHA, touchingCommits: [], touchingTotal: 0 }],
    })),
    "Robin's revalidation",
  );
  // A session started and ended after the opt-out: both instants are hers.
  harness.clock.advanceSeconds(LATE_SESSION_OFFSET_S - REVALIDATED_OFFSET_S);
  await assertOk(
    await registerTestSession(harness, robin.apiKey, { id: ROBIN_AFTER, branch: SECRET_BRANCH, baseCommit: SECRET_SHA }),
    "Robin's late session",
  );
  harness.clock.advanceSeconds(LATE_SESSION_ENDED_OFFSET_S - LATE_SESSION_OFFSET_S);
  await assertOk(
    await harness.app.request(`/api/sessions/${ROBIN_AFTER}/end`, jsonRequest("POST", robin.apiKey, { status: "done" })),
    "Robin's late session's end",
  );
  harness.clock.advanceSeconds(COMMIT_EVIDENCE_OFFSET_S - LATE_SESSION_ENDED_OFFSET_S);
  assertAccepted(
    await postRecords(harness, robin, {
      records: [
        recordEnvelope(
          "commit_evidence",
          { repo: REPO, collectedAt: COMMIT_EVIDENCE_AT, windowDays: 14, authors: [KEN_AUTHOR, SAM_AUTHOR] },
          { sessionId: ROBIN_LIVE },
        ),
      ],
    }),
    "Robin's commit evidence",
  );
};

/** A teammate's commits, as any clone's git log sees them: Nick's report and hers both name him. */
const KEN_AUTHOR = { name: "Ken", email: "ken@example.com", latestCommitAt: TEST_START_ISO, commitCount: 2 } as const;
/** A committer with no crosscheck account, whom only HER report names. */
const SAM_AUTHOR = { name: "Sam", email: "sam@example.com", latestCommitAt: TEST_START_ISO, commitCount: 1 } as const;

export const seedOptedOutWorld = async (): Promise<OptedOutWorld> => {
  const harness = await createTestHarness();
  const { nick, ken, robin } = await seedTeam(harness);
  await seedRobin(harness, robin);
  harness.clock.advanceSeconds(ASKED_OFFSET_S - CREATED_OFFSET_S);
  await askNick({ harness, ken, robin });
  // Nick was shown Robin's context by a prompt hint, and opened it.
  await harness.db.insert(hintDeliveries).values({
    id: "hd_robin_1",
    sessionId: NICK_SESSION,
    refKind: "work_context",
    refId: ROBIN_CONTEXT,
    channel: "prompt_hint",
    deliveredAt: harness.clock.now(),
    pulledAt: new Date(harness.clock.now().getTime() + MS_PER_SECOND),
  });
  // His agent DRAFTED what came of it, through the agent's own door, and
  // nobody confirmed it yet: his /ui/confirm shows the work that hint pointed
  // at — hers — so her title is walked on that page too (human provenance §6).
  const drafted = await draftOutcome(
    { db: harness.db, now: () => harness.clock.now() },
    { repo: REPO, ref: "hd_robin_1", outcome: "followed", reason: null, session: NICK_SESSION, recordedBy: nick.developerId, recordedVia: "agent" },
    "agent_asserted",
  );
  if ("refusal" in drafted) {
    throw new Error(`seed: Nick's outcome draft was refused (${drafted.refusal})`);
  }
  await setPresenceOptOutViaApi(harness, robin.apiKey, true);
  await robinGoesOnWorking(harness, robin);
  await robinActsAfterOptOut(harness, robin);
  // The stale session is OPEN but silent — what GET /api/sessions?open=1
  // lists. Made stale AFTER her late session registered: registering reaps
  // the caller's sessions silent past the reaper's window.
  await harness.db.execute(
    sql`UPDATE agent_sessions SET last_heartbeat_at = ${STALE_HEARTBEAT_AT} WHERE id = ${ROBIN_STALE}`,
  );
  harness.clock.advanceSeconds(READ_OFFSET_S - COMMIT_EVIDENCE_OFFSET_S);
  return {
    harness,
    nick,
    ken,
    robin,
    nickCookie: await loginUi(harness, nick.apiKey),
    kenCookie: await loginUi(harness, ken.apiKey),
    robinCookie: await loginUi(harness, robin.apiKey),
  };
};

export type Viewer = "nick" | "robin";

const credentialsOf = (world: OptedOutWorld, who: Viewer): { readonly apiKey: string; readonly cookie: string } =>
  who === "nick"
    ? { apiKey: world.nick.apiKey, cookie: world.nickCookie }
    : { apiKey: world.robin.apiKey, cookie: world.robinCookie };

/** A GET as `who`, by API key and UI cookie. */
export const getAs = async (
  world: OptedOutWorld,
  who: Viewer,
  url: string,
): Promise<{ readonly status: number; readonly body: string }> => {
  const { apiKey, cookie } = credentialsOf(world, who);
  const response = await world.harness.app.request(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Cookie: cookie },
  });
  return { status: response.status, body: await response.text() };
};

/** A JSON POST as `who`. */
export const postAs = async (
  world: OptedOutWorld,
  who: Viewer,
  url: string,
  body: unknown,
): Promise<{ readonly status: number; readonly body: string }> => {
  const { apiKey } = credentialsOf(world, who);
  const response = await world.harness.app.request(url, jsonRequest("POST", apiKey, body));
  return { status: response.status, body: await response.text() };
};

export const url = (path: string, query: Readonly<Record<string, string>> = {}): string => {
  const search = new URLSearchParams(query).toString();
  return search.length === 0 ? path : `${path}?${search}`;
};
