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
 * everybody touches is nothing; a fifty-file sweep collides with everybody
 * and is therefore excluded from both sides.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  GHOST_HOT_TARGET_MAX_CONTEXTS,
  GHOST_MAX_CONTEXT_TARGETS,
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
  validWorkContextBody,
  VALID_SESSION_BODY,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
const MY_SESSION = "ses_mine";
const THEIR_SESSION = "ses_theirs";
const MY_CONTEXT = "wc_mine";
const THEIR_CONTEXT = "wc_theirs";
const FINGERPRINT = "sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f0";

/**
 * Targets on the sweeping worktree of the test above: more than the whole
 * read window that two of my own contexts share, so a bound spent in id
 * order would leave the other context nothing.
 */
const OWN_SWEEP_TARGETS = 110;

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
    const lockfiles = ["package-lock.json", "bun.lock"];
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

  test("a fifty-file sweep collides with nobody", async () => {
    const { harness, me, them } = await setup();
    const shared = ["src/auth/token.ts", "src/auth/session.ts"];
    await seed(
      harness,
      me,
      contextRecords(
        MY_CONTEXT,
        MY_SESSION,
        "Token refresh rework",
        shared.map((value) => ({ kind: "file", value })),
      ),
    );
    const sweepTargets = [
      ...shared,
      ...Array.from(
        { length: GHOST_MAX_CONTEXT_TARGETS },
        (_unused, index) => `src/generated/file-${String(index)}.ts`,
      ),
    ].map((value) => ({ kind: "file", value }));
    await seed(
      harness,
      them,
      contextRecords(
        THEIR_CONTEXT,
        THEIR_SESSION,
        "Rename the whole module",
        sweepTargets,
      ),
    );
    expect(sweepTargets.length).toBeGreaterThan(GHOST_MAX_CONTEXT_TARGETS);
    expect(await fetchGhostChecks(harness, me.apiKey)).toEqual([]);

    // The control: the same two shared files on a context that is NOT a sweep
    // do produce the notice, so the exclusion is what silenced it above.
    const modestSession = "ses_modest";
    await registerTestSession(harness, them.apiKey, { id: modestSession });
    await seed(
      harness,
      them,
      contextRecords(
        "wc_modest",
        modestSession,
        "Session store migration",
        shared.map((value) => ({ kind: "file", value })),
      ),
    );
    const checks = await fetchGhostChecks(harness, me.apiKey);
    expect(checks.map((row) => row.workContextId)).toEqual(["wc_modest"]);
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
    // The control FIRST: without the sweep this is a notice, so the silence
    // below can only be the sweep's doing.
    expect(
      (await fetchGhostChecks(harness, me.apiKey)).map((row) => row.workContextId),
    ).toEqual([THEIR_CONTEXT]);

    // Now the other worktree does a mass rename. It is a sweep and must
    // contribute nothing — but it must not take my other context's targets
    // with it, which is what a read bound spent id-first would do.
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
    expect(OWN_SWEEP_TARGETS).toBeGreaterThan(GHOST_MAX_CONTEXT_TARGETS);
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
