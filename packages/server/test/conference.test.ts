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
  CONFERENCE_MAX_CLAIMS_PER_CONTEXT,
  CONFERENCE_MAX_CONTEXTS,
} from "../src/constants.ts";
import { agentSessions, workContexts } from "../src/db/schema.ts";
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

const REPO = VALID_SESSION_BODY.repo;
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

interface ConferenceView {
  readonly contexts: readonly ConferenceContextView[];
  readonly overlaps: readonly {
    readonly workContextIdA: string;
    readonly workContextIdB: string;
    readonly sharedTargetCount: number;
    readonly sharedTargets: readonly { kind: string; value: string }[];
  }[];
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
});
