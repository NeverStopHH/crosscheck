/**
 * GET /api/ghost-checks — the deterministic half of ghost commits
 * (VISION.md §3): whose LIVE plan overlaps mine, and on what.
 *
 * Every test here is really about the FLOOR and the two exclusions, because
 * that is the whole difference between a warning system people keep and one
 * they turn off. ConE — the only deployed concurrent-edit detector with
 * published numbers (Muşlu, Nagappan et al., TOSEM 2021: 775 notifications
 * over 26 000 pull requests, 71.5 % rated useful) — spends most of its design
 * on exactly this: how much overlap is enough, and which files must never
 * count. So: one shared file is not a plan, one shared FAILURE is; a lockfile
 * everybody touches is nothing; a fifty-file sweep collides with everybody
 * and is therefore excluded from both sides.
 */
import { describe, expect, test } from "bun:test";

import {
  GHOST_HOT_TARGET_MAX_CONTEXTS,
  GHOST_MAX_CONTEXT_TARGETS,
} from "../src/constants.ts";
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
    const neighbourSession = "ses_neighbour";
    await registerTestSession(harness, them.apiKey, { id: neighbourSession });
    await seed(
      harness,
      them,
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
