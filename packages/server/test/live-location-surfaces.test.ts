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

import {
  CREATED_AT,
  FILE,
  HOST_CREATED_AT,
  REPO,
  ROBIN_CONTEXT,
  ROBIN_HOST_CONTEXT,
  ROBIN_OLD_CONTEXT,
  ROBIN_SOLVED,
  SECRET_BRANCH,
  UPDATED_AT,
  getAs,
  postAs,
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
    expect(conferenceQuestionTitles(asNick.body)).toEqual({ q_ken_1: WITHHELD_TITLE, q_robin_1: WITHHELD_TITLE });
    expect(conferenceQuestionTitles(asRobin.body)).toEqual({
      q_ken_1: `${SECRET_BRANCH} @ api`,
      q_robin_1: `${SECRET_BRANCH} @ api`,
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
});

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

  test("freshest-first ranks her work by creation, so the order says nothing of her last touch", async () => {
    const world = await seedOptedOutWorld();

    const asNick = await getAs(world, "nick", url("/api/work-contexts", { repo: REPO }));
    const asRobin = await getAs(world, "robin", url("/api/work-contexts", { repo: REPO }));

    expect(robinsRows(world, listed(asNick.body))[0]?.id).toBe(ROBIN_HOST_CONTEXT);
    expect(robinsRows(world, listed(asRobin.body))[0]?.id).toBe(ROBIN_CONTEXT);
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
});
