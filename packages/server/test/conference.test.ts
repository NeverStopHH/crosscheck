/**
 * GET /api/conference — the corpus one `crosscheck conference` may read
 * (VISION.md §2).
 *
 * Every test here is about a LINE THIS SURFACE MAY NOT CROSS, because a
 * conference is the riskiest of the four VISION capabilities: it reads the
 * whole team's work at once and hands it to a model. So: no derived claim
 * enters it, no question BODY leaves the hub through it, one person's own two
 * worktrees are never "duplicated work", and the deliberate-pull posture is
 * proved rather than assumed — a muted teammate's contradiction is still in
 * the report, because the reader asked for it.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  CONFERENCE_ENDED_GRACE_HOURS,
  CONFERENCE_MAX_CLAIMS_PER_CONTEXT,
  CONFERENCE_MAX_CONTEXTS,
  GHOST_HOT_TARGET_MAX_CONTEXTS,
  GHOST_MAX_CONTEXT_TARGETS,
  GHOST_MAX_PROBE_VALUES,
} from "../src/constants.ts";
import {
  agentSessions,
  workContexts,
  workContextTargets,
} from "../src/db/schema.ts";
import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  TEST_START_ISO,
  validClaimBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";
import { setPresenceOptOutViaApi } from "./ui-helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
/** An old main commit a long-lived worktree stays detached at. */
const STALE_DETACHED_BASE = "51eae4d8f0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5";
/** When it was committed: six weeks before the contexts open. */
const STALE_DETACHED_AT = "2026-06-12T09:00:00.000Z";
/** Past CONFERENCE_ACTIVE_WINDOW_DAYS, as a clock advance and as the instant it reaches. */
const TWENTY_DAYS_S = 20 * 86_400;
const TWENTY_DAYS_AFTER_START = "2026-08-13T09:00:00.000Z";
/** The incident's context held 180 files; all but the two shared ones are old here. */
const LONG_LIVED_OLD_TOUCHES = 178;
/** Records per POST /api/records — the route refuses more (MAX_INGEST_BATCH). */
const INGEST_CHUNK = 100;
const TWO_DAYS_BEFORE_START = "2026-07-22T09:00:00.000Z";
const MY_SESSION = "ses_mine";
const THEIR_SESSION = "ses_theirs";
const MY_CONTEXT = "wc_mine";
const THEIR_CONTEXT = "wc_theirs";

interface ConferenceClaimView {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly provenance: string;
  readonly body: string;
  readonly authorDeveloperName: string;
}

interface ConferenceContextView {
  readonly id: string;
  readonly title: string;
  readonly developerName: string;
  readonly intent: { summary?: string } | null;
  readonly claims: readonly ConferenceClaimView[];
}

interface ConferenceQuestionView {
  readonly id: string;
  readonly authorDeveloperName: string;
  readonly targetDeveloperName: string | null;
  readonly isForReader: boolean;
  readonly body?: unknown;
}

interface OverlapView {
  readonly workContextIdA: string;
  readonly workContextIdB: string;
  readonly sharedTargetCount: number;
  readonly sharedTargets: readonly { kind: string; value: string }[];
  readonly largeChangeFilesA?: number | null;
  readonly largeChangeFilesB?: number | null;
}

/** The pair of two contexts, in either order, or undefined. */
const pairOf = (view: ConferenceView, one: string, other: string): OverlapView | undefined =>
  view.overlaps.find((pair) =>
    [pair.workContextIdA, pair.workContextIdB].sort().join(" ") === [one, other].sort().join(" "),
  );

/** The large-change qualifier a pair carries for one of its contexts. */
const largeChangeIn = (pair: OverlapView | undefined, contextId: string): number | null =>
  (pair?.workContextIdA === contextId ? pair.largeChangeFilesA : pair?.largeChangeFilesB) ?? null;

interface ConferenceView {
  readonly contexts: readonly ConferenceContextView[];
  readonly overlaps: readonly OverlapView[];
  readonly questions: readonly ConferenceQuestionView[];
  readonly contradictions: readonly { readonly id: string }[];
  readonly contextsInWindow: number;
  readonly contextsInWindowCapped: boolean;
}

const fetchConference = async (
  harness: TestHarness,
  apiKey: string,
): Promise<ConferenceView> => {
  const response = await harness.app.request(
    `/api/conference?repo=${encodeURIComponent(REPO)}`,
    jsonRequest("GET", apiKey),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { conference: ConferenceView } };
  return body.data.conference;
};

const seed = async (
  harness: TestHarness,
  developer: TestDeveloper,
  records: readonly Record<string, unknown>[],
): Promise<void> => {
  const posted = await postRecords(harness, developer, { records });
  if (posted.status !== 200 || (posted.data?.rejected ?? 1) > 0) {
    throw new Error(`seed failed: ${JSON.stringify(posted.data?.results)}`);
  }
};

const declaredIntent = (summary: string): Record<string, unknown> => ({
  summary,
  provenance: "declared",
  confidence: 1,
  capturedAt: TEST_START_ISO,
});

const contextRecords = (
  contextId: string,
  sessionId: string,
  title: string,
  targets: readonly { kind: string; value: string }[] = [],
  intent?: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): readonly Record<string, unknown>[] => [
  recordEnvelope(
    "work_context",
    validWorkContextBody({
      id: contextId,
      sessionId,
      title,
      description: undefined,
      createdAt: TEST_START_ISO,
      ...(intent === undefined ? {} : { intent }),
      ...overrides,
    }),
    { sessionId },
  ),
  ...targets.map((target) =>
    recordEnvelope("target", { workContextId: contextId, ...target }, { sessionId }),
  ),
];

const claimRecord = (
  contextId: string,
  sessionId: string,
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> =>
  recordEnvelope(
    "claim",
    validClaimBody({
      id,
      workContextId: contextId,
      authorSessionId: sessionId,
      ...overrides,
    }),
    { sessionId },
  );

interface Setup {
  readonly harness: TestHarness;
  readonly me: TestDeveloper;
  readonly them: TestDeveloper;
}

const setup = async (): Promise<Setup> => {
  const { harness, developer } = await createHarnessWithSession({ id: MY_SESSION });
  const them = await addTestDeveloperWithSession(harness, "Ken", "ken@example.com", {
    id: THEIR_SESSION,
  });
  return { harness, me: developer, them };
};

describe("the conference corpus", () => {
  test("reads the team's recent contexts with their declared claims", async () => {
    // Arrange: two developers, one claim each.
    const { harness, me, them } = await setup();
    await seed(harness, me, [
      ...contextRecords(MY_CONTEXT, MY_SESSION, "Token refresh rework"),
      claimRecord(MY_CONTEXT, MY_SESSION, "clm_mine", {
        body: "The refresh endpoint 500s when the kid is unknown",
      }),
    ]);
    await seed(harness, them, [
      ...contextRecords(
        THEIR_CONTEXT,
        THEIR_SESSION,
        "Session store migration",
        [],
        declaredIntent("Move the session store behind an interface"),
      ),
      claimRecord(THEIR_CONTEXT, THEIR_SESSION, "clm_theirs", {
        body: "The store returns a stale session after a rotate",
      }),
    ]);

    // Act
    const conference = await fetchConference(harness, me.apiKey);

    // Assert: MY OWN context is in it — two people doing the same work is the
    // finding, and one of them is usually the reader.
    expect(conference.contexts.map((context) => context.id).sort()).toEqual([
      MY_CONTEXT,
      THEIR_CONTEXT,
    ]);
    const theirs = conference.contexts.find((c) => c.id === THEIR_CONTEXT);
    expect(theirs?.developerName).toBe("Ken");
    expect(theirs?.intent?.summary).toBe(
      "Move the session store behind an interface",
    );
    expect(theirs?.claims.map((claim) => claim.body)).toEqual([
      "The store returns a stale session after a rotate",
    ]);
    expect(conference.contextsInWindow).toBe(2);
    expect(conference.contextsInWindowCapped).toBe(false);
  });

  test("a teammate's DRAFT never reaches the corpus, their declared claim does", async () => {
    // Arrange: the CONTRAST first — the same body, declared, IS read.
    const { harness, me, them } = await setup();
    await seed(harness, them, [
      ...contextRecords(THEIR_CONTEXT, THEIR_SESSION, "Session store migration"),
      claimRecord(THEIR_CONTEXT, THEIR_SESSION, "clm_declared", {
        body: "Rotation drops the old kid too early",
      }),
    ]);
    expect(
      (await fetchConference(harness, me.apiKey)).contexts[0]?.claims.map(
        (claim) => claim.body,
      ),
    ).toEqual(["Rotation drops the old kid too early"]);

    // Act: a derived draft and a superseded claim on the same tree.
    await seed(harness, them, [
      claimRecord(THEIR_CONTEXT, THEIR_SESSION, "clm_draft", {
        body: "A model guessed the cache is at fault",
        provenance: "derived",
        captureMode: "auto",
        confidence: 0.4,
      }),
      claimRecord(THEIR_CONTEXT, THEIR_SESSION, "clm_old", {
        body: "An earlier theory its author revised away",
        status: "superseded",
      }),
    ]);

    // Assert: neither is in the corpus — a machine guess nobody vouched for
    // would be laundered into a second guess, and a revised claim states no
    // position.
    const bodies = (await fetchConference(harness, me.apiKey)).contexts[0]?.claims.map(
      (claim) => claim.body,
    );
    expect(bodies).toEqual(["Rotation drops the old kid too early"]);
  });

  test("landed work is out; a context whose session ENDED is still in", async () => {
    // Arrange: the overnight rule (VISION §2 runs this when nobody is live).
    const { harness, me, them } = await setup();
    await seed(harness, them, [
      ...contextRecords(THEIR_CONTEXT, THEIR_SESSION, "Session store migration"),
    ]);
    await harness.db
      .update(agentSessions)
      .set({ endedAt: new Date() })
      .where(eq(agentSessions.id, THEIR_SESSION));

    // Assert: an ended session is unattended, not finished.
    expect(
      (await fetchConference(harness, me.apiKey)).contexts.map((c) => c.id),
    ).toEqual([THEIR_CONTEXT]);

    // Act: the same context, now merged.
    await harness.db
      .update(workContexts)
      .set({ landedAt: new Date() })
      .where(eq(workContexts.id, THEIR_CONTEXT));

    // Assert: merged work is not work anybody is still doing.
    expect((await fetchConference(harness, me.apiKey)).contexts).toEqual([]);
  });

  test("a stale detached base a teammate reported landed stays in the report", async () => {
    // Arrange: Ken's long-lived worktree session is detached at a six-week-
    // old main commit (an older connector: it said nothing about it), and my
    // feature-branch SessionStart reports that commit as an ancestor of main.
    const { harness, me, them } = await setup();
    await registerTestSession(harness, them.apiKey, {
      id: THEIR_SESSION,
      branch: `detached@${STALE_DETACHED_BASE.slice(0, 9)}`,
      baseCommit: STALE_DETACHED_BASE,
    });
    await seed(harness, them, [
      ...contextRecords(THEIR_CONTEXT, THEIR_SESSION, "Session store migration"),
    ]);

    // Act: a current connector's report, dating the base as git does.
    await seed(harness, me, [
      recordEnvelope(
        "landed_evidence",
        {
          repo: REPO,
          defaultBranch: "origin/main",
          checkedAt: TEST_START_ISO,
          commits: [STALE_DETACHED_BASE],
          commitDates: [{ sha: STALE_DETACHED_BASE, committedAt: STALE_DETACHED_AT }],
        },
        { sessionId: MY_SESSION },
      ),
    ]);

    // Assert: still unfinished work the conference reads.
    expect(
      (await fetchConference(harness, me.apiKey)).contexts.map((c) => c.id),
    ).toEqual([THEIR_CONTEXT]);
  });

  test("a long-lived context's old touches do not make it a large change; an opted-out owner's is judged by count alone", async () => {
    // Arrange: Ken's long-lived context touched 178 files twenty days ago and
    // the two I touch today. Twenty days is past the conference's window.
    const { harness, me, them } = await setup();
    const shared = ["src/auth/token.ts", "src/auth/session.ts"];
    const files = (values: readonly string[]) => values.map((value) => ({ kind: "file", value }));
    const opened = { createdAt: TWENTY_DAYS_AFTER_START };
    const kensOldTouches = contextRecords(
      THEIR_CONTEXT,
      THEIR_SESSION,
      "Orchestration worktree",
      files(Array.from({ length: LONG_LIVED_OLD_TOUCHES }, (_unused, i) => `src/old/file-${String(i)}.ts`)),
      undefined,
      opened,
    );
    for (let start = 0; start < kensOldTouches.length; start += INGEST_CHUNK) {
      await seed(harness, them, kensOldTouches.slice(start, start + INGEST_CHUNK));
    }
    harness.clock.advanceSeconds(TWENTY_DAYS_S);
    await seed(harness, them, shared.map((value) =>
      recordEnvelope("target", { workContextId: THEIR_CONTEXT, kind: "file", value }, { sessionId: THEIR_SESSION }),
    ));
    await seed(harness, me, contextRecords(MY_CONTEXT, MY_SESSION, "Token refresh rework", files(shared), undefined, opened));

    // Act
    const visible = await fetchConference(harness, me.apiKey);
    await setPresenceOptOutViaApi(harness, them.apiKey, true);
    const hidden = await fetchConference(harness, me.apiKey);

    // Assert: duplicated work either way. While Ken's times may be read, his
    // context is the two files he touched this fortnight; once he opts out
    // they are not read, so all 180 count and the pair says so — qualified,
    // never dropped.
    const total = LONG_LIVED_OLD_TOUCHES + shared.length;
    expect(total).toBeGreaterThan(GHOST_MAX_CONTEXT_TARGETS);
    expect(largeChangeIn(pairOf(visible, MY_CONTEXT, THEIR_CONTEXT), THEIR_CONTEXT)).toBeNull();
    expect(pairOf(visible, MY_CONTEXT, THEIR_CONTEXT)?.sharedTargetCount).toBe(shared.length);
    expect(largeChangeIn(pairOf(hidden, MY_CONTEXT, THEIR_CONTEXT), THEIR_CONTEXT)).toBe(total);
    expect(pairOf(hidden, MY_CONTEXT, THEIR_CONTEXT)?.sharedTargetCount).toBe(shared.length);
  });

  test("a large change is never dropped from duplicated work: it pairs, qualified, after the focused pairs", async () => {
    // Arrange: Ken's rename holds three of my files, Mike's focused plan two
    // of them.
    const { harness, me, them } = await setup();
    const shared = ["src/auth/token.ts", "src/auth/session.ts", "src/auth/store.ts"];
    const files = (values: readonly string[]) => values.map((value) => ({ kind: "file", value }));
    await seed(harness, me, contextRecords(MY_CONTEXT, MY_SESSION, "Token refresh rework", files(shared)));
    const renamed = [
      ...shared,
      ...Array.from({ length: GHOST_MAX_CONTEXT_TARGETS }, (_unused, index) => `src/generated/file-${String(index)}.ts`),
    ];
    await seed(harness, them, contextRecords(THEIR_CONTEXT, THEIR_SESSION, "Rename the whole module", files(renamed)));
    const mike = await addTestDeveloperWithSession(harness, "Mike", "mike@example.com", { id: "ses_mike" });
    await seed(harness, mike, contextRecords("wc_mike", "ses_mike", "Session store migration", files(shared.slice(0, 2))));

    // Act
    const view = await fetchConference(harness, me.apiKey);

    // Assert: all three pairs; the focused one first although Ken shares more
    // with me, and each of Ken's pairs says how large his side is.
    const ids = (pair: OverlapView): string => [pair.workContextIdA, pair.workContextIdB].sort().join(" ");
    expect(view.overlaps.map(ids)).toEqual([
      [MY_CONTEXT, "wc_mike"].sort().join(" "),
      [MY_CONTEXT, THEIR_CONTEXT].sort().join(" "),
      [THEIR_CONTEXT, "wc_mike"].sort().join(" "),
    ]);
    expect(largeChangeIn(pairOf(view, MY_CONTEXT, THEIR_CONTEXT), THEIR_CONTEXT)).toBe(renamed.length);
    expect(largeChangeIn(pairOf(view, MY_CONTEXT, THEIR_CONTEXT), MY_CONTEXT)).toBeNull();
    expect(largeChangeIn(pairOf(view, THEIR_CONTEXT, "wc_mike"), THEIR_CONTEXT)).toBe(renamed.length);
    expect(largeChangeIn(pairOf(view, MY_CONTEXT, "wc_mike"), "wc_mike")).toBeNull();
  });

  test("a file a large change touched first still pairs it — its size never decides what is compared", async () => {
    // Arrange: Ken touched my two files FIRST, then more files than one
    // context's probe holds; I am in those two now.
    const { harness, me, them } = await setup();
    const shared = ["src/auth/token.ts", "src/auth/session.ts"];
    const files = (values: readonly string[]) => values.map((value) => ({ kind: "file", value }));
    await seed(harness, them, contextRecords(THEIR_CONTEXT, THEIR_SESSION, "Orchestration worktree", files(shared)));
    harness.clock.advanceSeconds(60);
    const later = Array.from({ length: GHOST_MAX_PROBE_VALUES + 10 }, (_unused, i) =>
      recordEnvelope("target", { workContextId: THEIR_CONTEXT, kind: "file", value: `src/aaa-later/f${String(i)}.ts` }, { sessionId: THEIR_SESSION }),
    );
    for (let start = 0; start < later.length; start += INGEST_CHUNK) {
      await seed(harness, them, later.slice(start, start + INGEST_CHUNK));
    }
    await seed(harness, me, contextRecords(MY_CONTEXT, MY_SESSION, "Token refresh rework", files(shared)));

    // Act
    const pair = pairOf(await fetchConference(harness, me.apiKey), MY_CONTEXT, THEIR_CONTEXT);

    // Assert: Ken's probe holds only his newest values, and the pair is found
    // anyway — through MY values, looked up in his.
    expect(pair?.sharedTargetCount).toBe(shared.length);
    expect(largeChangeIn(pair, THEIR_CONTEXT)).toBe(shared.length + later.length);
  });

  test("open sessions fill the page first, and work ended more than the grace ago is out", async () => {
    // Arrange: Ken ended twelve fresh contexts an hour ago — a full page by
    // activity — and one four days ago; Nick's one OPEN context is older by
    // activity than all of them. With landed rarely firing, the window holds
    // ended work for a fortnight, and ranked by activity alone the live
    // collision is the one that falls off the page.
    const { harness, me, them } = await setup();
    await seed(harness, me, contextRecords(MY_CONTEXT, MY_SESSION, "Live work", [], undefined, { createdAt: TWO_DAYS_BEFORE_START }));
    const nowMs = harness.clock.now().getTime();
    const endedAgo = async (sessionId: string, hours: number): Promise<void> => {
      await harness.db
        .update(agentSessions)
        .set({ endedAt: new Date(nowMs - hours * 3_600_000) })
        .where(eq(agentSessions.id, sessionId));
    };
    for (let i = 0; i < CONFERENCE_MAX_CONTEXTS; i += 1) {
      const sessionId = `ses_ended_${String(i)}`;
      await registerTestSession(harness, them.apiKey, { id: sessionId });
      await seed(harness, them, contextRecords(`wc_ended_${String(i)}`, sessionId, `Ended ${String(i)}`));
      await endedAgo(sessionId, 1);
    }
    await registerTestSession(harness, them.apiKey, { id: "ses_long_ended" });
    await seed(harness, them, contextRecords("wc_long_ended", "ses_long_ended", "Ended four days ago"));
    await endedAgo("ses_long_ended", CONFERENCE_ENDED_GRACE_HOURS + 24);

    // Act
    const view = await fetchConference(harness, me.apiKey);
    const ids = view.contexts.map((context) => context.id);

    // Assert: the open context leads; the long-ended one is neither read nor counted.
    expect(ids[0]).toBe(MY_CONTEXT);
    expect(ids).toHaveLength(CONFERENCE_MAX_CONTEXTS);
    expect(ids).not.toContain("wc_long_ended");
    expect(view.contextsInWindow).toBe(CONFERENCE_MAX_CONTEXTS + 1);
  });

  test("an opted-out teammate's session end neither drops nor ranks her work", async () => {
    // Arrange: Ken opted out. One of his sessions ended four days ago (its
    // context is fresh), another is OPEN with an older context. When his
    // sessions ended is his; by creation alone, the open one ranks last.
    const { harness, me, them } = await setup();
    await seed(harness, me, contextRecords(MY_CONTEXT, MY_SESSION, "My work"));
    await registerTestSession(harness, them.apiKey, { id: "ses_ken_ended" });
    await seed(harness, them, contextRecords("wc_ken_ended", "ses_ken_ended", "Ended long ago"));
    await seed(harness, them, contextRecords(THEIR_CONTEXT, THEIR_SESSION, "Open, older", [], undefined, { createdAt: TWO_DAYS_BEFORE_START }));
    await harness.db
      .update(agentSessions)
      .set({ endedAt: new Date(harness.clock.now().getTime() - (CONFERENCE_ENDED_GRACE_HOURS + 24) * 3_600_000) })
      .where(eq(agentSessions.id, "ses_ken_ended"));
    await harness.db
      .update(agentSessions)
      .set({ endedAt: harness.clock.now() })
      .where(eq(agentSessions.id, MY_SESSION));
    await setPresenceOptOutViaApi(harness, them.apiKey, true);

    // Act
    const ids = (await fetchConference(harness, me.apiKey)).contexts.map((context) => context.id);

    // Assert
    expect(ids).toContain("wc_ken_ended");
    expect(ids.at(-1)).toBe(THEIR_CONTEXT);
  });

  test("two developers on the same files are duplicated work; two worktrees of one are not", async () => {
    // Arrange: I hold the same two files in TWO of my own contexts.
    const { harness, me, them } = await setup();
    const files = [
      { kind: "file", value: "src/auth/token.ts" },
      { kind: "file", value: "src/auth/session.ts" },
    ];
    await registerTestSession(harness, me.apiKey, { id: "ses_mine_2" });
    await seed(harness, me, [
      ...contextRecords(MY_CONTEXT, MY_SESSION, "Token refresh rework", files),
      ...contextRecords("wc_mine_2", "ses_mine_2", "Token refresh, second tree", files),
    ]);

    // Assert: my own two worktrees pair with nobody.
    expect((await fetchConference(harness, me.apiKey)).overlaps).toEqual([]);

    // Act: Ken takes the same two files.
    await seed(harness, them, [
      ...contextRecords(THEIR_CONTEXT, THEIR_SESSION, "Session store migration", files),
    ]);

    // Assert: one pair per person-pair, with the values named.
    const overlaps = (await fetchConference(harness, me.apiKey)).overlaps;
    expect(overlaps.length).toBe(2);
    expect(overlaps[0]?.sharedTargetCount).toBe(2);
    expect(overlaps[0]?.sharedTargets.map((target) => target.value).sort()).toEqual([
      "src/auth/session.ts",
      "src/auth/token.ts",
    ]);
    for (const overlap of overlaps) {
      expect([overlap.workContextIdA, overlap.workContextIdB]).toContain(
        THEIR_CONTEXT,
      );
    }
  });

  test("an open question is a POINTER: who waits on whom, never the body", async () => {
    // Arrange
    const { harness, me, them } = await setup();
    await seed(harness, me, [
      ...contextRecords(MY_CONTEXT, MY_SESSION, "Token refresh rework"),
    ]);
    const asked = await harness.app.request(
      "/api/questions",
      jsonRequest("POST", them.apiKey, {
        id: `qn_${crypto.randomUUID()}`,
        repo: REPO,
        sessionId: THEIR_SESSION,
        body: "Which kid does the refresh path trust after a rotate?",
        developer: "Nick",
      }),
    );
    expect(asked.status).toBe(200);

    // Act
    const conference = await fetchConference(harness, me.apiKey);

    // Assert: the channel is addressed communication — the report may say a
    // thread is open and who is waiting, never what was said.
    expect(conference.questions.length).toBe(1);
    const question = conference.questions[0];
    expect(question?.authorDeveloperName).toBe("Ken");
    expect(question?.targetDeveloperName).toBe("Nick");
    expect(question?.isForReader).toBe(true);
    expect(question?.body).toBeUndefined();
    expect(JSON.stringify(conference)).not.toContain("Which kid does the refresh");

    // Assert: and the reader who may NOT answer it is told so — the report
    // prints the answer call off this flag alone.
    const forThem = await fetchConference(harness, them.apiKey);
    expect(forThem.questions[0]?.isForReader).toBe(false);
  });

  test("a muted teammate is still in the report — a conference is a pull", async () => {
    // Arrange: mute is a preference about UNASKED surfaces (visibility.ts);
    // this one was typed by the reader.
    const { harness, me, them } = await setup();
    await seed(harness, them, [
      ...contextRecords(THEIR_CONTEXT, THEIR_SESSION, "Session store migration"),
    ]);
    const muted = await harness.app.request(
      "/api/settings/mutes",
      jsonRequest("POST", me.apiKey, { developer: them.developerId }),
    );
    expect(muted.status).toBe(200);

    // Act + Assert
    expect(
      (await fetchConference(harness, me.apiKey)).contexts.map((c) => c.id),
    ).toEqual([THEIR_CONTEXT]);
  });

  test("one loud tree cannot empty the eleven beside it", async () => {
    // Arrange: a context with more claims than the whole slice's window.
    const { harness, me, them } = await setup();
    const loud = Array.from(
      { length: CONFERENCE_MAX_CLAIMS_PER_CONTEXT * CONFERENCE_MAX_CONTEXTS + 5 },
      (_unused, index) =>
        claimRecord(THEIR_CONTEXT, THEIR_SESSION, `clm_loud_${String(index)}`, {
          body: `Loud finding number ${String(index)}`,
        }),
    );
    await seed(harness, them, [
      ...contextRecords(THEIR_CONTEXT, THEIR_SESSION, "Session store migration"),
      ...loud,
    ]);
    await seed(harness, me, [
      ...contextRecords(MY_CONTEXT, MY_SESSION, "Token refresh rework"),
      claimRecord(MY_CONTEXT, MY_SESSION, "clm_quiet", {
        body: "The quiet tree still has something to say",
      }),
    ]);

    // Act
    const conference = await fetchConference(harness, me.apiKey);

    // Assert: the loud tree spends its own five and nobody else's.
    const theirs = conference.contexts.find((c) => c.id === THEIR_CONTEXT);
    const mine = conference.contexts.find((c) => c.id === MY_CONTEXT);
    expect(theirs?.claims.length).toBe(CONFERENCE_MAX_CLAIMS_PER_CONTEXT);
    expect(mine?.claims.map((claim) => claim.body)).toEqual([
      "The quiet tree still has something to say",
    ]);
  });
  test("a file every context touches is not a contradiction candidate", async () => {
    // Arrange: the CONTRAST first — a RARE shared file pairs two opposite
    // theories, which is the signal this tier exists for.
    const { harness, me, them } = await setup();
    const rare = [{ kind: "file", value: "src/auth/token.ts" }];
    await seed(harness, them, [
      ...contextRecords(THEIR_CONTEXT, THEIR_SESSION, "Session store migration", rare),
      claimRecord(THEIR_CONTEXT, THEIR_SESSION, "clm_open", {
        kind: "root_cause",
        body: "Rotation drops the old kid too early",
        status: "proposed",
      }),
    ]);
    await seed(harness, me, [
      ...contextRecords(MY_CONTEXT, MY_SESSION, "Token refresh rework", rare),
      claimRecord(MY_CONTEXT, MY_SESSION, "clm_rejected", {
        kind: "root_cause",
        body: "Rotation was never the cause here",
        status: "rejected",
      }),
    ]);
    expect((await fetchConference(harness, me.apiKey)).contradictions.length).toBe(1);

    // Act: the same two theories now share a LOCKFILE instead — a value more
    // than GHOST_HOT_TARGET_MAX_CONTEXTS contexts of this repo carry. The
    // filler contexts are landed, so they are out of the slice the report
    // reads and the ONLY thing they change is the value's rarity.
    await harness.db
      .delete(workContextTargets)
      .where(eq(workContextTargets.value, "src/auth/token.ts"));
    const hot = [{ kind: "file", value: "bun.lock" }];
    await seed(harness, me, [
      ...contextRecords(MY_CONTEXT, MY_SESSION, "Token refresh rework", hot),
    ]);
    await seed(harness, them, [
      ...contextRecords(THEIR_CONTEXT, THEIR_SESSION, "Session store migration", hot),
    ]);
    for (let index = 0; index < GHOST_HOT_TARGET_MAX_CONTEXTS - 1; index += 1) {
      const id = `wc_filler_${String(index)}`;
      await seed(harness, me, [
        ...contextRecords(id, MY_SESSION, `Filler ${String(index)}`, hot),
      ]);
      await harness.db
        .update(workContexts)
        .set({ landedAt: new Date() })
        .where(eq(workContexts.id, id));
    }

    // Assert: a lockfile two dozen sessions edit is not evidence that two
    // theories are about the same thing — and pairing on it is what makes
    // this join quadratic (the 24 s the reviewer measured).
    const conference = await fetchConference(harness, me.apiKey);
    expect(conference.contexts.map((context) => context.id).sort()).toEqual([
      MY_CONTEXT,
      THEIR_CONTEXT,
    ]);
    expect(conference.contradictions).toEqual([]);
  });

  test("a contradiction outside the contexts the report read is not in it", async () => {
    // Arrange: the pair sits on the two OLDEST contexts, pushed out of the
    // CONFERENCE_MAX_CONTEXTS slice by fresher work.
    const { harness, me, them } = await setup();
    const rare = [{ kind: "file", value: "src/auth/token.ts" }];
    await seed(harness, them, [
      ...contextRecords(THEIR_CONTEXT, THEIR_SESSION, "Session store migration", rare),
      claimRecord(THEIR_CONTEXT, THEIR_SESSION, "clm_open", {
        kind: "root_cause",
        body: "Rotation drops the old kid too early",
        status: "proposed",
      }),
    ]);
    await seed(harness, me, [
      ...contextRecords(MY_CONTEXT, MY_SESSION, "Token refresh rework", rare),
      claimRecord(MY_CONTEXT, MY_SESSION, "clm_rejected", {
        kind: "root_cause",
        body: "Rotation was never the cause here",
        status: "rejected",
      }),
    ]);
    expect((await fetchConference(harness, me.apiKey)).contradictions.length).toBe(1);

    // Act: age the pair, then fill the window with fresher contexts.
    await harness.db
      .update(workContexts)
      .set({ updatedAt: new Date(Date.parse(TEST_START_ISO) - 60_000) })
      .where(eq(workContexts.id, MY_CONTEXT));
    await harness.db
      .update(workContexts)
      .set({ updatedAt: new Date(Date.parse(TEST_START_ISO) - 60_000) })
      .where(eq(workContexts.id, THEIR_CONTEXT));
    for (let index = 0; index < CONFERENCE_MAX_CONTEXTS; index += 1) {
      await seed(harness, me, [
        ...contextRecords(`wc_fresh_${String(index)}`, MY_SESSION, `Fresh ${String(index)}`),
      ]);
    }

    // Assert: every other tier of this corpus is bounded by the slice, and
    // this one is now too — a pair whose live side the report never printed
    // has no context line a reader could open it against.
    const conference = await fetchConference(harness, me.apiKey);
    expect(conference.contexts.map((context) => context.id)).not.toContain(MY_CONTEXT);
    expect(conference.contradictions).toEqual([]);

    // Assert: and the repo-wide listing still has it — the bound is this
    // report's, not the hub's.
    const listed = await harness.app.request(
      `/api/contradictions?repo=${encodeURIComponent(REPO)}`,
      jsonRequest("GET", me.apiKey),
    );
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      data: { candidates: readonly unknown[] };
    };
    expect(body.data.candidates.length).toBe(1);
  });
});
