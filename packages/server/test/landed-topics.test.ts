/**
 * A TOPIC LANDS BY ITS OWN EVIDENCE, NEVER ITS SESSION'S (topic review C1).
 *
 * One long-lived session works in a dozen sibling worktrees, one TOPIC work
 * context per (repo, worktree, branch), each naming its own branch and the
 * commit HEAD named at its first touch (DESIGN.md "One session, many
 * topics"). The hub stamped `landed_at` on every context of a session whose
 * base a teammate reported, so one report naming the session's base took
 * every topic of that session out of the ghost checks and the conference at
 * once, mid-work, in other worktrees on other branches — the 11-file-overlap
 * pilot failure, rebuilt through topics.
 *
 * Pinned here: a session's base lands only the session's OWN context; a
 * topic is judged by the false-landed-stamp rules on its own facts — its
 * branch (detached and default never land), the connector's word about its
 * own base (`baseOnDefault`), and, for a topic without a word, the dated
 * fallback against when the TOPIC took its base.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { LANDED_UNFLAGGED_FALLBACK_ENDS_AT } from "../src/constants.ts";
import { workContexts } from "../src/db/schema.ts";
import { listLandedContexts, planLandedRepair } from "../src/services/landed-repair.ts";
import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  TEST_START_ISO,
  validWorkContextBody,
  VALID_SESSION_BODY,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
const SESSION_ID = VALID_SESSION_BODY.id;
/** The start checkout's base: the session's own new work. */
const SESSION_BASE = "5e5510b5e5510b5e5510b5e5510b5e5510b5e551";
const TOPIC_A = `${WORK_CONTEXT_ID}~t0a1b2c3d4e5f.1`;
const TOPIC_B = `${WORK_CONTEXT_ID}~tf5e4d3c2b1a0.2`;
const BASE_A = "a".repeat(40);
const BASE_B = "b".repeat(40);
const KEN_CONTEXT = "wc_ken";
const KEN_SESSION = "ses_ken";
/** An hour before the contexts opened. */
const FRESH_COMMITTED_AT = "2026-07-24T08:00:00.000Z";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MS_PER_SECOND = 1000;
const T0_MS = Date.parse(TEST_START_ISO);
const isoAt = (ms: number): string => new Date(T0_MS + ms).toISOString();
const SHARED = ["src/cache.ts", "src/cache-keys.ts"] as const;

interface TopicSeed {
  readonly id: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly baseOnDefault?: boolean;
  readonly createdAt?: string;
}

interface World {
  readonly harness: TestHarness;
  readonly nick: TestDeveloper;
  readonly ken: TestDeveloper;
}

/** Nick's session on a feature branch whose base is new work, Ken beside him on his own. */
const world = async (): Promise<World> => {
  const { harness, developer: nick } = await createHarnessWithSession({
    branch: "feat/start",
    baseCommit: SESSION_BASE,
    baseOnDefault: false,
  });
  const ken = await addTestDeveloperWithSession(harness, "Ken", "ken@example.com", {
    id: KEN_SESSION,
    branch: "feat/ken-cache",
    baseCommit: "c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff",
    baseOnDefault: false,
  });
  return { harness, nick, ken };
};

const topicRecord = (seed: TopicSeed): Record<string, unknown> =>
  recordEnvelope(
    "work_context",
    validWorkContextBody({
      id: seed.id,
      title: `${seed.branch} @ api`,
      titleSource: "fallback",
      status: "implementing",
      branch: seed.branch,
      baseCommit: seed.baseCommit,
      ...(seed.baseOnDefault === undefined ? {} : { baseOnDefault: seed.baseOnDefault }),
      ...(seed.createdAt === undefined ? {} : { createdAt: seed.createdAt }),
    }),
  );

const fileTarget = (workContextId: string, value: string, sessionId: string = SESSION_ID): Record<string, unknown> =>
  recordEnvelope("target", { workContextId, kind: "file", value }, { sessionId });

/** Each topic's files: the two Ken edits too, and one of its own. */
const topicFiles = (seed: TopicSeed): readonly string[] => [...SHARED, `src/${seed.id.slice(-1)}.ts`];

/** The session's own context, then each topic ahead of its targets — the connector's order. */
const seedNick = async (w: World, topics: readonly TopicSeed[]): Promise<void> => {
  const records = [
    recordEnvelope("work_context", validWorkContextBody()),
    ...topics.flatMap((seed) => [topicRecord(seed), ...topicFiles(seed).map((path) => fileTarget(seed.id, path))]),
  ];
  const posted = await postRecords(w.harness, w.nick, { records });
  expect(posted.data?.accepted).toBe(records.length);
};

/** Ken's live context, editing the two files every topic edits. */
const seedKen = async (w: World): Promise<void> => {
  const posted = await postRecords(w.harness, w.ken, {
    records: [
      recordEnvelope(
        "work_context",
        validWorkContextBody({ id: KEN_CONTEXT, sessionId: KEN_SESSION, title: "Cache keys per tenant" }),
        { sessionId: KEN_SESSION },
      ),
      ...SHARED.map((path) => fileTarget(KEN_CONTEXT, path, KEN_SESSION)),
    ],
  });
  expect(posted.data?.accepted).toBe(1 + SHARED.length);
};

/** Ken's SessionStart probe: these commits are on the default branch, dated. */
const kenReports = async (w: World, commits: readonly string[], committedAt: string = FRESH_COMMITTED_AT): Promise<void> => {
  const posted = await postRecords(w.harness, w.ken, {
    records: [
      recordEnvelope(
        "landed_evidence",
        {
          repo: REPO,
          defaultBranch: "origin/main",
          checkedAt: TEST_START_ISO,
          commits,
          commitDates: commits.map((sha) => ({ sha, committedAt })),
        },
        { sessionId: KEN_SESSION },
      ),
    ],
  });
  expect(posted.data?.accepted).toBe(1);
};

const landedAt = async (w: World, id: string): Promise<Date | null | undefined> =>
  (await w.harness.db.select({ landedAt: workContexts.landedAt }).from(workContexts).where(eq(workContexts.id, id)))[0]
    ?.landedAt;

const kensGhostChecks = async (w: World): Promise<readonly string[]> => {
  const response = await w.harness.app.request(
    `/api/ghost-checks?repo=${encodeURIComponent(REPO)}`,
    jsonRequest("GET", w.ken.apiKey),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { ghostChecks: readonly { workContextId: string }[] } };
  return body.data.ghostChecks.map((row) => row.workContextId);
};

describe("a report naming the session's base", () => {
  test("lands the session's own context and none of its topics — Ken still sees topic A", async () => {
    // Arrange: probe L1 of the topic review, on a session whose base IS new
    // work — so the session's own context may land, and nothing else may.
    const w = await world();
    await seedNick(w, [
      { id: TOPIC_A, branch: "feat/topic-a", baseCommit: BASE_A, baseOnDefault: false },
      { id: TOPIC_B, branch: "feat/topic-b", baseCommit: BASE_B, baseOnDefault: false },
    ]);
    await seedKen(w);
    expect(await kensGhostChecks(w)).toContain(TOPIC_A);

    // Act
    await kenReports(w, [SESSION_BASE]);

    // Assert
    expect(await landedAt(w, WORK_CONTEXT_ID)).toEqual(new Date(TEST_START_ISO));
    expect(await landedAt(w, TOPIC_A)).toBeNull();
    expect(await landedAt(w, TOPIC_B)).toBeNull();
    expect(await kensGhostChecks(w)).toContain(TOPIC_A);
  });

  test("never lands a topic that carries no base of its own", async () => {
    // Arrange: a topic record without a base commit (a HEAD that could not be
    // read at the first touch). Drift falls back to the session's base for
    // it; landing must not.
    const w = await world();
    const records = [
      recordEnvelope("work_context", validWorkContextBody()),
      recordEnvelope(
        "work_context",
        validWorkContextBody({ id: TOPIC_A, title: "feat/topic-a @ api", titleSource: "fallback", branch: "feat/topic-a" }),
      ),
    ];
    const posted = await postRecords(w.harness, w.nick, { records });
    expect(posted.data?.accepted).toBe(records.length);

    // Act
    await kenReports(w, [SESSION_BASE]);

    // Assert
    expect(await landedAt(w, TOPIC_A)).toBeNull();
  });
});

describe("a report naming a topic's own base", () => {
  test("lands that topic when its connector said the base was new work — and nothing else", async () => {
    // Arrange: probe L2 of the topic review.
    const w = await world();
    await seedNick(w, [
      { id: TOPIC_A, branch: "feat/topic-a", baseCommit: BASE_A, baseOnDefault: false },
      { id: TOPIC_B, branch: "feat/topic-b", baseCommit: BASE_B, baseOnDefault: false },
    ]);

    // Act
    await kenReports(w, [BASE_A]);

    // Assert
    expect(await landedAt(w, TOPIC_A)).toEqual(new Date(TEST_START_ISO));
    expect(await landedAt(w, TOPIC_B)).toBeNull();
    expect(await landedAt(w, WORK_CONTEXT_ID)).toBeNull();
  });

  test("never lands a topic whose base was already on the default branch — a fresh branch's base", async () => {
    // Arrange: Nick's shape — every topic a branch cut from main at its tip.
    const w = await world();
    await seedNick(w, [{ id: TOPIC_A, branch: "feat/topic-a", baseCommit: BASE_A, baseOnDefault: true }]);
    await seedKen(w);

    // Act
    await kenReports(w, [BASE_A]);

    // Assert
    expect(await landedAt(w, TOPIC_A)).toBeNull();
    expect(await kensGhostChecks(w)).toContain(TOPIC_A);
  });

  test("never lands a detached topic by its base, whatever its connector said", async () => {
    // Arrange
    const w = await world();
    await seedNick(w, [{ id: TOPIC_A, branch: "detached@aaaaaaaaa", baseCommit: BASE_A, baseOnDefault: false }]);

    // Act
    await kenReports(w, [BASE_A]);

    // Assert
    expect(await landedAt(w, TOPIC_A)).toBeNull();
  });

  test("never lands a topic on the default branch the report names", async () => {
    // Arrange: a sibling worktree on main, whose base is main's tip by construction
    const w = await world();
    await seedNick(w, [{ id: TOPIC_A, branch: "main", baseCommit: BASE_A, baseOnDefault: false }]);

    // Act
    await kenReports(w, [BASE_A]);

    // Assert
    expect(await landedAt(w, TOPIC_A)).toBeNull();
  });
});

describe("a topic whose connector gave no word about its base", () => {
  test("is dated against when the TOPIC took its base, not when its session took its own", async () => {
    // Arrange: the session took its base at T0; the topics opened three days
    // later — A on a base committed two days before that (stale for the
    // topic, though after the session took its own base), B on one an hour old.
    const w = await world();
    const topicOpenedMs = 3 * DAY_MS;
    await seedNick(w, [
      { id: TOPIC_A, branch: "feat/topic-a", baseCommit: BASE_A, createdAt: isoAt(topicOpenedMs) },
      { id: TOPIC_B, branch: "feat/topic-b", baseCommit: BASE_B, createdAt: isoAt(topicOpenedMs) },
    ]);

    // Act
    await kenReports(w, [BASE_A], isoAt(topicOpenedMs - 2 * DAY_MS));
    await kenReports(w, [BASE_B], isoAt(topicOpenedMs - HOUR_MS));

    // Assert
    expect(await landedAt(w, TOPIC_A)).toBeNull();
    expect(await landedAt(w, TOPIC_B)).toEqual(new Date(TEST_START_ISO));
  });

  test("never lands by ancestry after the fallback's end date", async () => {
    // Arrange
    const w = await world();
    await seedNick(w, [{ id: TOPIC_A, branch: "feat/topic-a", baseCommit: BASE_A }]);
    w.harness.clock.advanceSeconds((Date.parse(LANDED_UNFLAGGED_FALLBACK_ENDS_AT) - T0_MS) / MS_PER_SECOND);

    // Act
    await kenReports(w, [BASE_A], LANDED_UNFLAGGED_FALLBACK_ENDS_AT);

    // Assert
    expect(await landedAt(w, TOPIC_A)).toBeNull();
  });
});

describe("the operator's repair (services/landed-repair.ts)", () => {
  test("judges a topic's stamp on the topic's own facts, never its detached session's", async () => {
    // Arrange: Nick's real shape — the session detached at an old main commit
    // (its connector said so), a topic on its own branch whose own base is new
    // work, landed by a report of that base.
    const { harness, developer: nick } = await createHarnessWithSession({
      branch: "detached@5e5510b5e",
      baseCommit: SESSION_BASE,
      baseOnDefault: true,
    });
    const ken = await addTestDeveloperWithSession(harness, "Ken", "ken@example.com", {
      id: KEN_SESSION,
      branch: "feat/ken-cache",
      baseCommit: "c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff",
      baseOnDefault: false,
    });
    const w = { harness, nick, ken };
    await seedNick(w, [{ id: TOPIC_A, branch: "feat/topic-a", baseCommit: BASE_A, baseOnDefault: false }]);
    await kenReports(w, [BASE_A]);
    expect(await landedAt(w, TOPIC_A)).toEqual(new Date(TEST_START_ISO));

    // Act
    const plan = planLandedRepair(await listLandedContexts(harness.db, "open"), {
      defaultBranch: "main",
      namedBases: new Set([SESSION_BASE]),
      overriddenBases: new Set(),
      baseCommittedAt: null,
    });

    // Assert: the session's flag, its detached branch and its named base say nothing about the topic
    expect(plan.unland).toEqual([]);
  });
});

describe("the hub keeps a topic's word about its base", () => {
  const storedWord = async (w: World): Promise<boolean | null | undefined> =>
    (
      await w.harness.db
        .select({ baseOnDefault: workContexts.baseOnDefault })
        .from(workContexts)
        .where(eq(workContexts.id, TOPIC_A))
    )[0]?.baseOnDefault;

  test("written once with its base: a later copy never moves it, a copy about another base never fills it", async () => {
    // Arrange: a topic whose first copy said nothing
    const w = await world();
    await postRecords(w.harness, w.nick, {
      records: [topicRecord({ id: TOPIC_A, branch: "feat/topic-a", baseCommit: BASE_A })],
    });
    const unsaid = await storedWord(w);

    // Act: a copy about ANOTHER base, then one about its own, then a contrary one
    await postRecords(w.harness, w.nick, {
      records: [topicRecord({ id: TOPIC_A, branch: "feat/topic-a", baseCommit: BASE_B, baseOnDefault: false })],
    });
    const otherBase = await storedWord(w);
    await postRecords(w.harness, w.nick, {
      records: [topicRecord({ id: TOPIC_A, branch: "feat/topic-a", baseCommit: BASE_A, baseOnDefault: true })],
    });
    await postRecords(w.harness, w.nick, {
      records: [topicRecord({ id: TOPIC_A, branch: "feat/topic-a", baseCommit: BASE_A, baseOnDefault: false })],
    });

    // Assert
    expect(unsaid).toBeNull();
    expect(otherBase).toBeNull();
    expect(await storedWord(w)).toBe(true);
  });
});
