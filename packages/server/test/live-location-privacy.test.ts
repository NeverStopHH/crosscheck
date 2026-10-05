/**
 * THE LIVE-LOCATION POLICY, held over EVERY GET route the hub serves.
 *
 * Opt-out withholds a developer's LIVE LOCATION from every other viewer on
 * every hub route: current branch, HEAD/base commit, and heartbeat/last-active
 * time. Their work contexts, claims and diagnoses remain shared; that is what
 * the product is for (services/visibility.ts states it).
 *
 * The route list is READ FROM THE APP (`harness.app.routes`), never written
 * here: a GET route added tomorrow is walked automatically, and one this file
 * cannot build a request for fails it. Each route must answer 2xx — or carry a
 * written reason in EXPECTED_STATUS — so "covered" never means "refused before
 * it reached the data". A route a developer may not call is walked as admin.
 *
 * The seed puts an opted-out Robin on a distinctive branch at a distinctive
 * HEAD, in a LIVE session and in a STALE open one, with a work context under
 * the honest fallback title `<branch> @ <repo>`, a captured file, and a claim
 * that contradicts one of Nick's — enough for presence, sessions, listings,
 * diagnosis, search, conference, suspect, contradictions and the UI pages to
 * have something of hers to say. Neither string may reach Nick; both still
 * reach Robin.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { contradictionIdFor } from "../src/services/contradictions.ts";
import {
  TEST_ADMIN_TOKEN,
  TEST_START_ISO,
  createTestDeveloper,
  createTestHarness,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validClaimBody,
  validWorkContextBody,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";
import { loginUi, setPresenceOptOutViaApi } from "./ui-helpers.ts";

const SECRET_BRANCH = "feat/robin-relocates-to-zurich";
const SECRET_SHA = "f00dfacecafe0123456789abcdef0123456789ab";
const SECRET_SHORT_SHA = SECRET_SHA.slice(0, 7);
const FILE = "src/auth/refresh.ts";
const FINGERPRINT = "TypeError: key id expired at refresh";

const NICK_SESSION = "cc_11111111-2222-4333-8444-555555555555";
const ROBIN_LIVE = "cc_44444444-5555-4666-8777-888888888888";
const ROBIN_STALE = "cc_55555555-6666-4777-8888-999999999999";
const ROBIN_CONTEXT = "wc_robin_live";
const ROBIN_SOLVED = "wc_robin_solved";
const NICK_CONTEXT = "wc_nick_live";

interface World {
  readonly harness: TestHarness;
  readonly nick: TestDeveloper;
  readonly robin: TestDeveloper;
  readonly nickCookie: string;
  readonly robinCookie: string;
}

/**
 * A rejected seed row is a surface with nothing of Robin's to say, which
 * passes for the wrong reason — so the seed refuses to run short.
 */
const assertAccepted = (
  posted: Awaited<ReturnType<typeof postRecords>>,
  who: string,
): void => {
  if (posted.status !== 200 || (posted.data?.rejected ?? 1) > 0) {
    throw new Error(`${who}'s seed was not accepted: ${JSON.stringify(posted.data?.results)}`);
  }
};

const seed = async (): Promise<World> => {
  const harness = await createTestHarness();
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  await registerTestSession(harness, nick.apiKey, { id: NICK_SESSION });
  const robin = await createTestDeveloper(harness, "Robin", "robin@example.com");
  for (const id of [ROBIN_LIVE, ROBIN_STALE]) {
    await registerTestSession(harness, robin.apiKey, {
      id,
      branch: SECRET_BRANCH,
      baseCommit: SECRET_SHA,
    });
  }
  const nickPosted = await postRecords(harness, nick, {
    records: [
      recordEnvelope(
        "work_context",
        validWorkContextBody({ id: NICK_CONTEXT, sessionId: NICK_SESSION, title: "Key rotation" }),
        { sessionId: NICK_SESSION },
      ),
      recordEnvelope(
        "target",
        { workContextId: NICK_CONTEXT, kind: "error_fingerprint", value: FINGERPRINT },
        { sessionId: NICK_SESSION },
      ),
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_nick",
          workContextId: NICK_CONTEXT,
          authorSessionId: NICK_SESSION,
          kind: "hypothesis",
          status: "proposed",
          body: "The rotation job overruns its window and drops the key",
        }),
        { sessionId: NICK_SESSION },
      ),
    ],
  });
  const robinPosted = await postRecords(harness, robin, {
    records: [
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          id: ROBIN_CONTEXT,
          sessionId: ROBIN_LIVE,
          // The connector's honest fallback when the host supplied no title.
          title: `${SECRET_BRANCH} @ api`,
        }),
        { sessionId: ROBIN_LIVE },
      ),
      recordEnvelope(
        "target",
        { workContextId: ROBIN_CONTEXT, kind: "file", value: FILE },
        { sessionId: ROBIN_LIVE },
      ),
      recordEnvelope(
        "target",
        { workContextId: ROBIN_CONTEXT, kind: "error_fingerprint", value: FINGERPRINT },
        { sessionId: ROBIN_LIVE },
      ),
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_robin",
          workContextId: ROBIN_CONTEXT,
          authorSessionId: ROBIN_LIVE,
          kind: "hypothesis",
          status: "rejected",
          body: "Rotation finished inside its window on every sampled failure",
        }),
        { sessionId: ROBIN_LIVE },
      ),
      // A SOLVED tree of hers on the failure Nick is live on, so the solved
      // pointer (GET /api/solved-matches) has a title of hers to print.
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          id: ROBIN_SOLVED,
          sessionId: ROBIN_STALE,
          title: `${SECRET_BRANCH} @ api`,
        }),
        { sessionId: ROBIN_STALE },
      ),
      recordEnvelope(
        "target",
        { workContextId: ROBIN_SOLVED, kind: "error_fingerprint", value: FINGERPRINT },
        { sessionId: ROBIN_STALE },
      ),
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_robin_evidence",
          workContextId: ROBIN_SOLVED,
          authorSessionId: ROBIN_STALE,
          kind: "evidence",
          body: "The trace shows the rotated key id being dropped",
        }),
        { sessionId: ROBIN_STALE },
      ),
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_robin_root",
          workContextId: ROBIN_SOLVED,
          authorSessionId: ROBIN_STALE,
          kind: "root_cause",
          status: "likely_root_cause",
          confidence: 0.9,
          evidenceRefs: ["clm_robin_evidence"],
          body: "The ingestion mapping drops the key id on rotation",
        }),
        { sessionId: ROBIN_STALE },
      ),
    ],
  });
  assertAccepted(nickPosted, "Nick");
  assertAccepted(robinPosted, "Robin");
  // The stale one is OPEN but silent — what GET /api/sessions?open=1 lists.
  // Thirty hours before the harness's own clock, not the wall clock's.
  const staleAt = new Date(new Date(TEST_START_ISO).getTime() - 30 * 3_600_000);
  await harness.db.execute(
    sql`UPDATE agent_sessions SET last_heartbeat_at = ${staleAt.toISOString()} WHERE id = ${ROBIN_STALE}`,
  );
  await setPresenceOptOutViaApi(harness, robin.apiKey, true);
  return {
    harness,
    nick,
    robin,
    nickCookie: await loginUi(harness, nick.apiKey),
    robinCookie: await loginUi(harness, robin.apiKey),
  };
};

/** One query string for every route: each reads the parameters it knows. */
const QUERY = new URLSearchParams({
  repo: "github.com/acme/api",
  path: FILE,
  value: FILE,
  q: "rotation window refresh",
  query: "rotation window refresh key id",
  commit: "a1b2c3d4",
  open: "1",
  since: "14d",
}).toString();

/** Every path parameter a GET route uses, resolved to a seeded row. */
const concretePath = (route: string, world: World): string =>
  route
    .replace("/api/developers/:id", `/api/developers/${world.robin.developerId}`)
    .replace(/\/work-contexts\/:id/, `/work-contexts/${ROBIN_CONTEXT}`)
    .replace(/\/contradictions\/:id/, `/contradictions/${contradictionIdFor("clm_nick", "clm_robin")}`);

/**
 * The routes that may answer something other than 2xx to this seed, and why.
 * Nothing else may: a 4xx that never reached the data would pass vacuously.
 */
const EXPECTED_STATUS: Readonly<Record<string, { readonly status: number; readonly why: string }>> = {
  "/api/pilot-marks/candidates": {
    status: 422,
    why: "self-scoped (the caller's own deliveries), refused on a repo that never enrolled",
  },
  "/api/pilot-marks/unlabeled": {
    status: 422,
    why: "self-scoped (the caller's own deliveries), refused on a repo that never enrolled",
  },
  "/ui": { status: 303, why: "the UI root redirects to the feed, which is walked itself" },
};

const STREAM_READ_MS = 300;

const bodyOf = async (response: Response, route: string): Promise<string> => {
  if (!route.endsWith("/stream")) {
    return response.text();
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return "";
  }
  const first = await Promise.race([
    reader.read(),
    new Promise<{ readonly value?: Uint8Array }>((resolve) =>
      setTimeout(() => resolve({}), STREAM_READ_MS),
    ),
  ]);
  await reader.cancel();
  return first.value === undefined ? "" : new TextDecoder().decode(first.value);
};

interface Answer {
  readonly route: string;
  readonly status: number;
  readonly body: string;
}

/** As a developer (API key and UI cookie); a route a developer may not call, as admin. */
const call = async (
  world: World,
  route: string,
  as: { readonly apiKey: string; readonly cookie: string },
): Promise<readonly Answer[]> => {
  const url = `${concretePath(route, world)}?${QUERY}`;
  const asDeveloper = await world.harness.app.request(url, {
    headers: { Authorization: `Bearer ${as.apiKey}`, Cookie: as.cookie },
  });
  const first: Answer = { route, status: asDeveloper.status, body: await bodyOf(asDeveloper, route) };
  if (asDeveloper.status !== 401) {
    return [first];
  }
  const asAdmin = await world.harness.app.request(url, {
    headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
  });
  return [first, { route: `${route} (admin)`, status: asAdmin.status, body: await bodyOf(asAdmin, route) }];
};

const getRoutes = (harness: TestHarness): readonly string[] =>
  [
    ...new Set(
      harness.app.routes
        .filter((route) => route.method === "GET")
        .map((route) => route.path),
    ),
  ];

const leaks = (body: string): readonly string[] =>
  [SECRET_BRANCH, SECRET_SHA, SECRET_SHORT_SHA].filter((secret) => body.includes(secret));

describe("an opted-out developer's live location reaches no other viewer, on any GET route", () => {
  test("every GET route the hub serves is walked, and none names Robin's branch or HEAD to Nick", async () => {
    const world = await seed();
    const routes = getRoutes(world.harness);
    expect(routes.length).toBeGreaterThan(40);

    const answers = (
      await Promise.all(
        routes.map((route) => call(world, route, { apiKey: world.nick.apiKey, cookie: world.nickCookie })),
      )
    ).flat();

    // Every problem at once, so one run names every route that needs work.
    const problems = answers.flatMap((answer): readonly string[] => {
      const base = answer.route.replace(" (admin)", "");
      const walkedAsAdmin = !answer.route.endsWith("(admin)") && answer.status === 401;
      const expected = EXPECTED_STATUS[answer.route];
      const statusProblem =
        expected !== undefined
          ? answer.status === expected.status
            ? []
            : [`${answer.route}: ${String(answer.status)}, expected ${String(expected.status)} (${expected.why})`]
          : walkedAsAdmin || (answer.status >= 200 && answer.status < 300)
            ? []
            : [`${answer.route}: answered ${String(answer.status)} — never reached its data`];
      return [
        // A path parameter this file cannot fill would leave the route unwalked.
        ...(concretePath(base, world).includes(":") ? [`${answer.route}: unfilled path parameter`] : []),
        ...statusProblem,
        ...leaks(answer.body).map((secret) => `${answer.route}: leaks ${secret}`),
      ];
    });

    expect(problems).toEqual([]);
  });

  test("Robin's own reads still show her branch and HEAD", async () => {
    const world = await seed();
    const answers = (
      await Promise.all(
        getRoutes(world.harness).map((route) =>
          call(world, route, { apiKey: world.robin.apiKey, cookie: world.robinCookie }),
        ),
      )
    ).flat();
    const everything = answers.map((answer) => answer.body).join("\n");

    expect(everything).toContain(SECRET_BRANCH);
    expect(everything).toContain(SECRET_SHA);
  });
});
