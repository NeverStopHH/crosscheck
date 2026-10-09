/**
 * The adversarial probes of the opt-out rounds, kept as regression tests:
 * one describe per surface a review found still telling a colleague where
 * an opted-out developer is, or when she was there (services/live-location.ts
 * is the one projection; test/opted-out-world.ts the one seed).
 *
 * Each case reads the surface as Nick, who must see Robin's row in withheld
 * form and none of her SECRETS, and as Robin, who must still see her own.
 */
import { describe, expect, test } from "bun:test";
import { LOCATION_WITHHELD, WITHHELD_TITLE } from "@crosscheck/schema";

import { contradictionIdFor } from "../src/services/contradictions.ts";

import {
  createTestDeveloper,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validClaimBody,
  validWorkContextBody,
} from "./helpers.ts";
import {
  CREATED_AT,
  DETACHED_TITLE,
  FILE,
  HOST_CREATED_AT,
  HOST_TITLE,
  KEN_SESSION,
  LANDED_AT,
  LOCAL_REPO,
  ROBIN_FINGERPRINT,
  ROBIN_NEW_FILE,
  ROBIN_PIN,
  NICK_CONTEXT,
  NICK_SESSION,
  NICK_TITLE,
  NICK_TO_ROBIN_QUESTION,
  REVALIDATED_AT,
  REPO,
  ROBIN_CONTEXT,
  ROBIN_DETACHED_CONTEXT,
  ROBIN_HOST_CONTEXT,
  ROBIN_LIVE,
  ROBIN_LOCAL,
  ROBIN_LOCAL_CONTEXT,
  ROBIN_OLD_CONTEXT,
  ROBIN_SECOND_TOPIC,
  ROBIN_SOLVED,
  ROBIN_TOPIC,
  OLD_CREATED_AT,
  OLD_TITLE,
  SECRET_BRANCH,
  SECRET_LOCAL_BRANCH,
  SECRET_SHA,
  SECRET_SHA2,
  TIED_FINDING_WORDS,
  TIED_TOPIC_WORDS,
  UPDATED_AT,
  getAs,
  leaksIn,
  openTiedTopics,
  postAs,
  rewriteTiedTopicInPlace,
  secretsIn,
  seedOptedOutWorld,
  url,
} from "./opted-out-world.ts";

interface ConferenceContext {
  readonly id: string;
  readonly lastActiveAt: string;
}

const conferenceContexts = (body: string): readonly ConferenceContext[] =>
  (JSON.parse(body) as { data: { conference: { contexts: readonly ConferenceContext[] } } }).data
    .conference.contexts;

describe("the conference", () => {
  test("says Robin's context is there and withholds when she was last active on it", async () => {
    const world = await seedOptedOutWorld();

    const asNick = await getAs(world, "nick", url("/api/conference", { repo: REPO }));
    const asRobin = await getAs(world, "robin", url("/api/conference", { repo: REPO }));

    expect(asNick.status).toBe(200);
    expect(secretsIn(asNick.body)).toEqual([]);
    expect(conferenceContexts(asNick.body).find((context) => context.id === ROBIN_CONTEXT)?.lastActiveAt)
      .toBe(LOCATION_WITHHELD);
    expect(conferenceContexts(asRobin.body).find((context) => context.id === ROBIN_CONTEXT)?.lastActiveAt)
      .toBe(UPDATED_AT);
  });

  test("lists the questions about Robin's contexts under the withheld title", async () => {
    // Review round 3, survivor A: the conference's question list titles each
    // question with the context it is about — the CONTEXT owner's location.
    const world = await seedOptedOutWorld();

    const asNick = await getAs(world, "nick", url("/api/conference", { repo: REPO }));
    const asRobin = await getAs(world, "robin", url("/api/conference", { repo: REPO }));

    expect(secretsIn(asNick.body)).toEqual([]);
    // Nick's own question to her is about HIS work: titled as his, for both.
    expect(conferenceQuestionTitles(asNick.body)).toEqual({ q_ken_1: WITHHELD_TITLE, q_robin_1: WITHHELD_TITLE, [NICK_TO_ROBIN_QUESTION]: NICK_TITLE });
    expect(conferenceQuestionTitles(asRobin.body)).toEqual({
      q_ken_1: `${SECRET_BRANCH} @ api`,
      q_robin_1: `${SECRET_BRANCH} @ api`,
      [NICK_TO_ROBIN_QUESTION]: NICK_TITLE,
    });
  });
});

interface InboxEntry {
  readonly id: string;
  readonly workContextTitle: string | null;
}

const titlesById = (entries: readonly InboxEntry[]): Readonly<Record<string, string | null>> =>
  Object.fromEntries(entries.map((entry) => [entry.id, entry.workContextTitle]));

const conferenceQuestionTitles = (body: string): Readonly<Record<string, string | null>> =>
  titlesById(
    (JSON.parse(body) as { data: { conference: { questions: readonly InboxEntry[] } } }).data
      .conference.questions,
  );

describe("the questions inbox (review round 3, H1)", () => {
  test("the briefing's Questions for you titles a question about Robin's context withheld", async () => {
    const world = await seedOptedOutWorld();

    const inbox = await getAs(world, "nick", url("/api/questions", { repo: REPO }));

    expect(inbox.status).toBe(200);
    expect(secretsIn(inbox.body)).toEqual([]);
    expect(titlesById((JSON.parse(inbox.body) as { data: { inbox: readonly InboxEntry[] } }).data.inbox))
      .toEqual({ q_ken_1: WITHHELD_TITLE, q_robin_1: WITHHELD_TITLE });
  });

  test("list_open_questions (answerable=1) titles it withheld too", async () => {
    const world = await seedOptedOutWorld();

    const answerable = await getAs(world, "nick", url("/api/questions", { repo: REPO, answerable: "1" }));

    expect(answerable.status).toBe(200);
    expect(secretsIn(answerable.body)).toEqual([]);
    expect(answerable.body).toContain(WITHHELD_TITLE);
  });

  test("her answer to Nick's question carries neither when she answered nor her evidence's age (integration review M4)", async () => {
    // The answer lands on the asker's briefing and prompt: the hub's stamp of
    // her answer and the evidence rung's age (the failure her session observed)
    // went out raw on both, where every other route withholds them.
    const world = await seedOptedOutWorld();
    world.harness.clock.advanceSeconds(ANSWER_DELAY_S);
    const answered = await postAs(world, "robin", `/api/questions/${NICK_TO_ROBIN_QUESTION}/answers`, {
      claim: validClaimBody({ id: "clm_robin_answer", workContextId: ROBIN_CONTEXT, authorSessionId: ROBIN_LIVE, kind: "observation", body: "The cache keeps the old key id for one refresh", verificationRef: `error_fingerprint:${ROBIN_FINGERPRINT}`, createdAt: CREATED_AT }),
    });
    world.harness.clock.advanceSeconds(ANSWER_DELAY_S);
    const answeredAt = new Date(world.harness.clock.now().getTime() - ANSWER_DELAY_S * 1000).toISOString();

    const reads = [
      await getAs(world, "nick", url("/api/questions", { repo: REPO })),
      await getAs(world, "nick", url("/api/hints/candidates", { repo: REPO, query: "where does the cache keep the key id" })),
    ];
    const answers = reads.map((read) => (JSON.parse(read.body) as { data: { answers: readonly AnswerRow[] } }).data.answers);

    expect(answered.status).toBe(200);
    for (const [index, read] of reads.entries()) {
      expect(leaksIn(read.body, world.harness.clock.now())).toEqual([]);
      expect(read.body).not.toContain(answeredAt);
      expect(answers[index]?.map((answer) => [answer.claimId, answer.answeredAt, answer.axes?.observedAt ?? null])).toEqual([
        ["clm_robin_answer", LOCATION_WITHHELD, null],
      ]);
    }
  });

  test("which answers Nick is handed first does not follow when she answered (integration review M4)", async () => {
    // Four answers wait and a page holds three: ordered by when each was
    // answered, hers was in or out by her own instant.
    const page = async (isHersLast: boolean): Promise<readonly string[]> => {
      const world = await seedOptedOutWorld();
      const asKen = async (path: string, body: unknown): Promise<Response> =>
        world.harness.app.request(path, jsonRequest("POST", world.ken.apiKey, body));
      const hers = async (): Promise<void> => {
        const answered = await postAs(world, "robin", `/api/questions/${NICK_TO_ROBIN_QUESTION}/answers`, {
          claim: validClaimBody({ id: "clm_robin_answer", workContextId: ROBIN_CONTEXT, authorSessionId: ROBIN_LIVE, kind: "observation", body: "The cache keeps the old key id for one refresh", createdAt: CREATED_AT }),
        });
        expect(answered.status).toBe(200);
      };
      if (!isHersLast) {
        await hers();
      }
      for (const part of [1, 2, 3]) {
        world.harness.clock.advanceSeconds(ANSWER_DELAY_S);
        const question = `q_nick_to_ken_${String(part)}`;
        await postAs(world, "nick", "/api/questions", { id: question, repo: REPO, sessionId: NICK_SESSION, body: `Ken, where is the key id kept, part ${String(part)}?`, developer: "Ken", workContextId: NICK_CONTEXT });
        const answered = await asKen(`/api/questions/${question}/answers`, {
          claim: validClaimBody({ id: `clm_ken_answer_${String(part)}`, workContextId: "wc_ken", authorSessionId: KEN_SESSION, kind: "observation", body: `In the refresh cache, part ${String(part)}`, createdAt: world.harness.clock.now().toISOString() }),
        });
        expect(answered.status).toBe(200);
      }
      if (isHersLast) {
        world.harness.clock.advanceSeconds(ANSWER_DELAY_S);
        await hers();
      }
      world.harness.clock.advanceSeconds(ANSWER_DELAY_S);
      const read = await getAs(world, "nick", url("/api/questions", { repo: REPO }));
      return (JSON.parse(read.body) as { data: { answers: readonly AnswerRow[] } }).data.answers.map((answer) => answer.claimId);
    };

    const first = await page(false);
    const last = await page(true);

    expect(first).toHaveLength(3);
    expect(last).toEqual(first);
  });
});

const ANSWER_DELAY_S = 90;

interface AnswerRow {
  readonly claimId: string;
  readonly answeredAt: string;
  readonly axes?: { readonly observedAt?: string | null };
}

describe("the pilot surfaces (review round 3, H3)", () => {
  test("crosscheck pilot label lists the hint about Robin's context under the withheld title", async () => {
    const world = await seedOptedOutWorld();

    const unlabeled = await getAs(world, "nick", url("/api/pilot-marks/unlabeled", { repo: REPO, withinMinutes: "600" }));

    expect(unlabeled.status).toBe(200);
    expect(secretsIn(unlabeled.body)).toEqual([]);
    expect((JSON.parse(unlabeled.body) as { data: { candidates: readonly { id: string; title: string | null }[] } })
      .data.candidates).toEqual([expect.objectContaining({ id: "hd_robin_1", title: WITHHELD_TITLE })]);
  });

  test("the pilot report's prior work names Robin's opened context under the withheld title", async () => {
    const world = await seedOptedOutWorld();

    const asNick = await getAs(world, "nick", url("/api/pilot/report", { repo: REPO, days: "14" }));
    const asRobin = await getAs(world, "robin", url("/api/pilot/report", { repo: REPO, days: "14" }));

    expect(asNick.status).toBe(200);
    expect(secretsIn(asNick.body)).toEqual([]);
    expect(priorWorkTitles(asNick.body)).toEqual({ [ROBIN_CONTEXT]: WITHHELD_TITLE });
    expect(priorWorkTitles(asRobin.body)).toEqual({ [ROBIN_CONTEXT]: `${SECRET_BRANCH} @ api` });
  });
});

const priorWorkTitles = (body: string): Readonly<Record<string, string>> =>
  Object.fromEntries(
    (JSON.parse(body) as {
      data: { duplicateWork: { priorWork: readonly { workContextId: string; title: string }[] } };
    }).data.duplicateWork.priorWork.map((work) => [work.workContextId, work.title]),
  );

interface ListedContext {
  readonly id: string;
  readonly developerId: string;
  readonly updatedAt: string | null;
}

const listed = (body: string): readonly ListedContext[] =>
  (JSON.parse(body) as { data: { workContexts: readonly ListedContext[] } }).data.workContexts;

const robinsRows = (world: Awaited<ReturnType<typeof seedOptedOutWorld>>, rows: readonly ListedContext[]) =>
  rows.filter((row) => row.developerId === world.robin.developerId);

const conferenceRows = (answer: { readonly body: string }): readonly { id: string; developerId: string }[] =>
  (JSON.parse(answer.body) as { data: { conference: { contexts: readonly { id: string; developerId: string }[] } } })
    .data.conference.contexts;

/** After Robin's contexts were created, before she touched one again. */
const BETWEEN_CREATION_AND_UPDATE = new Date((Date.parse(HOST_CREATED_AT) + Date.parse(UPDATED_AT)) / 2).toISOString();

describe("when Robin last touched her work (review round 3, M1)", () => {
  test("the listing, the by-id read and the diagnosis carry no updatedAt of hers", async () => {
    const world = await seedOptedOutWorld();

    const listing = await getAs(world, "nick", url("/api/work-contexts", { repo: REPO }));
    const byId = await getAs(world, "nick", `/api/work-contexts/${ROBIN_CONTEXT}`);
    const diagnosis = await getAs(world, "nick", `/api/work-contexts/${ROBIN_CONTEXT}/diagnosis`);
    const page = await getAs(world, "nick", `/ui/work-contexts/${ROBIN_CONTEXT}`);
    const own = await getAs(world, "robin", url("/api/work-contexts", { repo: REPO }));

    for (const answer of [listing, byId, diagnosis, page]) {
      expect(answer.status).toBe(200);
      expect(secretsIn(answer.body)).toEqual([]);
    }
    expect(listed(listing.body).find((row) => row.id === ROBIN_CONTEXT)?.updatedAt).toBeNull();
    expect((JSON.parse(byId.body) as { data: { workContext: ListedContext } }).data.workContext.updatedAt).toBeNull();
    expect(listed(own.body).find((row) => row.id === ROBIN_CONTEXT)?.updatedAt).toBe(UPDATED_AT);
  });

  test("search and hint candidates carry none either", async () => {
    const world = await seedOptedOutWorld();

    const search = await getAs(world, "nick", url("/api/search", { q: "rotation window", repo: REPO }));
    const hints = await getAs(world, "nick", url("/api/hints/candidates", { repo: REPO, query: "rotation window refresh key id" }));

    for (const answer of [search, hints]) {
      expect(answer.status).toBe(200);
      expect(secretsIn(answer.body)).toEqual([]);
      expect(answer.body).toContain(ROBIN_CONTEXT);
    }
  });

  test("a since= window admits her work by its creation, never by her last touch", async () => {
    const world = await seedOptedOutWorld();

    const asNick = await getAs(world, "nick", url("/api/work-contexts", { repo: REPO, since: BETWEEN_CREATION_AND_UPDATE }));
    const searched = await getAs(world, "nick", url("/api/search", { q: "rotation window", repo: REPO, since: BETWEEN_CREATION_AND_UPDATE }));
    const asRobin = await getAs(world, "robin", url("/api/work-contexts", { repo: REPO, since: BETWEEN_CREATION_AND_UPDATE }));

    // Created before the window, touched inside it: to Nick it is outside,
    // or the window says she touched it — which the withheld updatedAt no
    // longer does.
    expect(listed(asNick.body).map((row) => row.id)).not.toContain(ROBIN_CONTEXT);
    expect(searched.body).not.toContain(ROBIN_CONTEXT);
    expect(listed(asRobin.body).map((row) => row.id)).toContain(ROBIN_CONTEXT);
  });

  test("the conference windows and orders her work by creation too", async () => {
    const world = await seedOptedOutWorld();

    const asNick = conferenceRows(await getAs(world, "nick", url("/api/conference", { repo: REPO })));
    const asRobin = conferenceRows(await getAs(world, "robin", url("/api/conference", { repo: REPO })));

    // Created a quarter ago, touched today: inside the fortnight only by her
    // last touch, so not inside Nick's.
    expect(asNick.map((row) => row.id)).not.toContain(ROBIN_OLD_CONTEXT);
    expect(asRobin.map((row) => row.id)).toContain(ROBIN_OLD_CONTEXT);
    expect(asNick.find((row) => row.developerId === world.robin.developerId)?.id).toBe(ROBIN_HOST_CONTEXT);
    expect(asRobin.find((row) => row.developerId === world.robin.developerId)?.id).toBe(ROBIN_CONTEXT);
  });

  test("equally fresh work is listed by its id, never by whatever decided the tie (review round 4, L1)", async () => {
    // Ordered by activity alone, a tie fell to the order the rank's window
    // met the rows in — by DEVELOPER id, which is random per hub. So two
    // hubs differing only by something she did listed colleagues' equally
    // fresh rows differently, and the order itself became a diff.
    const world = await seedOptedOutWorld();
    const tied = ["wc_tie_1", "wc_tie_2", "wc_tie_3", "wc_tie_4", "wc_tie_5", "wc_tie_6"];
    for (const [index, id] of tied.entries()) {
      const teammate = await createTestDeveloper(world.harness, `Tie ${String(index)}`, `tie${String(index)}@example.com`);
      const sessionId = `cc_${String(index)}0000000-0000-4000-8000-000000000000`;
      await registerTestSession(world.harness, teammate.apiKey, { id: sessionId });
      await postRecords(world.harness, teammate, {
        records: [recordEnvelope("work_context", validWorkContextBody({ id, sessionId, title: `Tied work ${String(index)}` }), { sessionId })],
      });
    }

    const order = listed((await getAs(world, "nick", url("/api/work-contexts", { repo: REPO }))).body)
      .map((row) => row.id)
      .filter((id) => tied.includes(id));

    expect(order).toEqual(tied);
  });

  test("freshest-first ranks her work by creation, so the order says nothing of her last touch", async () => {
    const world = await seedOptedOutWorld();

    const asNick = await getAs(world, "nick", url("/api/work-contexts", { repo: REPO }));
    const asRobin = await getAs(world, "robin", url("/api/work-contexts", { repo: REPO }));

    expect(robinsRows(world, listed(asNick.body))[0]?.id).toBe(ROBIN_HOST_CONTEXT);
    expect(robinsRows(world, listed(asRobin.body))[0]?.id).toBe(ROBIN_CONTEXT);
  });

  test("the listing marks her rows withheld, and nobody else's: no reader dates her by creation (integration review M5)", async () => {
    const world = await seedOptedOutWorld();
    const marked = async (who: "nick" | "robin"): Promise<readonly string[]> => [
      ...new Set(
        (JSON.parse((await getAs(world, who, url("/api/work-contexts", { repo: REPO }))).body) as { data: { workContexts: readonly { developerId: string; locationWithheld?: unknown }[] } }).data.workContexts
          .filter((row) => row.locationWithheld !== undefined)
          .map((row) => (row.locationWithheld === true ? row.developerId : `not true: ${JSON.stringify(row.locationWithheld)}`)),
      ),
    ];

    expect(await marked("nick")).toEqual([world.robin.developerId]);
    expect(await marked("robin")).toEqual([]);
  });

  test("the hint pool ranks her trees by creation, never by her last touch (integration review H5)", async () => {
    // Her old context, created ninety days back, moved again twenty days or
    // two minutes before Nick's prompt. The pool decays every tier by
    // `updatedAt ?? createdAt`, and read raw, her withheld touch brought the
    // old tree into a list capped at three and pushed Ken's out.
    const pool = async (beforeReadS: number): Promise<readonly string[]> => {
      const world = await seedOptedOutWorld();
      world.harness.clock.advanceSeconds(TOUCH_SKEW_S - beforeReadS);
      const moved = await postRecords(world.harness, world.robin, {
        records: [
          recordEnvelope(
            "work_context",
            validWorkContextBody({ id: ROBIN_OLD_CONTEXT, sessionId: ROBIN_LIVE, title: OLD_TITLE, titleSource: "host", status: "testing", createdAt: OLD_CREATED_AT }),
            { sessionId: ROBIN_LIVE },
          ),
        ],
      });
      expect(moved.data?.accepted).toBe(1);
      world.harness.clock.advanceSeconds(beforeReadS);
      return candidateIds(await getAs(world, "nick", url("/api/hints/candidates", { repo: REPO, query: "why does POST /login return a 500" })));
    };

    const early = await pool(TOUCH_SKEW_S);
    const late = await pool(TOUCH_LATE_S);

    expect(early.length).toBeGreaterThan(0);
    expect(late).toEqual(early);
  });

  test("equal ranks follow the ids, never where her rows sit on disk (integration review L7)", async () => {
    // Two topics of hers say the same words; an update that changes no value
    // moves one of them, its claim and her session to new tuples.
    const world = await seedOptedOutWorld();
    await openTiedTopics(world);
    // By their statements, and by their finding alone — the claim tier's own tie.
    const read = async (): Promise<readonly (readonly string[])[]> => [
      candidateIds(await getAs(world, "nick", url("/api/hints/candidates", { repo: REPO, query: TIED_TOPIC_WORDS }))),
      candidateIds(await getAs(world, "nick", url("/api/hints/candidates", { repo: REPO, query: TIED_FINDING_WORDS }))),
      searchIds(await getAs(world, "nick", url("/api/search", { query: TIED_TOPIC_WORDS, repo: REPO }))),
      searchIds(await getAs(world, "nick", url("/api/search", { query: TIED_FINDING_WORDS, repo: REPO }))),
    ];

    const before = await read();
    await rewriteTiedTopicInPlace(world);
    const after = await read();

    expect(before[0]).toEqual(expect.arrayContaining([ROBIN_TOPIC, ROBIN_SECOND_TOPIC]));
    expect(before[1]).toEqual(expect.arrayContaining([ROBIN_TOPIC, ROBIN_SECOND_TOPIC]));
    expect(after).toEqual(before);
  });
});

/** Twenty days, and two minutes past the presence TTL: she is quiet at both reads. */
const TOUCH_SKEW_S = 20 * 86_400;
const TOUCH_LATE_S = 120;

const candidateIds = (answer: { readonly body: string }): readonly string[] =>
  (JSON.parse(answer.body) as { data: { candidates: readonly { workContext: { id: string } }[] } }).data.candidates.map(
    (candidate) => candidate.workContext.id,
  );

const searchIds = (answer: { readonly body: string }): readonly string[] =>
  (JSON.parse(answer.body) as { data: { results: readonly { id: string }[] } }).data.results.map((result) => result.id);

const titleOf = (body: string, id: string): string | undefined =>
  listed(body).find((row) => row.id === id)?.["title" as keyof ListedContext] as string | undefined;

describe("the title marker (review round 3, H4 and L1)", () => {
  test("a host-written title that merely ends in ` @ api` stays", async () => {
    const world = await seedOptedOutWorld();

    const listing = await getAs(world, "nick", url("/api/work-contexts", { repo: REPO }));

    expect(titleOf(listing.body, ROBIN_HOST_CONTEXT)).toBe(HOST_TITLE);
  });

  test("on a local: repo, her bare-branch and detached titles are withheld on every surface", async () => {
    // No remote, so no ` @ <label>` to spot: an unmarked row is caught by
    // being her session's branch, or by opening with a detached ref.
    const world = await seedOptedOutWorld();
    const reads = [
      url("/api/work-contexts", { repo: LOCAL_REPO }),
      `/api/work-contexts/${ROBIN_LOCAL_CONTEXT}`,
      `/api/work-contexts/${ROBIN_DETACHED_CONTEXT}/diagnosis`,
      `/ui/work-contexts/${ROBIN_LOCAL_CONTEXT}`,
      `/ui/work-contexts/${ROBIN_DETACHED_CONTEXT}`,
      url("/api/search", { q: "rotation window refresh", repo: LOCAL_REPO }),
      url("/api/conference", { repo: LOCAL_REPO }),
      url("/api/hints/candidates", { repo: LOCAL_REPO, query: "rotation window refresh scratch detached" }),
    ];

    const answers = await Promise.all(reads.map((read) => getAs(world, "nick", read)));
    const listing = answers[0]?.body ?? "";
    const own = await getAs(world, "robin", url("/api/work-contexts", { repo: LOCAL_REPO }));

    expect(answers.flatMap((answer, index) => secretsIn(answer.body).map((secret) => `${reads[index] ?? ""}: ${secret}`)))
      .toEqual([]);
    expect(titleOf(listing, ROBIN_LOCAL_CONTEXT)).toBe(WITHHELD_TITLE);
    expect(titleOf(listing, ROBIN_DETACHED_CONTEXT)).toBe(WITHHELD_TITLE);
    expect(titleOf(own.body, ROBIN_LOCAL_CONTEXT)).toBe(SECRET_LOCAL_BRANCH);
    expect(titleOf(own.body, ROBIN_DETACHED_CONTEXT)).toBe(DETACHED_TITLE);
  });

  test("a bare-branch title stays withheld after her session moves to another branch (review round 4, L2)", async () => {
    // Re-registering moves the session's branch; the unmarked title still
    // names the branch she was on, which her session_started row recorded.
    const world = await seedOptedOutWorld();
    const moved = await registerTestSession(world.harness, world.robin.apiKey, {
      id: ROBIN_LOCAL,
      repo: LOCAL_REPO,
      branch: "feat/robin-after-geneva",
      baseCommit: SECRET_SHA2,
    });
    expect(moved.status).toBeLessThan(300);

    const listing = await getAs(world, "nick", url("/api/work-contexts", { repo: LOCAL_REPO }));

    expect(secretsIn(listing.body)).toEqual([]);
    expect(titleOf(listing.body, ROBIN_LOCAL_CONTEXT)).toBe(WITHHELD_TITLE);
  });

  test("an unmarked update keeps the marker of an unchanged title, and a changed title is judged by its shape", async () => {
    const world = await seedOptedOutWorld();
    const update = async (title: string): Promise<void> => {
      const posted = await postRecords(world.harness, world.robin, {
        records: [
          recordEnvelope(
            "work_context",
            validWorkContextBody({ id: ROBIN_HOST_CONTEXT, sessionId: ROBIN_LIVE, title, status: "testing", createdAt: HOST_CREATED_AT }),
            { sessionId: ROBIN_LIVE },
          ),
        ],
      });
      expect(posted.data?.rejected).toBe(0);
    };

    // An older connector re-sends the host title without the marker.
    await update(HOST_TITLE);
    const kept = await getAs(world, "nick", url("/api/work-contexts", { repo: REPO }));
    // …then renames it to something fallback-shaped, still unmarked.
    await update(`${SECRET_BRANCH} @ api`);
    const renamed = await getAs(world, "nick", url("/api/work-contexts", { repo: REPO }));

    expect(titleOf(kept.body, ROBIN_HOST_CONTEXT)).toBe(HOST_TITLE);
    expect(titleOf(renamed.body, ROBIN_HOST_CONTEXT)).toBe(WITHHELD_TITLE);
  });
});

describe("her activity after the opt-out (review round 4, H3 and M3)", () => {
  // The work goes on and stays shared; the instants of it are hers.
  test("a re-observed claim carries neither when she saw it again nor how often", async () => {
    const world = await seedOptedOutWorld();

    const diagnosis = await getAs(world, "nick", `/api/work-contexts/${ROBIN_CONTEXT}/diagnosis`);
    const claim = (JSON.parse(diagnosis.body) as { data: { claims: readonly Record<string, unknown>[] } }).data.claims.find(
      (row) => row["id"] === "clm_robin",
    );

    expect(secretsIn(diagnosis.body)).toEqual([]);
    expect(claim?.["lastSeenAt"]).toBeNull();
    expect(claim?.["dedupCount"]).toBe(1);
  });

  test("a draft her connector derived is dated to the day on a colleague's tree (integration review L8)", async () => {
    // A derived claim's creation is the derivation's machine stamp — the
    // instant her session did the work — not when somebody chose to write.
    const world = await seedOptedOutWorld();
    const derivedAt = world.harness.clock.now().toISOString();
    const posted = await postRecords(world.harness, world.robin, {
      records: [
        recordEnvelope(
          "claim",
          validClaimBody({ id: "clm_robin_draft", workContextId: ROBIN_CONTEXT, authorSessionId: ROBIN_LIVE, kind: "observation", status: "proposed", provenance: "derived", captureMode: "agent", confidence: 0.4, body: "The refresh retries hit the cache before the rotation lands", createdAt: derivedAt }),
          { sessionId: ROBIN_LIVE },
        ),
      ],
    });
    expect(posted.data?.accepted).toBe(1);
    world.harness.clock.advanceSeconds(ANSWER_DELAY_S);

    const createdAtOf = async (who: "nick" | "robin"): Promise<unknown> =>
      (JSON.parse((await getAs(world, who, `/api/work-contexts/${ROBIN_CONTEXT}/diagnosis`)).body) as { data: { claims: readonly Record<string, unknown>[] } }).data.claims.find(
        (row) => row["id"] === "clm_robin_draft",
      )?.["createdAt"];
    const page = await getAs(world, "nick", `/ui/work-contexts/${ROBIN_CONTEXT}`);

    expect(await createdAtOf("nick")).toBe(`${derivedAt.slice(0, 10)}T00:00:00.000Z`);
    expect(await createdAtOf("robin")).toBe(derivedAt);
    expect(page.body).not.toContain(derivedAt);
    expect(page.body).not.toMatch(/\b1m ago\b/);
  });

  test("a teammate's claim on her context keeps its own re-observation: each row by its own owner", async () => {
    const world = await seedOptedOutWorld();
    const kenClaim = (id: string) =>
      recordEnvelope(
        "claim",
        validClaimBody({ id, workContextId: ROBIN_CONTEXT, authorSessionId: KEN_SESSION, kind: "observation", body: "Ken saw the refresh retry twice" }),
        { sessionId: KEN_SESSION },
      );
    await postRecords(world.harness, world.ken, { records: [kenClaim("clm_ken_on_robin")] });
    world.harness.clock.advanceSeconds(60);
    await postRecords(world.harness, world.ken, { records: [kenClaim("clm_ken_on_robin_again")] });

    const diagnosis = await getAs(world, "nick", `/api/work-contexts/${ROBIN_CONTEXT}/diagnosis`);
    const claim = (JSON.parse(diagnosis.body) as { data: { claims: readonly Record<string, unknown>[] } }).data.claims.find(
      (row) => row["id"] === "clm_ken_on_robin",
    );

    expect(claim?.["dedupCount"]).toBe(2);
    expect(claim?.["lastSeenAt"]).not.toBeNull();
  });

  test("a hint about a file she touched does not say when she touched it", async () => {
    const world = await seedOptedOutWorld();

    const hints = await getAs(world, "nick", url("/api/hints/candidates", { repo: REPO, query: ROBIN_NEW_FILE }));

    expect(hints.status).toBe(200);
    expect(hints.body).toContain(ROBIN_NEW_FILE);
    expect(secretsIn(hints.body)).toEqual([]);
  });

  test("her landed work says landed, to the day, not the instant her session reported it", async () => {
    const world = await seedOptedOutWorld();

    const listing = await getAs(world, "nick", url("/api/work-contexts", { repo: LOCAL_REPO }));
    const own = await getAs(world, "robin", url("/api/work-contexts", { repo: LOCAL_REPO }));

    expect(secretsIn(listing.body)).toEqual([]);
    expect(landedAtOf(listing.body, ROBIN_LOCAL_CONTEXT)).toBe(`${LANDED_AT.slice(0, 10)}T00:00:00.000Z`);
    expect(landedAtOf(own.body, ROBIN_LOCAL_CONTEXT)).toBe(LANDED_AT);
  });

  test("her pin is listed without her HEAD or when she verified it (M3)", async () => {
    const world = await seedOptedOutWorld();

    const pins = await getAs(world, "nick", url("/api/pins", { repo: REPO }));
    const own = await getAs(world, "robin", url("/api/pins", { repo: REPO }));

    expect(pins.body).toContain(ROBIN_PIN);
    expect(secretsIn(pins.body)).toEqual([]);
    expect(secretsIn(own.body)).toEqual(expect.arrayContaining(["sha 40", "pin verified"]));
  });
});

describe("a revalidation is its REPORTER's reading (review round 4, H3)", () => {
  const validityIn = (body: string, claimId: string): Record<string, unknown> | undefined =>
    ((JSON.parse(body) as { data: { claims: readonly { id: string; validity: Record<string, unknown> }[] } }).data.claims.find(
      (row) => row.id === claimId,
    ))?.validity;

  test("her reading of a teammate's claim says what it found, not when or at which commit", async () => {
    const world = await seedOptedOutWorld();

    const nick = await getAs(world, "nick", `/api/work-contexts/${NICK_CONTEXT}/diagnosis`);
    const own = await getAs(world, "robin", `/api/work-contexts/${NICK_CONTEXT}/diagnosis`);

    expect(secretsIn(nick.body)).toEqual([]);
    expect(validityIn(nick.body, "clm_nick")).toMatchObject({
      state: "current",
      basis: "context_targets",
      refCommit: null,
      lastRevalidatedAt: LOCATION_WITHHELD,
    });
    expect(validityIn(own.body, "clm_nick")).toMatchObject({ refCommit: SECRET_SHA, lastRevalidatedAt: REVALIDATED_AT });
  });

  test("a teammate's reading of HER claim is the teammate's, shown whole", async () => {
    const world = await seedOptedOutWorld();
    const reading = await world.harness.app.request("/api/claim-revalidations", jsonRequest("POST", world.nick.apiKey, {
      repo: REPO,
      revalidated: 1,
      total: 1,
      entries: [{ claimId: "clm_robin", result: "unchanged", basis: "context_targets", refCommit: NICK_REF, touchingCommits: [], touchingTotal: 0 }],
    }));
    expect(reading.status).toBe(200);

    const nick = await getAs(world, "nick", `/api/work-contexts/${ROBIN_CONTEXT}/diagnosis`);

    expect(validityIn(nick.body, "clm_robin")).toMatchObject({
      refCommit: NICK_REF,
      lastRevalidatedAt: world.harness.clock.now().toISOString(),
      observedAtCommit: null,
    });
  });

  test("the same reading reaches the referee brief and the solved pointer whole, where a validity is a row of its own (review round 5, L1)", async () => {
    // Arrange: Nick's pull reads her claim and her root causes.
    const world = await seedOptedOutWorld();
    const entry = (claimId: string) => ({ claimId, result: "unchanged", basis: "context_targets", refCommit: NICK_REF, touchingCommits: [], touchingTotal: 0 });
    const reading = await world.harness.app.request("/api/claim-revalidations", jsonRequest("POST", world.nick.apiKey, {
      repo: REPO,
      revalidated: 3,
      total: 3,
      entries: [entry("clm_robin"), entry("clm_robin_root"), entry("clm_robin_root_checked")],
    }));
    expect(reading.status).toBe(200);
    const nicksReading = { refCommit: NICK_REF, lastRevalidatedAt: world.harness.clock.now().toISOString() };

    // Act
    const brief = await getAs(world, "nick", `/api/contradictions/${contradictionIdFor("clm_nick", "clm_robin")}/brief`);
    const solved = await getAs(world, "nick", url("/api/solved-matches", { repo: REPO, fingerprint: ROBIN_FINGERPRINT }));

    // Assert
    const positions = (JSON.parse(brief.body) as { data: { brief: { positionA: { claim: { id: string }; validity: unknown }; positionB: { claim: { id: string }; validity: unknown } } } }).data.brief;
    const hers = [positions.positionA, positions.positionB].find((position) => position.claim.id === "clm_robin");
    expect(hers?.validity).toMatchObject(nicksReading);
    const matches = (JSON.parse(solved.body) as { data: { matches: readonly { rootCauseValidity: unknown }[] } }).data.matches;
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.rootCauseValidity).toMatchObject(nicksReading);
  });
});

describe("a withheld title is not in the search index (review round 4, H4)", () => {
  // probe-search-guess.ts: a colleague confirmed a GUESSED branch by
  // searching it, because the fallback title the page withholds was still
  // the text the index matched.
  const GUESSES: readonly (readonly [repo: string, query: string])[] = [
    [REPO, SECRET_BRANCH],
    [REPO, "relocates zurich"],
    [REPO, "feat/robin-relocates-to-geneva"],
    [LOCAL_REPO, SECRET_BRANCH],
    [LOCAL_REPO, SECRET_LOCAL_BRANCH],
    [LOCAL_REPO, "geneva hideout"],
    [LOCAL_REPO, SECRET_SHA2.slice(0, 9)],
  ];
  const robinIds = (body: string): readonly string[] => [...new Set(body.match(/wc_robin[a-z_]*/g) ?? [])];

  test("a guessed branch or sha finds none of her work, in search or in hints", async () => {
    const world = await seedOptedOutWorld();

    const found = await Promise.all(
      GUESSES.flatMap(([repo, query]) => [
        getAs(world, "nick", url("/api/search", { repo, query })).then((answer) => [`search ${repo} «${query}»`, robinIds(answer.body)] as const),
        getAs(world, "nick", url("/api/hints/candidates", { repo, query })).then((answer) => [`hints ${repo} «${query}»`, robinIds(answer.body)] as const),
      ]),
    );

    expect(found.filter(([, ids]) => ids.length > 0)).toEqual([]);
  });

  test("her work is still found by what it is about", async () => {
    const world = await seedOptedOutWorld();

    const search = await getAs(world, "nick", url("/api/search", { repo: REPO, query: "rotation window" }));

    expect(robinIds(search.body)).toContain(ROBIN_CONTEXT);
  });

  test("opting back in puts her titles back in the index", async () => {
    const world = await seedOptedOutWorld();
    const back = await world.harness.app.request("/api/settings/presence", jsonRequest("PUT", world.robin.apiKey, { optOut: false }));
    expect(back.status).toBe(200);

    const search = await getAs(world, "nick", url("/api/search", { repo: REPO, query: SECRET_BRANCH }));

    expect(robinIds(search.body)).toContain(ROBIN_CONTEXT);
  });
});

describe("her commit evidence counts; only WHEN she collected is withheld (review round 5, C1)", () => {
  interface Absences {
    readonly data: {
      readonly absences: readonly { readonly kind: string; readonly name: string; readonly evidenceCollectedAt: string }[];
      readonly coverage: { readonly sources: readonly { readonly source: string; readonly state: string; readonly observedAt: string | null }[] };
    };
  }
  const absencesOf = (body: string): Absences["data"] => (JSON.parse(body) as Absences).data;

  test("the git rung and the absence findings never carry when her SessionStart collected", async () => {
    const world = await seedOptedOutWorld();

    const nick = await getAs(world, "nick", url("/api/absences", { repo: REPO }));
    const own = await getAs(world, "robin", url("/api/absences", { repo: REPO }));

    expect(secretsIn(nick.body)).toEqual([]);
    expect(secretsIn(own.body)).toContain("commit evidence");
  });

  test("an author only her report names counts for a colleague too, as unreported work", async () => {
    const world = await seedOptedOutWorld();

    const nick = absencesOf((await getAs(world, "nick", url("/api/absences", { repo: REPO }))).body);

    expect(nick.absences.find((finding) => finding.name === "Sam")).toMatchObject({
      kind: "unconnected",
      evidenceCollectedAt: LOCATION_WITHHELD,
    });
    expect(nick.coverage.sources.find((row) => row.source === "git")?.state).toBe("incomplete");
  });
});

/** A default-branch commit Nick's clone resolves — his, and nothing of hers. */
const NICK_REF = "abcdef1234567";

const landedAtOf = (body: string, id: string): string | null | undefined =>
  (listed(body).find((row) => row.id === id) as { landedAt?: string | null } | undefined)?.landedAt;

const reportLanded = async (
  world: Awaited<ReturnType<typeof seedOptedOutWorld>>,
  who: "nick" | "robin",
  commits: readonly string[],
): Promise<void> => {
  const developer = who === "nick" ? world.nick : world.robin;
  const sessionId = who === "nick" ? NICK_SESSION : ROBIN_LIVE;
  const posted = await postRecords(world.harness, developer, {
    records: [
      recordEnvelope(
        "landed_evidence",
        { repo: REPO, defaultBranch: "main", checkedAt: world.harness.clock.now().toISOString(), commits },
        { sessionId },
      ),
    ],
  });
  expect(posted.data?.rejected).toBe(0);
};

describe("the landed-evidence oracle (review round 3, M2)", () => {
  test("a colleague's right guess at Robin's HEAD marks nothing of hers landed", async () => {
    // A context is marked landed when a reported commit is its session's base
    // commit — so a colleague who could report HER base commit and watch
    // landedAt flip would read her HEAD back one guess at a time.
    const world = await seedOptedOutWorld();

    await reportLanded(world, "nick", [SECRET_SHA]);
    const listing = await getAs(world, "robin", url("/api/work-contexts", { repo: REPO }));

    expect(landedAtOf(listing.body, ROBIN_CONTEXT)).toBeNull();
  });

  test("her own sessions still mark her work landed", async () => {
    const world = await seedOptedOutWorld();

    await reportLanded(world, "robin", [SECRET_SHA]);
    const listing = await getAs(world, "robin", url("/api/work-contexts", { repo: REPO }));

    expect(landedAtOf(listing.body, ROBIN_CONTEXT)).not.toBeNull();
  });
});

/** A commit of Robin's on the file Nick is about to edit — the landed stop's input. */
const LANDED_SHA = "abcdef1234567";

describe("the landed-change stop (review round 3, H2)", () => {
  test("names Robin's landed work, under the withheld title and without when she started it", async () => {
    const world = await seedOptedOutWorld();

    const answer = await postAs(world, "nick", "/api/landed/context", {
      repo: REPO,
      path: FILE,
      commits: [{ sha: LANDED_SHA, authorEmail: "robin@example.com", committedAt: CREATED_AT }],
    });

    expect(answer.status).toBe(200);
    expect(secretsIn(answer.body)).toEqual([]);
    // The stop stays — it is why Nick should look before editing — and the
    // ended session's work is published; where and since when she was is not.
    expect((JSON.parse(answer.body) as { data: { matches: readonly unknown[] } }).data.matches).toEqual([
      expect.objectContaining({ workContextId: ROBIN_SOLVED, title: WITHHELD_TITLE, workStartedAt: LOCATION_WITHHELD }),
    ]);
  });

  test("answers the same whatever commit time the caller claims (review round 4, C1)", async () => {
    // The commit time is the CALLER's word. Compared with her session start
    // and last heartbeat, "matched / not matched" let a colleague binary-
    // search both instants to the second in 44 requests.
    const world = await seedOptedOutWorld();
    const now = world.harness.clock.now().getTime();
    const claimed = [-90, -40, -30, -10, -2, -1, 0, 1, 2, 10, 30, 31, 45, 90].map((days) =>
      new Date(now + days * MS_PER_DAY).toISOString(),
    );

    const answers = await Promise.all(
      claimed.map(async (committedAt) =>
        (
          await postAs(world, "nick", "/api/landed/context", {
            repo: REPO,
            path: FILE,
            commits: [{ sha: LANDED_SHA, authorEmail: "robin@example.com", committedAt }],
          })
        ).body,
      ),
    );

    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toContain(ROBIN_SOLVED);
  });

  test("answers the same about her live session's file while she goes quiet and works again (integration review H4)", async () => {
    // A file only her LIVE session touched: "matched or not" was "is she
    // inside the presence window now". Polled once a second, it flipped at
    // her last record plus the TTL, and one heartbeat flipped it back.
    const world = await seedOptedOutWorld();
    const ask = async (): Promise<string> =>
      (
        await postAs(world, "nick", "/api/landed/context", {
          repo: REPO,
          path: ROBIN_NEW_FILE,
          commits: [{ sha: LANDED_SHA, authorEmail: "robin@example.com", committedAt: CREATED_AT }],
        })
      ).body;

    const answers = [await ask()];
    for (let poll = 0; poll < LIVENESS_POLLS; poll += 1) {
      world.harness.clock.advanceSeconds(1);
      answers.push(await ask());
    }
    const heartbeat = await world.harness.app.request(
      `/api/sessions/${ROBIN_LIVE}/heartbeat`,
      jsonRequest("POST", world.robin.apiKey, { status: "implementing" }),
    );
    answers.push(await ask());

    expect(heartbeat.status).toBe(200);
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toContain(ROBIN_HOST_CONTEXT);
  });
});

/** Past the presence TTL from the read: her live session goes quiet inside the polls. */
const LIVENESS_POLLS = 120;
const MS_PER_DAY = 86_400_000;
