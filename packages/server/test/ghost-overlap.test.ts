/**
 * GET /api/ghost-checks — the deterministic half of ghost commits
 * (VISION.md §3): whose LIVE plan overlaps mine, and on what.
 *
 * Every test here is really about the FLOOR and the two exclusions, because
 * that is the whole difference between a warning system people keep and one
 * they turn off. ConE — the only deployed concurrent-edit detector with
 * published numbers (Maddila, Nagappan et al., TOSEM 2021: 775 notifications
 * over 26 000 pull requests, 554 of them rated useful) — spends most of its
 * design
 * on exactly this: how much overlap is enough, and which files must never
 * count. So: one shared file is not a plan, one shared FAILURE is; a lockfile
 * everybody touches is nothing; a fifty-file change collides with everybody,
 * so its row says how large it is and ranks after a focused one — but it is
 * never dropped, because a large surface is still collision-relevant.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  GHOST_HOT_TARGET_MAX_CONTEXTS,
  GHOST_MAX_CONTEXT_TARGETS,
  GHOST_MAX_PROBE_VALUES,
} from "../src/constants.ts";
import { agentSessions, workContexts } from "../src/db/schema.ts";
import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  TEST_START_ISO,
  validWorkContextBody,
  VALID_SESSION_BODY,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
/** An old main commit a long-lived worktree stays detached at. */
const STALE_DETACHED_BASE = "51eae4d8f0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5";
/** When it was committed: six weeks before the contexts open. */
const STALE_DETACHED_AT = "2026-06-12T09:00:00.000Z";
/** Past GHOST_ACTIVE_WINDOW_DAYS, as a clock advance and as the instant it reaches. */
const TEN_DAYS_S = 10 * 86_400;
const TEN_DAYS_AFTER_START = "2026-08-03T09:00:00.000Z";
/** The incident's context held 180 files; all but the two shared ones are old here. */
const LONG_LIVED_OLD_TOUCHES = 178;
const MY_SESSION = "ses_mine";
const THEIR_SESSION = "ses_theirs";
const MY_CONTEXT = "wc_mine";
const THEIR_CONTEXT = "wc_theirs";
const FINGERPRINT = "sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f0";

/**
 * Targets on my own renaming worktree: more than the probe one context may
 * spend, so a probe ranked across my contexts instead of within each would
 * leave the other context nothing.
 */
const OWN_SWEEP_TARGETS = GHOST_MAX_PROBE_VALUES + 10;

/** A teammate's change the size of the pilot incident's, all of it touched today. */
const INCIDENT_FILES = 180;

/** A row's qualifier: the files its large change touched, or null for a focused one. */
const largeChangeOf = (row: GhostView | undefined): number | null => row?.largeChangeFiles ?? null;

/** Warm values the crowd carries, each on CROWD_SHARERS foreign contexts. */
const CROWD_VALUES = 45;
const CROWD_SHARERS = 9;

/** Records per POST /api/records — the route refuses more (MAX_INGEST_BATCH). */
const INGEST_CHUNK = 100;

interface GhostView {
  readonly workContextId: string;
  readonly developerName: string;
  readonly sharedTargets: readonly { kind: string; value: string }[];
  readonly sharedTargetCount: number;
  readonly intentTokenHits: number;
  readonly intent: { summary?: string } | null;
  readonly largeChangeFiles?: number | null;
  readonly branch?: string | null;
}

const fetchGhostChecks = async (
  harness: TestHarness,
  apiKey: string,
): Promise<readonly GhostView[]> => {
  const response = await harness.app.request(
    `/api/ghost-checks?repo=${encodeURIComponent(REPO)}`,
    jsonRequest("GET", apiKey),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: { ghostChecks: readonly GhostView[] };
  };
  return body.data.ghostChecks;
};

const contextRecords = (
  contextId: string,
  sessionId: string,
  title: string,
  targets: readonly { kind: string; value: string }[],
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
    recordEnvelope(
      "target",
      { workContextId: contextId, ...target },
      { sessionId },
    ),
  ),
];

/** Posts and REFUSES to continue on a rejection — a silent 200 with
 * `rejected: 1` would arrange nothing and pass the silence tests for the
 * wrong reason (the defect Block 3 found in its own teammate-intent guard). */
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

interface Setup {
  readonly harness: TestHarness;
  readonly me: TestDeveloper;
  readonly them: TestDeveloper;
}

const setup = async (): Promise<Setup> => {
  const { harness, developer } = await createHarnessWithSession({
    id: MY_SESSION,
  });
  const them = await addTestDeveloperWithSession(
    harness,
    "Ken",
    "ken@example.com",
    { id: THEIR_SESSION },
  );
  return { harness, me: developer, them };
};

describe("ghost checks, the deterministic overlap", () => {
  test("two shared files name the teammate, the count and the values", async () => {
    const { harness, me, them } = await setup();
    await seed(
      harness,
      me,
      contextRecords(MY_CONTEXT, MY_SESSION, "Token refresh rework", [
        { kind: "file", value: "src/auth/token.ts" },
        { kind: "file", value: "src/auth/session.ts" },
      ]),
    );
    await seed(
      harness,
      them,
      contextRecords(
        THEIR_CONTEXT,
        THEIR_SESSION,
        "Session store migration",
        [
          { kind: "file", value: "src/auth/token.ts" },
          { kind: "file", value: "src/auth/session.ts" },
        ],
        declaredIntent("Move the session store behind an interface"),
      ),
    );

    const checks = await fetchGhostChecks(harness, me.apiKey);
    expect(checks.length).toBe(1);
    expect(checks[0]?.workContextId).toBe(THEIR_CONTEXT);
    expect(checks[0]?.developerName).toBe("Ken");
    expect(checks[0]?.sharedTargetCount).toBe(2);
    expect(checks[0]?.sharedTargets.map((target) => target.value).sort()).toEqual([
      "src/auth/session.ts",
      "src/auth/token.ts",
    ]);
    expect(checks[0]?.intent?.summary).toBe(
      "Move the session store behind an interface",
    );
  });

  test("one shared file is not a plan, one shared failure is", async () => {
    const { harness, me, them } = await setup();
    await seed(
      harness,
      me,
      contextRecords(MY_CONTEXT, MY_SESSION, "Token refresh rework", [
        { kind: "file", value: "src/auth/token.ts" },
      ]),
    );
    await seed(
      harness,
      them,
      contextRecords(THEIR_CONTEXT, THEIR_SESSION, "Session store migration", [
        { kind: "file", value: "src/auth/token.ts" },
      ]),
    );
    expect(await fetchGhostChecks(harness, me.apiKey)).toEqual([]);

    // The SAME single shared value, now an error fingerprint: content
    // identity, so one is the floor.
    await seed(
      harness,
      me,
      [
      recordEnvelope(
        "target",
        { workContextId: MY_CONTEXT, kind: "error_fingerprint", value: FINGERPRINT },
        { sessionId: MY_SESSION },
      ),
    ]);
    await seed(
      harness,
      them,
      [
      recordEnvelope(
        "target",
        {
          workContextId: THEIR_CONTEXT,
          kind: "error_fingerprint",
          value: FINGERPRINT,
        },
        { sessionId: THEIR_SESSION },
      ),
    ]);
    const withFingerprint = await fetchGhostChecks(harness, me.apiKey);
    expect(withFingerprint.length).toBe(1);
    expect(
      withFingerprint[0]?.sharedTargets.map((target) => target.kind),
    ).toContain("error_fingerprint");
  });

  test("a hot value everybody touches is not evidence of a plan", async () => {
    const { harness, me, them } = await setup();
    // ORDINARY files every session edits — the config and the router. Not
    // lockfiles: those are labelled generated and never evidence at all
    // (services/generated-targets.ts), so they could not show the HOT rule.
    const lockfiles = ["src/config.ts", "src/router.ts"];
    const plan = ["src/auth/token.ts", "src/auth/session.ts"];
    const asTargets = (values: readonly string[]): readonly {
      kind: string;
      value: string;
    }[] => values.map((value) => ({ kind: "file", value }));

    await seed(
      harness,
      me,
      contextRecords(
        MY_CONTEXT,
        MY_SESSION,
        "Token refresh rework",
        asTargets([...lockfiles, ...plan]),
      ),
    );
    await seed(
      harness,
      them,
      contextRecords(
        THEIR_CONTEXT,
        THEIR_SESSION,
        "Session store migration",
        asTargets([...lockfiles, ...plan]),
      ),
    );
    // A neighbour who shares NOTHING but the two lockfiles. While they are
    // cool that is two shared values and therefore a notice — which is
    // exactly the false alarm the hot rule exists to remove, and the control
    // that makes the silence below mean something.
    //
    // A DIFFERENT developer on purpose: one teammate holds at most
    // GHOST_MAX_FINDINGS_PER_DEVELOPER lines, so a neighbour context of Ken's
    // would vanish below for a reason that has nothing to do with lockfiles.
    const neighbourSession = "ses_neighbour";
    const neighbour = await addTestDeveloperWithSession(
      harness,
      "Mike",
      "mike@example.com",
      { id: neighbourSession },
    );
    await seed(
      harness,
      neighbour,
      contextRecords(
        "wc_neighbour",
        neighbourSession,
        "Bump the dependencies",
        asTargets(lockfiles),
      ),
    );
    const before = await fetchGhostChecks(harness, me.apiKey);
    expect(
      before.find((row) => row.workContextId === THEIR_CONTEXT)
        ?.sharedTargetCount,
    ).toBe(4);
    expect(before.some((row) => row.workContextId === "wc_neighbour")).toBe(true);

    // Now make the lockfiles hot: enough contexts on this repo carry them
    // that they say nothing about anybody's plan.
    for (let index = 0; index <= GHOST_HOT_TARGET_MAX_CONTEXTS; index += 1) {
      const sessionId = `ses_crowd_${String(index)}`;
      await registerTestSession(harness, them.apiKey, { id: sessionId });
      await seed(
        harness,
        them,
        contextRecords(
          `wc_crowd_${String(index)}`,
          sessionId,
          `Unrelated work ${String(index)}`,
          asTargets(lockfiles),
        ),
      );
    }
    const after = await fetchGhostChecks(harness, me.apiKey);
    const forTheirContext = after.find(
      (row) => row.workContextId === THEIR_CONTEXT,
    );
    expect(forTheirContext?.sharedTargetCount).toBe(2);
    expect(
      [...(forTheirContext?.sharedTargets ?? [])]
        .map((target) => target.value)
        .sort(),
    ).toEqual([...plan].sort());
    // The neighbour, whose whole case was the lockfiles, is silent now — and
    // so is every context in the crowd that made them hot.
    expect(after.some((row) => row.workContextId === "wc_neighbour")).toBe(false);
    expect(after.some((row) => row.workContextId.startsWith("wc_crowd_"))).toBe(
      false,
    );
  });

  test("a change over the large-change line still collides — qualified, and after a focused one", async () => {
    // Arrange: Ken's rename shares THREE of my files, Mike's focused plan two.
    const { harness, me, them } = await setup();
    const shared = ["src/auth/token.ts", "src/auth/session.ts", "src/auth/store.ts"];
    const files = (values: readonly string[]) => values.map((value) => ({ kind: "file", value }));
    await seed(harness, me, contextRecords(MY_CONTEXT, MY_SESSION, "Token refresh rework", files(shared)));
    const renamed = [
      ...shared,
      ...Array.from({ length: GHOST_MAX_CONTEXT_TARGETS }, (_unused, index) => `src/renamed/file-${String(index)}.ts`),
    ];
    await seed(harness, them, contextRecords(THEIR_CONTEXT, THEIR_SESSION, "Rename the whole module", files(renamed)));
    const mike = await addTestDeveloperWithSession(harness, "Mike", "mike@example.com", { id: "ses_mike" });
    await seed(harness, mike, contextRecords("wc_modest", "ses_mike", "Session store migration", files(shared.slice(0, 2))));

    // Act
    const checks = await fetchGhostChecks(harness, me.apiKey);

    // Assert: both collide. Ken's row says how large his change is and ranks
    // after Mike's although it shares more — a file shared with a rename is
    // weaker evidence than one shared with a plan, never no evidence.
    expect(renamed.length).toBeGreaterThan(GHOST_MAX_CONTEXT_TARGETS);
    expect(checks.map((row) => row.workContextId)).toEqual(["wc_modest", THEIR_CONTEXT]);
    expect(checks.map(largeChangeOf)).toEqual([null, renamed.length]);
    expect(checks[1]?.sharedTargetCount).toBe(shared.length);
  });

  test("the incident's shape: a 180-file change touched today still collides, qualified", async () => {
    // Arrange: the reviewer's demo. Ken's one context touched 180 files today,
    // two of them mine; I am in those two.
    const { harness, me, them } = await setup();
    const shared = ["src/auth/token.ts", "src/auth/session.ts"];
    const files = (values: readonly string[]) => values.map((value) => ({ kind: "file", value }));
    await seed(harness, me, contextRecords(MY_CONTEXT, MY_SESSION, "Token refresh rework", files(shared)));
    const kens = contextRecords(
      THEIR_CONTEXT,
      THEIR_SESSION,
      "Orchestration worktree",
      files([...shared, ...Array.from({ length: INCIDENT_FILES - shared.length }, (_unused, i) => `src/other/f${String(i)}.ts`)]),
    );
    for (let start = 0; start < kens.length; start += INGEST_CHUNK) {
      await seed(harness, them, kens.slice(start, start + INGEST_CHUNK));
    }

    // Act
    const checks = await fetchGhostChecks(harness, me.apiKey);

    // Assert
    expect(INCIDENT_FILES).toBeGreaterThan(GHOST_MAX_CONTEXT_TARGETS);
    expect(checks.map((row) => row.workContextId)).toEqual([THEIR_CONTEXT]);
    expect(largeChangeOf(checks[0])).toBe(INCIDENT_FILES);
    expect(checks[0]?.sharedTargetCount).toBe(shared.length);
  });

  test("my own large change still collides with the teammate in it", async () => {
    // Arrange: MY context touched sixty files today, two of them Ken's.
    const { harness, me, them } = await setup();
    const shared = ["src/auth/token.ts", "src/auth/session.ts"];
    const files = (values: readonly string[]) => values.map((value) => ({ kind: "file", value }));
    const mine = [...shared, ...Array.from({ length: GHOST_MAX_CONTEXT_TARGETS + 8 }, (_unused, i) => `src/gen/file-${String(i)}.ts`)];
    await seed(harness, me, contextRecords(MY_CONTEXT, MY_SESSION, "Rename the whole module", files(mine)));
    await seed(harness, them, contextRecords(THEIR_CONTEXT, THEIR_SESSION, "Session store migration", files(shared)));

    // Act
    const checks = await fetchGhostChecks(harness, me.apiKey);

    // Assert: my size is no reason to hide Ken from me, and his row is his
    // focused plan — the qualifier is about THEIR change, never mine.
    expect(mine.length).toBeGreaterThan(GHOST_MAX_CONTEXT_TARGETS);
    expect(checks.map((row) => row.workContextId)).toEqual([THEIR_CONTEXT]);
    expect(largeChangeOf(checks[0])).toBeNull();
  });

  test("a long-lived context's old touches do not make it a large change — only what it touched in the window counts", async () => {
    // Arrange: the pilot incident's real shape. Ken's one long-lived context
    // touched 178 files ten days ago and the two I am in today; Mike's
    // touched sixty files today — a large change now.
    const harness = await createTestHarness();
    const me = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const ken = await createTestDeveloper(harness, "Ken", "ken@example.com");
    const mike = await createTestDeveloper(harness, "Mike", "mike@example.com");
    await registerTestSession(harness, me.apiKey, { id: MY_SESSION });
    await registerTestSession(harness, ken.apiKey, { id: THEIR_SESSION });
    await registerTestSession(harness, mike.apiKey, { id: "ses_mike" });
    const shared = ["src/auth/token.ts", "src/auth/session.ts"];
    const files = (values: readonly string[]) => values.map((value) => ({ kind: "file", value }));
    const opened = { createdAt: TEN_DAYS_AFTER_START };
    const kensOldTouches = contextRecords(
      THEIR_CONTEXT,
      THEIR_SESSION,
      "Orchestration worktree",
      files(Array.from({ length: LONG_LIVED_OLD_TOUCHES }, (_unused, i) => `src/old/file-${String(i)}.ts`)),
      undefined,
      opened,
    );
    for (let start = 0; start < kensOldTouches.length; start += INGEST_CHUNK) {
      await seed(harness, ken, kensOldTouches.slice(start, start + INGEST_CHUNK));
    }
    harness.clock.advanceSeconds(TEN_DAYS_S);

    // Act: today's touches.
    await seed(
      harness,
      ken,
      shared.map((value) => recordEnvelope("target", { workContextId: THEIR_CONTEXT, kind: "file", value }, { sessionId: THEIR_SESSION })),
    );
    await seed(harness, me, contextRecords(MY_CONTEXT, MY_SESSION, "Token refresh rework", files(shared), undefined, opened));
    await seed(
      harness,
      mike,
      contextRecords(
        "wc_mike_sweep",
        "ses_mike",
        "Rename the whole module",
        files([...shared, ...Array.from({ length: GHOST_MAX_CONTEXT_TARGETS + 8 }, (_unused, i) => `src/gen/file-${String(i)}.ts`)]),
        undefined,
        opened,
      ),
    );

    // Assert: Ken is in my way as a focused plan; Mike's change collides
    // too, qualified by what it touched today and ranked after Ken.
    const checks = await fetchGhostChecks(harness, me.apiKey);
    expect(LONG_LIVED_OLD_TOUCHES + shared.length).toBeGreaterThan(GHOST_MAX_CONTEXT_TARGETS);
    expect(checks.map((row) => row.workContextId)).toEqual([THEIR_CONTEXT, "wc_mike_sweep"]);
    expect(checks.map(largeChangeOf)).toEqual([null, GHOST_MAX_CONTEXT_TARGETS + 8 + shared.length]);
  });

  test("my own long-lived context is compared newest touch first", async () => {
    // Arrange: MY context touched more files ten days ago than the probe
    // holds — spelled to sort before the two I touch today — and Ken is in
    // those two now. My old values must not spend the probe my live ones need.
    const { harness, me, them } = await setup();
    const shared = ["src/auth/token.ts", "src/auth/session.ts"];
    const files = (values: readonly string[]) => values.map((value) => ({ kind: "file", value }));
    const opened = { createdAt: TEN_DAYS_AFTER_START };
    const myOldTouches = contextRecords(
      MY_CONTEXT,
      MY_SESSION,
      "Orchestration worktree",
      files(Array.from({ length: GHOST_MAX_PROBE_VALUES + 10 }, (_unused, i) => `src/aaa-old/file-${String(i)}.ts`)),
      undefined,
      opened,
    );
    for (let start = 0; start < myOldTouches.length; start += INGEST_CHUNK) {
      await seed(harness, me, myOldTouches.slice(start, start + INGEST_CHUNK));
    }
    harness.clock.advanceSeconds(TEN_DAYS_S);

    // Act
    await seed(
      harness,
      me,
      shared.map((value) => recordEnvelope("target", { workContextId: MY_CONTEXT, kind: "file", value }, { sessionId: MY_SESSION })),
    );
    await seed(harness, them, contextRecords(THEIR_CONTEXT, THEIR_SESSION, "Session store migration", files(shared), undefined, opened));

    // Assert
    expect((await fetchGhostChecks(harness, me.apiKey)).map((row) => row.workContextId)).toEqual([THEIR_CONTEXT]);
  });

  test("my own second worktree never collides with me", async () => {
    const { harness, me, them } = await setup();
    const plan = [
      { kind: "file", value: "src/auth/token.ts" },
      { kind: "file", value: "src/auth/session.ts" },
    ];
    const secondSession = "ses_mine_two";
    await registerTestSession(harness, me.apiKey, { id: secondSession });
    await seed(
      harness,
      me,
      contextRecords(MY_CONTEXT, MY_SESSION, "Token refresh rework", plan),
    );
    await seed(
      harness,
      me,
      contextRecords("wc_mine_two", secondSession, "Same work, other tree", plan),
    );
    expect(await fetchGhostChecks(harness, me.apiKey)).toEqual([]);

    // The control, and it is the whole test: the IDENTICAL arrangement under
    // a teammate's name is a notice. What silences the pair above is whose
    // context it is, not the shape of the data.
    await seed(
      harness,
      them,
      contextRecords(THEIR_CONTEXT, THEIR_SESSION, "Same work, their tree", plan),
    );
    expect(
      (await fetchGhostChecks(harness, me.apiKey)).map(
        (row) => row.workContextId,
      ),
    ).toEqual([THEIR_CONTEXT]);
  });

  test("two plans sharing no file still collide through the intent", async () => {
    const { harness, me, them } = await setup();
    await seed(
      harness,
      me,
      contextRecords(
        MY_CONTEXT,
        MY_SESSION,
        "Unrelated title",
        [{ kind: "file", value: "src/mine-only.ts" }],
        declaredIntent("Rework the webhook signature verification retries"),
      ),
    );
    await seed(
      harness,
      them,
      contextRecords(
        THEIR_CONTEXT,
        THEIR_SESSION,
        "Webhook signature verification rejects retries",
        [{ kind: "file", value: "src/theirs-only.ts" }],
      ),
    );
    const checks = await fetchGhostChecks(harness, me.apiKey);
    expect(checks.length).toBe(1);
    expect(checks[0]?.workContextId).toBe(THEIR_CONTEXT);
    expect(checks[0]?.sharedTargetCount).toBe(0);
    expect(checks[0]?.intentTokenHits).toBeGreaterThanOrEqual(3);
  });

  test("a teammate's topic never matches a teammate — only mine does", async () => {
    const { harness, me, them } = await setup();
    // I state nothing. Two teammates share a topic with each other; that is
    // their business, and nothing may appear in my answer because of it.
    await seed(
      harness,
      me,
      contextRecords(MY_CONTEXT, MY_SESSION, "Unrelated title", [
        { kind: "file", value: "src/mine-only.ts" },
      ]),
    );
    const third = await addTestDeveloperWithSession(
      harness,
      "Mike",
      "mike@example.com",
      { id: "ses_third" },
    );
    await seed(
      harness,
      them,
      contextRecords(
        THEIR_CONTEXT,
        THEIR_SESSION,
        "Webhook signature verification rejects retries",
        [],
        declaredIntent("Rework the webhook signature verification retries"),
      ),
    );
    await seed(
      harness,
      third,
      contextRecords(
        "wc_third",
        "ses_third",
        "Webhook signature verification retries again",
        [],
        declaredIntent("Rework the webhook signature verification retries"),
      ),
    );
    expect(await fetchGhostChecks(harness, me.apiKey)).toEqual([]);

    // The control: the same two teammate contexts, unchanged, become notices
    // the moment I state that topic myself. The tier reads MY sentence and
    // nobody else's, which is why the silence above is a rule rather than an
    // empty hub.
    await seed(harness, me, [
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          id: MY_CONTEXT,
          sessionId: MY_SESSION,
          title: "Unrelated title",
          description: undefined,
          createdAt: TEST_START_ISO,
          intent: declaredIntent(
            "Rework the webhook signature verification retries",
          ),
        }),
        { sessionId: MY_SESSION },
      ),
    ]);
    expect(
      (await fetchGhostChecks(harness, me.apiKey))
        .map((row) => row.workContextId)
        .sort(),
    ).toEqual([THEIR_CONTEXT, "wc_third"].sort());
  });

  test("my own sweep never silences my other worktree's plan", async () => {
    const { harness, me, them } = await setup();
    const plan = [
      { kind: "file", value: "src/auth/token.ts" },
      { kind: "file", value: "src/auth/session.ts" },
    ];
    // My REAL plan, in its own worktree, and the teammate who shares it.
    const planSession = "ses_mine_plan";
    await registerTestSession(harness, me.apiKey, { id: planSession });
    await seed(
      harness,
      me,
      contextRecords("wc_mine_b_plan", planSession, "Token refresh rework", plan),
    );
    await seed(
      harness,
      them,
      contextRecords(THEIR_CONTEXT, THEIR_SESSION, "Session store migration", plan),
    );
    // The control FIRST: without the rename this is a notice, so a silence
    // below could only be the rename's doing.
    expect(
      (await fetchGhostChecks(harness, me.apiKey)).map((row) => row.workContextId),
    ).toEqual([THEIR_CONTEXT]);

    // Now the other worktree does a mass rename, a minute later — every one
    // of its values newer than my plan's. It is compared like any context of
    // mine, but it must not take my other context's share of the probe,
    // which is what a probe ranked across my contexts would do.
    harness.clock.advanceSeconds(60);
    const sweep = contextRecords(
      "wc_mine_a_sweep",
      MY_SESSION,
      "Rename the whole module",
      Array.from({ length: OWN_SWEEP_TARGETS }, (_unused, index) => ({
        kind: "file",
        value: `src/generated/mine-${String(index)}.ts`,
      })),
    );
    // MAX_INGEST_BATCH is 100, and this sweep is deliberately larger than one
    // batch — the same shape a real rename arrives in.
    for (let at = 0; at < sweep.length; at += INGEST_CHUNK) {
      await seed(harness, me, sweep.slice(at, at + INGEST_CHUNK));
    }
    expect(OWN_SWEEP_TARGETS).toBeGreaterThan(GHOST_MAX_PROBE_VALUES);
    const after = await fetchGhostChecks(harness, me.apiKey);
    expect(after.map((row) => row.workContextId)).toEqual([THEIR_CONTEXT]);
    expect(after[0]?.sharedTargetCount).toBe(2);
  });

  test("a crowd of warm values never empties the pair window", async () => {
    const { harness, me, them } = await setup();
    // The crowd is WARM, not hot: each value is carried by CROWD_SHARERS
    // foreign contexts plus mine, well under GHOST_HOT_TARGET_MAX_CONTEXTS,
    // so no exclusion touches it. None of these contexts can ever be a
    // finding either — one shared value is below GHOST_MIN_SHARED_TARGETS.
    // What they do is fill the pair window ahead of Ken, because the window
    // is spent value-alphabetically and "src/crowd-*" sorts before "src/z*".
    const crowdValues = Array.from(
      { length: CROWD_VALUES },
      (_unused, index) => `src/crowd-${String(index).padStart(3, "0")}.ts`,
    );
    const plan = ["src/z0-token.ts", "src/z1-session.ts"];
    await seed(
      harness,
      me,
      contextRecords(
        MY_CONTEXT,
        MY_SESSION,
        "Token refresh rework",
        [...crowdValues, ...plan].map((value) => ({ kind: "file", value })),
      ),
    );
    await seed(
      harness,
      them,
      contextRecords(
        THEIR_CONTEXT,
        THEIR_SESSION,
        "Session store migration",
        plan.map((value) => ({ kind: "file", value })),
      ),
    );
    // The control FIRST: with no crowd Ken is a notice, so the silence below
    // can only be the crowd's doing.
    expect(
      (await fetchGhostChecks(harness, me.apiKey)).map((row) => row.workContextId),
    ).toEqual([THEIR_CONTEXT]);

    const crowdSession = "ses_crowd";
    await registerTestSession(harness, them.apiKey, { id: crowdSession });
    const crowd = crowdValues.flatMap((value, valueIndex) =>
      Array.from({ length: CROWD_SHARERS }, (_unused, sharer) =>
        contextRecords(
          `wc_crowd_${String(valueIndex)}_${String(sharer)}`,
          crowdSession,
          `Unrelated work ${String(valueIndex)}.${String(sharer)}`,
          [{ kind: "file", value }],
        ),
      ).flat(),
    );
    for (let at = 0; at < crowd.length; at += INGEST_CHUNK) {
      await seed(harness, them, crowd.slice(at, at + INGEST_CHUNK));
    }
    expect(CROWD_VALUES * CROWD_SHARERS).toBeGreaterThan(400);
    expect(CROWD_SHARERS + 1).toBeLessThan(GHOST_HOT_TARGET_MAX_CONTEXTS);

    const after = await fetchGhostChecks(harness, me.apiKey);
    // Ken still shares both of my files, and no crowd context ever qualifies.
    expect(after.map((row) => row.workContextId)).toEqual([THEIR_CONTEXT]);
    expect(after[0]?.sharedTargetCount).toBe(2);
  });

  test("an ended session and a merged context are not live work", async () => {
    const { harness, me, them } = await setup();
    const plan = [
      { kind: "file", value: "src/auth/token.ts" },
      { kind: "file", value: "src/auth/session.ts" },
    ];
    await seed(
      harness,
      me,
      contextRecords(MY_CONTEXT, MY_SESSION, "Token refresh rework", plan),
    );
    await seed(
      harness,
      them,
      contextRecords(THEIR_CONTEXT, THEIR_SESSION, "Session store migration", plan),
    );
    // The control: inside the activity window this IS a notice, so each
    // silence below is one predicate's doing and not an empty hub.
    expect(
      (await fetchGhostChecks(harness, me.apiKey)).map((row) => row.workContextId),
    ).toEqual([THEIR_CONTEXT]);

    // Ken stopped working. The context is still inside
    // GHOST_ACTIVE_WINDOW_DAYS, and a finished session is not a collision.
    await harness.db
      .update(agentSessions)
      .set({ endedAt: new Date(), status: "done" })
      .where(eq(agentSessions.id, THEIR_SESSION));
    expect(await fetchGhostChecks(harness, me.apiKey)).toEqual([]);

    // Ken is working again, but on a branch that already landed on the
    // default branch. Merged work cannot collide with anything either.
    await harness.db
      .update(agentSessions)
      .set({ endedAt: null, status: VALID_SESSION_BODY.status })
      .where(eq(agentSessions.id, THEIR_SESSION));
    expect(
      (await fetchGhostChecks(harness, me.apiKey)).map((row) => row.workContextId),
    ).toEqual([THEIR_CONTEXT]);
    await harness.db
      .update(workContexts)
      .set({ landedAt: new Date() })
      .where(eq(workContexts.id, THEIR_CONTEXT));
    expect(await fetchGhostChecks(harness, me.apiKey)).toEqual([]);

    // The same rule on MY side: a plan of mine that already landed is not a
    // plan anybody can still collide with, so it drives no comparison.
    await harness.db
      .update(workContexts)
      .set({ landedAt: null })
      .where(eq(workContexts.id, THEIR_CONTEXT));
    await harness.db
      .update(workContexts)
      .set({ landedAt: new Date() })
      .where(eq(workContexts.id, MY_CONTEXT));
    expect(await fetchGhostChecks(harness, me.apiKey)).toEqual([]);
  });

  test("a stale detached base a teammate reported landed is still a collision", async () => {
    // Arrange: the pilot incident. Ken's long-lived session sits detached at
    // a six-week-old main commit while its work goes on; I am on a feature
    // branch and my SessionStart reports Ken's base as an ancestor of main.
    const harness = await createTestHarness();
    const me = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const them = await createTestDeveloper(harness, "Ken", "ken@example.com");
    await registerTestSession(harness, me.apiKey, { id: MY_SESSION, baseOnDefault: false });
    await registerTestSession(harness, them.apiKey, {
      id: THEIR_SESSION,
      branch: `detached@${STALE_DETACHED_BASE.slice(0, 9)}`,
      baseCommit: STALE_DETACHED_BASE,
    });
    const plan = [
      { kind: "file", value: "src/auth/token.ts" },
      { kind: "file", value: "src/auth/session.ts" },
    ];
    await seed(harness, me, contextRecords(MY_CONTEXT, MY_SESSION, "Token refresh rework", plan));
    await seed(harness, them, contextRecords(THEIR_CONTEXT, THEIR_SESSION, "Session store migration", plan));

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

    // Assert: Ken's files are still in my way.
    expect(
      (await fetchGhostChecks(harness, me.apiKey)).map((row) => row.workContextId),
    ).toEqual([THEIR_CONTEXT]);
  });

  test("a teammate's base that reached main after they registered is landed, and out", async () => {
    // Arrange: the lane still works — Ken's connector said his base was NOT
    // on main when his session started, and now it is.
    const harness = await createTestHarness();
    const me = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const them = await createTestDeveloper(harness, "Ken", "ken@example.com");
    await registerTestSession(harness, me.apiKey, { id: MY_SESSION, baseOnDefault: false });
    await registerTestSession(harness, them.apiKey, {
      id: THEIR_SESSION,
      branch: "feat/session-store",
      baseCommit: STALE_DETACHED_BASE,
      baseOnDefault: false,
    });
    const plan = [
      { kind: "file", value: "src/auth/token.ts" },
      { kind: "file", value: "src/auth/session.ts" },
    ];
    await seed(harness, me, contextRecords(MY_CONTEXT, MY_SESSION, "Token refresh rework", plan));
    await seed(harness, them, contextRecords(THEIR_CONTEXT, THEIR_SESSION, "Session store migration", plan));

    // Act
    await seed(harness, me, [
      recordEnvelope(
        "landed_evidence",
        { repo: REPO, defaultBranch: "origin/main", checkedAt: TEST_START_ISO, commits: [STALE_DETACHED_BASE] },
        { sessionId: MY_SESSION },
      ),
    ]);

    // Assert: merged work collides with nothing.
    expect(await fetchGhostChecks(harness, me.apiKey)).toEqual([]);
  });

  test("one teammate's worktrees never hold the whole block", async () => {
    const { harness, me, them } = await setup();
    const mine = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
    await seed(
      harness,
      me,
      contextRecords(
        MY_CONTEXT,
        MY_SESSION,
        "Token refresh rework",
        mine.map((value) => ({ kind: "file", value })),
      ),
    );
    // Ken runs three worktrees, each sharing THREE of my files — so each of
    // them outranks Mike, and by context count alone they fill every slot.
    for (let index = 0; index < 3; index += 1) {
      const sessionId = `ses_ken_${String(index)}`;
      await registerTestSession(harness, them.apiKey, { id: sessionId });
      await seed(
        harness,
        them,
        contextRecords(
          `wc_ken_${String(index)}`,
          sessionId,
          `Session store migration ${String(index)}`,
          mine.slice(0, 3).map((value) => ({ kind: "file", value })),
        ),
      );
    }
    const mike = await addTestDeveloperWithSession(
      harness,
      "Mike",
      "mike@example.com",
      { id: "ses_mike" },
    );
    await seed(
      harness,
      mike,
      contextRecords(
        "wc_mike",
        "ses_mike",
        "Retry budget rework",
        mine.slice(2).map((value) => ({ kind: "file", value })),
      ),
    );

    const checks = await fetchGhostChecks(harness, me.apiKey);
    const names = checks.map((row) => row.developerName);
    // Mike is in my way too, and one voice must not hold the block against
    // everybody else — the rule MAX_QUESTION_POINTERS states for questions.
    expect(names).toContain("Mike");
    expect(names.filter((name) => name === "Ken").length).toBe(1);
    // Ken keeps his STRONGEST context, not an arbitrary one.
    expect(
      checks.find((row) => row.developerName === "Ken")?.sharedTargetCount,
    ).toBe(3);
  });

  test("the hot bar counts only teammates I could be told about", async () => {
    // One over the bar once the reader's own context and Ken's are added, so
    // every mode below is exactly at the threshold and nothing else moves.
    const extras = GHOST_HOT_TARGET_MAX_CONTEXTS - 1;
    const plan = [
      { kind: "file", value: "src/a.ts" },
      { kind: "file", value: "src/b.ts" },
    ];
    for (const mode of ["mine", "muted", "opted out"] as const) {
      const { harness, me, them } = await setup();
      await seed(
        harness,
        me,
        contextRecords(MY_CONTEXT, MY_SESSION, "Token refresh rework", plan),
      );
      await seed(
        harness,
        them,
        contextRecords(THEIR_CONTEXT, THEIR_SESSION, "Session store migration", plan),
      );
      // The control, per mode: Ken is a notice before the extra carriers
      // exist, so his disappearance can only be the rarity count's doing.
      expect(
        (await fetchGhostChecks(harness, me.apiKey)).map(
          (row) => row.workContextId,
        ),
      ).toEqual([THEIR_CONTEXT]);

      const carrierSession = `ses_carriers_${mode.replace(" ", "_")}`;
      const carrier =
        mode === "mine"
          ? me
          : await addTestDeveloperWithSession(harness, "Mike", "mike@example.com", {
              id: carrierSession,
            });
      if (mode === "mine") {
        await registerTestSession(harness, me.apiKey, { id: carrierSession });
      }
      const carriers = Array.from({ length: extras }, (_unused, index) =>
        contextRecords(
          `wc_carrier_${String(index)}`,
          carrierSession,
          `Other worktree ${String(index)}`,
          plan,
        ),
      ).flat();
      for (let at = 0; at < carriers.length; at += INGEST_CHUNK) {
        await seed(harness, carrier, carriers.slice(at, at + INGEST_CHUNK));
      }
      if (mode === "muted") {
        const muted = await harness.app.request(
          "/api/settings/mutes",
          jsonRequest("POST", me.apiKey, { developer: carrier.developerId }),
        );
        expect(muted.status).toBe(200);
      }
      if (mode === "opted out") {
        const optedOut = await harness.app.request(
          "/api/settings/presence",
          jsonRequest("PUT", carrier.apiKey, { optOut: true }),
        );
        expect(optedOut.status).toBe(200);
      }
      expect(extras + 2).toBeGreaterThan(GHOST_HOT_TARGET_MAX_CONTEXTS);

      // Contexts the reader can NEVER be shown — their own worktrees, a
      // developer they muted, a developer who opted out of presence — must
      // not spend the rarity budget for a value. Otherwise an invisible
      // developer decides what the reader sees, which inverts both controls.
      expect(
        (await fetchGhostChecks(harness, me.apiKey)).map(
          (row) => row.workContextId,
        ),
      ).toEqual([THEIR_CONTEXT]);
    }
  });

  test("a big implementation still collides through the intent", async () => {
    const { harness, me, them } = await setup();
    await seed(
      harness,
      me,
      contextRecords(
        MY_CONTEXT,
        MY_SESSION,
        "Unrelated title",
        [{ kind: "file", value: "src/mine-only.ts" }],
        declaredIntent("Rework the webhook signature verification retries"),
      ),
    );
    // Their context is over GHOST_MAX_CONTEXT_TARGETS — a sixty-file
    // implementation session, which is ordinary work and not a rename. The
    // large-change qualifier is an argument about SHARING A FILE with somebody
    // who shares files with everybody; this tier shares no file at all, so
    // the row is neither qualified nor ranked down for its size.
    const theirs = contextRecords(
      THEIR_CONTEXT,
      THEIR_SESSION,
      "Webhook signature verification rejects retries",
      Array.from(
        { length: GHOST_MAX_CONTEXT_TARGETS + 1 },
        (_unused, index) => ({
          kind: "file",
          value: `src/theirs-${String(index)}.ts`,
        }),
      ),
    );
    for (let at = 0; at < theirs.length; at += INGEST_CHUNK) {
      await seed(harness, them, theirs.slice(at, at + INGEST_CHUNK));
    }

    const checks = await fetchGhostChecks(harness, me.apiKey);
    expect(checks.map((row) => row.workContextId)).toEqual([THEIR_CONTEXT]);
    expect(checks[0]?.sharedTargetCount).toBe(0);
    expect(checks[0]?.intentTokenHits).toBeGreaterThanOrEqual(3);
    expect(largeChangeOf(checks[0])).toBeNull();
  });

  test("a muted teammate's plan is not reported to me", async () => {
    const { harness, me, them } = await setup();
    await seed(
      harness,
      me,
      contextRecords(MY_CONTEXT, MY_SESSION, "Token refresh rework", [
        { kind: "file", value: "src/auth/token.ts" },
        { kind: "file", value: "src/auth/session.ts" },
      ]),
    );
    await seed(
      harness,
      them,
      contextRecords(THEIR_CONTEXT, THEIR_SESSION, "Session store migration", [
        { kind: "file", value: "src/auth/token.ts" },
        { kind: "file", value: "src/auth/session.ts" },
      ]),
    );
    expect((await fetchGhostChecks(harness, me.apiKey)).length).toBe(1);

    const muted = await harness.app.request(
      "/api/settings/mutes",
      jsonRequest("POST", me.apiKey, { developer: them.developerId }),
    );
    expect(muted.status).toBe(200);
    expect(await fetchGhostChecks(harness, me.apiKey)).toEqual([]);
  });
});

/**
 * A GHOST ROW SAYS WHERE THE TEAMMATE WORKS ON IT (release gate, 1b): a
 * topic's own branch — where that work lives — and its session's only when
 * the context has none. The session's branch of a long detached session is
 * the stale checkout it started in, which the person must never be told.
 */
describe("a ghost row names the branch its work context is on", () => {
  const PLAN = [
    { kind: "file", value: "src/practice/mapping.ts" },
    { kind: "file", value: "src/practice/columns.ts" },
  ];

  test("a topic's row names the topic's branch, not its session's", async () => {
    // Arrange
    const { harness, me, them } = await setup();
    await seed(harness, me, contextRecords(MY_CONTEXT, MY_SESSION, "Mine", PLAN));
    await seed(harness, them, contextRecords(THEIR_CONTEXT, THEIR_SESSION, "Theirs", PLAN, undefined, { branch: "feat/numlabs-practices" }));

    // Act
    const rows = await fetchGhostChecks(harness, me.apiKey);

    // Assert
    expect(rows.map((row) => [row.workContextId, row.branch])).toEqual([[THEIR_CONTEXT, "feat/numlabs-practices"]]);
  });

  test("a context with no branch of its own names its session's", async () => {
    // Arrange
    const { harness, me, them } = await setup();
    await seed(harness, me, contextRecords(MY_CONTEXT, MY_SESSION, "Mine", PLAN));
    await seed(harness, them, contextRecords(THEIR_CONTEXT, THEIR_SESSION, "Theirs", PLAN));

    // Act
    const rows = await fetchGhostChecks(harness, me.apiKey);

    // Assert
    expect(rows.map((row) => [row.workContextId, row.branch])).toEqual([[THEIR_CONTEXT, VALID_SESSION_BODY.branch]]);
  });
});
