/**
 * A REALISTIC TEAM, built twice — Robin opted in, and Robin opted out BEFORE
 * her work (review round 5; the reviewer's zz-probe-world.ts). Her agents
 * write what agents write: prose that opens with a timestamp, a bare sha as
 * a claim body, a root cause whose evidence is the bisected commit or a CI
 * run number. The opted-out-world seed spells her location in strings found
 * nowhere else; this one checks that withholding her location does not eat
 * her words.
 */
import {
  TEST_ADMIN_TOKEN,
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
import { setPresenceOptOutViaApi } from "./ui-helpers.ts";

export const TEAM_REPO = "github.com/acme/api";
export const ROBIN_BRANCH = "fix/token-refresh-expiry";
export const ROBIN_HEAD = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";
export const ROBIN_HEAD2 = "d00dd00dd00dd00dd00dd00dd00dd00dd00dd00d";
/** The commit her bisect landed on: a claim body, and a root cause's evidence. */
export const BISECT_SHA = "9f3c2a1b7d4e";
/** A CI run number cited as evidence: digits only. */
export const CI_RUN = "18273645501";
export const FINGERPRINT = "sha256:5d41402abc4b2a76b9719d911";
export const NICK_S = "cc_11111111-2222-4333-8444-555555555555";
export const KEN_S = "cc_22222222-3333-4444-8555-666666666666";
export const ROBIN_S = "cc_44444444-5555-4666-8777-888888888888";
export const ROBIN_S2 = "cc_66666666-7777-4888-8999-aaaaaaaaaaaa";

/** What her agents wrote, verbatim — each must reach a colleague as written. */
export const HER_WORDS = {
  description: "2026-10-06 14:30 deploy of v2.3.1 broke refresh for EU tenants",
  intentSummary: "2026-10-08 09:00 cutover must not log anyone out",
  logLineClaim: "2026-10-06 14:30 UTC first 500 on /refresh, right after deploy a1b2c3d",
  question: "2026-10-08 09:00 cutover: can you sign off the refresh fix before then?",
  pinSurface: "Refresh keeps the session alive",
  pinCheck: "log in, rotate the key, refresh",
} as const;

export interface TeamWorld {
  readonly harness: TestHarness;
  readonly nick: TestDeveloper;
  readonly ken: TestDeveloper;
  readonly robin: TestDeveloper;
}

const ok = async (response: Response, what: string): Promise<void> => {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${what}: ${String(response.status)} ${await response.text()}`);
  }
};

const accepted = async (h: TestHarness, who: TestDeveloper, records: readonly Record<string, unknown>[], what: string): Promise<void> => {
  const posted = await postRecords(h, who, { records: [...records] });
  if (posted.status !== 200 || (posted.data?.rejected ?? 1) > 0) {
    throw new Error(`${what} rejected: ${JSON.stringify(posted.data?.results)}`);
  }
};

const MS_PER_SECOND = 1000;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86_400;

const now = (h: TestHarness): string => h.clock.now().toISOString();
const ago = (h: TestHarness, seconds: number): string => new Date(h.clock.now().getTime() - seconds * MS_PER_SECOND).toISOString();

const nickWork = (h: TestHarness): readonly Record<string, unknown>[] => [
  recordEnvelope("work_context", validWorkContextBody({ id: "wc_nick", sessionId: NICK_S, title: "Refresh 500s on login", titleSource: "host", createdAt: now(h) }), { sessionId: NICK_S }),
  recordEnvelope("target", { workContextId: "wc_nick", kind: "file", value: "src/auth/refresh.ts" }, { sessionId: NICK_S }),
  recordEnvelope("target", { workContextId: "wc_nick", kind: "error_fingerprint", value: FINGERPRINT }, { sessionId: NICK_S }),
  recordEnvelope("claim", validClaimBody({ id: "clm_nick", workContextId: "wc_nick", authorSessionId: NICK_S, kind: "root_cause", status: "likely_root_cause", confidence: 0.6, evidenceRefs: ["clm_nick_ev"], body: "The refresh job overruns its window", createdAt: now(h) }), { sessionId: NICK_S }),
  recordEnvelope("claim", validClaimBody({ id: "clm_nick_ev", workContextId: "wc_nick", authorSessionId: NICK_S, kind: "evidence", body: "Job logs show 40s runs", createdAt: now(h) }), { sessionId: NICK_S }),
  recordEnvelope("commit_evidence", { repo: TEAM_REPO, collectedAt: now(h), windowDays: 14, authors: [{ name: "Ken", email: "ken@example.com", latestCommitAt: ago(h, 3 * SECONDS_PER_DAY), commitCount: 1 }] }, { sessionId: NICK_S }),
];

const robinWork = (h: TestHarness): readonly Record<string, unknown>[] => [
  recordEnvelope("work_context", validWorkContextBody({
    id: "wc_robin_a", sessionId: ROBIN_S, title: `${ROBIN_BRANCH} @ api`, titleSource: "fallback",
    description: HER_WORDS.description,
    intent: { summary: HER_WORDS.intentSummary, provenance: "declared", confidence: 1, capturedAt: now(h) },
    createdAt: now(h),
  }), { sessionId: ROBIN_S }),
  recordEnvelope("work_context", validWorkContextBody({
    id: "wc_robin_b", sessionId: ROBIN_S, title: "Token refresh 500s after the 2026-10-06 deploy", titleSource: "host",
    description: "Investigating refresh 500s", createdAt: now(h),
  }), { sessionId: ROBIN_S }),
  recordEnvelope("target", { workContextId: "wc_robin_a", kind: "file", value: "src/auth/refresh.ts" }, { sessionId: ROBIN_S }),
  recordEnvelope("target", { workContextId: "wc_robin_a", kind: "error_fingerprint", value: FINGERPRINT }, { sessionId: ROBIN_S }),
  recordEnvelope("target", { workContextId: "wc_robin_b", kind: "file", value: "src/auth/keys.ts" }, { sessionId: ROBIN_S }),
  recordEnvelope("claim", validClaimBody({ id: "clm_r_obs", workContextId: "wc_robin_a", authorSessionId: ROBIN_S, kind: "observation", body: HER_WORDS.logLineClaim, createdAt: now(h) }), { sessionId: ROBIN_S }),
  recordEnvelope("claim", validClaimBody({ id: "clm_r_bisect", workContextId: "wc_robin_a", authorSessionId: ROBIN_S, kind: "evidence", body: `Bisected to ${BISECT_SHA}: the key id is dropped in mapKey()`, createdAt: now(h) }), { sessionId: ROBIN_S }),
  recordEnvelope("claim", validClaimBody({ id: "clm_r_sha", workContextId: "wc_robin_a", authorSessionId: ROBIN_S, kind: "evidence", body: BISECT_SHA, createdAt: now(h) }), { sessionId: ROBIN_S }),
  // The root cause cites the bisected COMMIT as its evidence (agents do).
  recordEnvelope("claim", validClaimBody({ id: "clm_r_root", workContextId: "wc_robin_a", authorSessionId: ROBIN_S, kind: "root_cause", status: "likely_root_cause", confidence: 0.9, evidenceRefs: [BISECT_SHA], body: "mapKey() drops the key id on rotation", verificationRef: `error_fingerprint:${FINGERPRINT}`, affectedPaths: ["src/auth/refresh.ts"], createdAt: now(h) }), { sessionId: ROBIN_S }),
  // A root cause on her host-titled tree citing a claim AND a CI run number.
  recordEnvelope("claim", validClaimBody({ id: "clm_r_b_root", workContextId: "wc_robin_b", authorSessionId: ROBIN_S, kind: "root_cause", status: "likely_root_cause", confidence: 0.8, evidenceRefs: ["clm_r_bisect", CI_RUN], body: "Stale cache entry survives rotation", createdAt: now(h) }), { sessionId: ROBIN_S }),
];

const askAndAnswer = async (h: TestHarness, nick: TestDeveloper, robin: TestDeveloper): Promise<void> => {
  await ok(await h.app.request("/api/questions", jsonRequest("POST", robin.apiKey, {
    id: "q_robin", repo: TEAM_REPO, sessionId: ROBIN_S, body: HER_WORDS.question, developer: "Nick", workContextId: "wc_robin_a",
  })), "robin asks");
  await ok(await h.app.request("/api/questions", jsonRequest("POST", nick.apiKey, {
    id: "q_nick", repo: TEAM_REPO, sessionId: NICK_S, body: "Is the mapKey fix safe for EU tenants?", developer: "Robin", workContextId: "wc_nick",
  })), "nick asks");
  h.clock.advanceSeconds(30);
  await ok(await h.app.request("/api/questions/q_nick/answers", jsonRequest("POST", robin.apiKey, {
    claim: validClaimBody({ id: "clm_r_answer", workContextId: "wc_robin_a", authorSessionId: ROBIN_S, body: "Yes, verified against the EU tenant fixtures", createdAt: now(h) }),
  })), "robin answers");
};

export const buildTeamWorld = async (robinOptsOut: boolean): Promise<TeamWorld> => {
  const h = await createTestHarness();
  await ok(await h.app.request("/api/team-settings", jsonRequest("PUT", TEST_ADMIN_TOKEN, { repo: TEAM_REPO, pilotEnrolled: true })), "enrol");
  const nick = await createTestDeveloper(h, "Nick", "nick@example.com");
  const ken = await createTestDeveloper(h, "Ken", "ken@example.com");
  const robin = await createTestDeveloper(h, "Robin", "robin@example.com");
  await ok(await registerTestSession(h, nick.apiKey, { id: NICK_S, branch: "fix/nick-refresh", baseCommit: "aaaabbbbccccdddd" }), "nick session");
  await ok(await registerTestSession(h, ken.apiKey, { id: KEN_S, branch: "main", baseCommit: "1111222233334444" }), "ken session");
  await ok(await registerTestSession(h, robin.apiKey, { id: ROBIN_S, branch: ROBIN_BRANCH, baseCommit: ROBIN_HEAD }), "robin session");
  await ok(await registerTestSession(h, robin.apiKey, { id: ROBIN_S2, branch: "fix/cache-warmup", baseCommit: ROBIN_HEAD2 }), "robin session 2");
  if (robinOptsOut) {
    await setPresenceOptOutViaApi(h, robin.apiKey, true);
  }
  h.clock.advanceSeconds(60);
  await accepted(h, nick, nickWork(h), "nick work");
  h.clock.advanceSeconds(60);
  await accepted(h, robin, robinWork(h), "robin work");
  h.clock.advanceSeconds(30);
  // Nick contradicts her root cause: a referee case.
  await accepted(h, nick, [
    recordEnvelope("claim_edge", { id: "edge_nick_vs_robin", fromClaimId: "clm_nick", toClaimId: "clm_r_root", kind: "contradicts", authorSessionId: NICK_S, note: "Overrun, not mapping", createdAt: now(h) }, { sessionId: NICK_S }),
  ], "edge");
  h.clock.advanceSeconds(30);
  await askAndAnswer(h, nick, robin);
  h.clock.advanceSeconds(30);
  await ok(await h.app.request("/api/pins", jsonRequest("POST", robin.apiKey, {
    id: "pin_r", repo: TEAM_REPO, surface: HER_WORDS.pinSurface, files: ["src/auth/refresh.ts"], check: HER_WORDS.pinCheck, presence: "controlling_terminal", verifiedAtCommit: ROBIN_HEAD,
  })), "pin");
  h.clock.advanceSeconds(30);
  // Her SessionStart: Ken committed an hour ago — newer than Nick's report.
  await accepted(h, robin, [
    recordEnvelope("commit_evidence", { repo: TEAM_REPO, collectedAt: now(h), windowDays: 14, authors: [
      { name: "Ken", email: "ken@example.com", latestCommitAt: ago(h, SECONDS_PER_HOUR), commitCount: 3 },
      { name: "Sam", email: "sam@example.com", latestCommitAt: ago(h, 2 * SECONDS_PER_HOUR), commitCount: 2 },
    ] }, { sessionId: ROBIN_S }),
  ], "robin commit evidence");
  h.clock.advanceSeconds(30);
  // Her second session's work landed.
  await accepted(h, robin, [
    recordEnvelope("work_context", validWorkContextBody({ id: "wc_robin_c", sessionId: ROBIN_S2, title: "Cache warmup on deploy", titleSource: "host", createdAt: now(h) }), { sessionId: ROBIN_S2 }),
    recordEnvelope("target", { workContextId: "wc_robin_c", kind: "file", value: "src/auth/refresh.ts" }, { sessionId: ROBIN_S2 }),
    recordEnvelope("landed_evidence", { repo: TEAM_REPO, defaultBranch: "main", checkedAt: now(h), commits: [ROBIN_HEAD2] }, { sessionId: ROBIN_S2 }),
  ], "robin landed");
  h.clock.advanceSeconds(120);
  await ok(await h.app.request(`/api/sessions/${ROBIN_S}/heartbeat`, jsonRequest("POST", robin.apiKey, { status: "implementing" })), "heartbeat");
  h.clock.advanceSeconds(60);
  return { harness: h, nick, ken, robin };
};
